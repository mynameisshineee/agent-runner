#!/usr/bin/env bun
/**
 * MCP-first Agent Listener (terminal-first)
 *
 * Primary mode (when control plane vars are configured):
 * - Claims jobs from control plane
 * - Executes on local visible TTY
 * - Reports start/complete lifecycle
 * - Honors cancel control signals
 *
 * Fallback mode:
 * - Direct MCP SSE + poll fallback for task assignment
 */

import {
  buildTaskPrompt,
  cleanupWorkdir,
  createRuntimeWorkdir,
  isValidAgentId,
  log,
  logErr,
  mcpToolCall,
  spawnRuntime,
  terminateChildProcess,
  type RuntimeType,
  type RuntimeContext,
  type TaskLike,
} from "./mcp-runtime";
import {
  buildSessionIdentity,
  resolveControlPlaneClient,
  runHeartbeatLoop,
  type ClaimedControlJob,
  type ControlPlaneClient,
  type SessionIdentity,
} from "./control-plane";

type ListenMode = "auto" | "sse" | "poll";

const AGENT_ID = process.env.BIK_AGENT_ID ?? process.env.AGENT_ID ?? "";
const AGENT_TOKEN = process.env.BIK_AGENT_TOKEN ?? process.env.AGENT_MCP_TOKEN ?? "";
const MCP_URL = process.env.BIK_MCP_URL ?? process.env.MCP_SERVER_URL ?? "https://devapi.biklabs.ai/v1/mcp";
const WORK_DIR = process.env.BIK_WORK_DIR ?? process.cwd();
const MODE = (process.env.BIK_LISTEN_MODE ?? "auto") as ListenMode;
const RUNTIME_TYPE = (process.env.BIK_RUNTIME_TYPE ?? "claude_code") as RuntimeType;
const POLL_INTERVAL_MS = parseInt(process.env.BIK_POLL_INTERVAL_MS ?? "10000", 10);
const RECONNECT_MS = parseInt(process.env.BIK_RECONNECT_MS ?? "3000", 10);
const MAX_TURNS = parseInt(process.env.BIK_MAX_TURNS ?? "20", 10);
const COMMENT_ON_START = (process.env.BIK_COMMENT_ON_START ?? "true") !== "false";
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.BIK_HEARTBEAT_INTERVAL_MS ?? "10000", 10);
const CLAIM_INTERVAL_MS = parseInt(process.env.BIK_CLAIM_INTERVAL_MS ?? "2000", 10);
const CONTROL_CANCEL_POLL_MS = parseInt(process.env.BIK_CONTROL_CANCEL_POLL_MS ?? "1500", 10);

if (!AGENT_ID) throw new Error("BIK_AGENT_ID (or AGENT_ID) is required");
if (!AGENT_TOKEN) throw new Error("BIK_AGENT_TOKEN (or AGENT_MCP_TOKEN) is required");
if (!isValidAgentId(AGENT_ID)) {
  throw new Error("BIK_AGENT_ID format is invalid");
}
if (!["auto", "sse", "poll"].includes(MODE)) {
  throw new Error("BIK_LISTEN_MODE must be one of: auto | sse | poll");
}
if (!["claude_code", "codex", "cursor", "opencode", "kiro", "openclaw", "chat"].includes(RUNTIME_TYPE)) {
  throw new Error("BIK_RUNTIME_TYPE must be one of: claude_code | codex | cursor | opencode | kiro | openclaw | chat");
}
if (!Number.isFinite(HEARTBEAT_INTERVAL_MS) || HEARTBEAT_INTERVAL_MS < 1000) {
  throw new Error("BIK_HEARTBEAT_INTERVAL_MS must be >= 1000");
}
if (!Number.isFinite(CLAIM_INTERVAL_MS) || CLAIM_INTERVAL_MS < 250) {
  throw new Error("BIK_CLAIM_INTERVAL_MS must be >= 250");
}
if (!Number.isFinite(CONTROL_CANCEL_POLL_MS) || CONTROL_CANCEL_POLL_MS < 250) {
  throw new Error("BIK_CONTROL_CANCEL_POLL_MS must be >= 250");
}

const runtimeCtx: RuntimeContext = {
  runtimeType: RUNTIME_TYPE,
  mcpUrl: MCP_URL,
  agentToken: AGENT_TOKEN,
  agentId: AGENT_ID,
  workDir: WORK_DIR,
  maxTurns: MAX_TURNS,
};

const directProcessedTaskIds = new Set<string>();
const directQueuedTasks = new Map<string, TaskLike>();
let processingDirectQueue = false;

interface ExecutionBinding {
  control: ControlPlaneClient;
  session: SessionIdentity;
  jobId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskFromClaim(job: ClaimedControlJob): TaskLike {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  return {
    id: job.taskId,
    project_id: job.projectId,
    title: job.taskTitle ?? (typeof payload.taskTitle === "string" ? payload.taskTitle : undefined),
    task_type: job.taskType ?? (typeof payload.taskType === "string" ? payload.taskType : undefined),
    priority: typeof payload.priority === "string" ? payload.priority : undefined,
  };
}

async function readTaskDetail(taskId: string): Promise<Record<string, unknown>> {
  const out = await mcpToolCall(MCP_URL, AGENT_TOKEN, "read_task", {
    work_item_id: taskId,
  });
  return (out && typeof out === "object" ? (out as Record<string, unknown>) : {}) ?? {};
}

async function addTaskComment(taskId: string, content: string): Promise<void> {
  await mcpToolCall(MCP_URL, AGENT_TOKEN, "add_comment", {
    work_item_id: taskId,
    content,
  });
}

async function executeTaskCore(task: TaskLike, binding: ExecutionBinding | null): Promise<void> {
  const taskLabel = `${task.id} (${task.title ?? "untitled"})`;
  log(`▶ Executing task ${taskLabel}${binding ? ` via job ${binding.jobId}` : ""}`);

  const detail = await readTaskDetail(task.id).catch((err) => {
    logErr(`read_task failed for ${task.id}: ${String(err)}`);
    return {};
  });

  const prompt = buildTaskPrompt(task, detail);
  const { workdir, mcpConfigPath, claudeMdPath } = createRuntimeWorkdir(runtimeCtx, task.id);

  let exitCode: number | null = null;
  let runtimeError: string | null = null;
  let cancelRequested = false;

  try {
    if (COMMENT_ON_START) {
      await addTaskComment(task.id, `🤖 Agent ${AGENT_ID} started execution from terminal session.`).catch((err) => {
        logErr(`start comment failed for ${task.id}: ${String(err)}`);
      });
    }

    if (binding) {
      // Fail closed before the runtime can perform work: a fenced or expired
      // claim must never leave an unowned process running.
      await binding.control.markStart(binding.jobId, binding.session, null);
    }

    const child = spawnRuntime(runtimeCtx, prompt, workdir, mcpConfigPath, claudeMdPath);

    let stopControlPolling = false;
    const controlPollLoop =
      binding == null
        ? null
        : (async () => {
            while (!stopControlPolling) {
              await sleep(CONTROL_CANCEL_POLL_MS);
              if (stopControlPolling) break;
              try {
                const ctrl = await binding.control.getControl(binding.jobId, binding.session);
                if (ctrl.shouldCancel && !cancelRequested) {
                  cancelRequested = true;
                  log(`⚠ Cancel requested for job ${binding.jobId}, terminating runtime...`);
                  await terminateChildProcess(child).catch((err) => {
                    logErr(`terminate runtime failed for ${binding.jobId}: ${String(err)}`);
                  });
                }
              } catch (err) {
                logErr(`control poll failed for job ${binding.jobId}: ${String(err)}`);
              }
            }
          })();

    exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", (err) => {
        runtimeError = err instanceof Error ? err.message : String(err);
        resolve(1);
      });
    });

    stopControlPolling = true;
    if (controlPollLoop) {
      const jobIdForLogs = binding?.jobId ?? "unknown";
      await controlPollLoop.catch((err) => {
        logErr(`control loop stop failed for job ${jobIdForLogs}: ${String(err)}`);
      });
    }

    if (exitCode === 0 && !cancelRequested) {
      log(`✓ Task ${task.id} finished`);
    } else if (cancelRequested) {
      log(`⚠ Task ${task.id} stopped by control-plane cancellation`);
    } else {
      logErr(`✗ Task ${task.id} failed (exit=${String(exitCode)})`);
    }
  } catch (err) {
    runtimeError = err instanceof Error ? err.message : String(err);
    logErr(`Task ${task.id} crashed: ${runtimeError}`);
  } finally {
    if (binding) {
      const completionError =
        runtimeError
        ?? (cancelRequested ? "cancelled_by_control_plane" : exitCode === 0 ? null : `runtime_exit_${String(exitCode)}`);
      const summary = cancelRequested
        ? "Cancelled by control plane"
        : completionError
          ? null
          : "Completed from terminal listener";

      await binding.control
        .markComplete(binding.jobId, binding.session, {
          exitCode,
          timedOut: false,
          error: completionError,
          summary,
        })
        .catch((err) => {
          logErr(`markComplete failed for job ${binding.jobId}: ${String(err)}`);
        });
    }

    cleanupWorkdir(workdir);
  }
}

async function executeDirectTask(task: TaskLike): Promise<void> {
  if (directProcessedTaskIds.has(task.id)) return;
  directProcessedTaskIds.add(task.id);
  await executeTaskCore(task, null);
}

async function executeClaimedJob(
  job: ClaimedControlJob,
  control: ControlPlaneClient,
  session: SessionIdentity,
): Promise<void> {
  const task = taskFromClaim(job);
  await executeTaskCore(task, { control, session, jobId: job.id });
}

async function processDirectQueue(): Promise<void> {
  if (processingDirectQueue) return;
  processingDirectQueue = true;
  try {
    while (directQueuedTasks.size > 0) {
      const [taskId, task] = directQueuedTasks.entries().next().value as [string, TaskLike];
      directQueuedTasks.delete(taskId);
      await executeDirectTask(task);
    }
  } finally {
    processingDirectQueue = false;
  }
}

function enqueueDirectTask(task: TaskLike): void {
  if (!task?.id) return;
  if (directProcessedTaskIds.has(task.id)) return;
  if (!directQueuedTasks.has(task.id)) {
    directQueuedTasks.set(task.id, task);
    void processDirectQueue();
  }
}

function parseSseBlock(block: string): { eventType: string; eventData: string } {
  let eventType = "";
  let eventData = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    if (line.startsWith("data:")) eventData += `${line.slice(5).trim()}\n`;
  }
  return { eventType, eventData: eventData.trim() };
}

async function watchSseOnce(): Promise<void> {
  const res = await fetch(MCP_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      accept: "text/event-stream",
      "cache-control": "no-cache",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`SSE connect failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("SSE stream has no body");

  log("Connected to MCP SSE stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const { eventType, eventData } = parseSseBlock(chunk);
      if (!eventData) continue;
      if (eventType === "heartbeat") continue;
      if (
        eventType !== "task.assigned" &&
        eventType !== "task.assigned_to_agent" &&
        eventType !== "task_assigned"
      ) {
        continue;
      }
      try {
        const raw = JSON.parse(eventData) as TaskLike | { task?: TaskLike; payload?: TaskLike };
        const task =
          (raw as { task?: TaskLike }).task
          ?? (raw as { payload?: TaskLike }).payload
          ?? (raw as TaskLike);
        if (task?.id) {
          log(`Task assigned from SSE: ${task.id}`);
          enqueueDirectTask(task);
        }
      } catch (err) {
        logErr(`Invalid task.assigned payload: ${String(err)}`);
      }
    }
  }

  throw new Error("SSE stream closed");
}

async function pollOnce(): Promise<void> {
  const statuses = ["STARTED", "ASSIGNED", "TODO", "BACKLOG"];
  for (const status of statuses) {
    try {
      const out = await mcpToolCall(MCP_URL, AGENT_TOKEN, "list_my_tasks", { status });
      const tasks = (out && typeof out === "object" ? (out as Record<string, unknown>).tasks : []) as unknown;
      const list = Array.isArray(tasks) ? (tasks as TaskLike[]) : [];
      for (const task of list) enqueueDirectTask(task);
    } catch {
      // Not all backends implement all statuses; keep polling resilient.
    }
  }
}

async function runPollMode(): Promise<void> {
  log("Running in POLL mode");
  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      logErr(`Poll failed: ${String(err)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runSseMode(allowPollFallback: boolean): Promise<void> {
  log(`Running in SSE mode${allowPollFallback ? " with poll fallback" : ""}`);
  for (;;) {
    try {
      await watchSseOnce();
    } catch (err) {
      logErr(`SSE disconnected: ${String(err)}`);
      if (allowPollFallback) {
        try {
          await pollOnce();
        } catch (pollErr) {
          logErr(`Fallback poll failed: ${String(pollErr)}`);
        }
      }
      await sleep(RECONNECT_MS);
    }
  }
}

async function runControlPlaneMode(control: ControlPlaneClient, session: SessionIdentity): Promise<void> {
  log(`Running in CONTROL mode (${control.mode}) session=${session.sessionId}`);

  void runHeartbeatLoop(control, session, HEARTBEAT_INTERVAL_MS, (err) => {
    logErr(`heartbeat failed: ${String(err)}`);
  });

  for (;;) {
    try {
      const job = await control.claim(session);
      if (!job) {
        await sleep(CLAIM_INTERVAL_MS);
        continue;
      }
      log(`Claimed job ${job.id} task=${job.taskId}`);
      await executeClaimedJob(job, control, session);
    } catch (err) {
      logErr(`Control claim loop failed: ${String(err)}`);
      await sleep(CLAIM_INTERVAL_MS);
    }
  }
}

export async function main(): Promise<void> {
  const control = resolveControlPlaneClient();
  if (control) {
    const session = buildSessionIdentity(AGENT_ID, RUNTIME_TYPE);
    log(
      `BIK Agent Listener starting: agent=${AGENT_ID} runtime=${RUNTIME_TYPE} mode=control workdir=${WORK_DIR}`,
    );
    return runControlPlaneMode(control, session);
  }

  log(
    `BIK Agent Listener starting: agent=${AGENT_ID} runtime=${RUNTIME_TYPE} mode=${MODE} workdir=${WORK_DIR}`,
  );
  if (MODE === "poll") return runPollMode();
  if (MODE === "sse") return runSseMode(false);
  return runSseMode(true);
}

if (import.meta.main) {
  await main();
}
