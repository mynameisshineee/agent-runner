#!/usr/bin/env bun
/**
 * Agent Session Client (terminal-first)
 *
 * Runs inside a human-visible terminal and claims jobs for a single agent.
 * This is the BYO runtime mode: execution happens in the user's local CLI session.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

type RuntimeType = "claude_code" | "codex" | "cursor" | "opencode" | "kiro" | "openclaw" | "chat";
type PromptMode = "arg" | "stdin";

const RUNNER_URL = process.env.AGENT_RUNNER_URL ?? "http://localhost:3939";
const AGENT_ID = process.env.AGENT_ID ?? "";
const AGENT_MCP_TOKEN = process.env.AGENT_MCP_TOKEN ?? "";
const AGENT_RUNNER_TOKEN = process.env.BIK_AGENT_TOKEN ?? AGENT_MCP_TOKEN;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "https://devapi.biklabs.ai/mcp/sse";

const SESSION_ID = process.env.AGENT_SESSION_ID ?? randomUUID();
const SESSION_LABEL = process.env.AGENT_SESSION_LABEL ?? `${AGENT_ID}-terminal`;
const HOST = process.env.AGENT_SESSION_HOST ?? process.env.HOSTNAME ?? "local-terminal";

const CLAIM_INTERVAL_MS = parseInt(process.env.AGENT_CLAIM_INTERVAL_MS ?? "2000", 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.AGENT_HEARTBEAT_INTERVAL_MS ?? "10000", 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.AGENT_HTTP_TIMEOUT_MS ?? "15000", 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CURSOR_BIN = process.env.CURSOR_BIN ?? "cursor-agent";

if (!AGENT_ID) throw new Error("AGENT_ID is required");
if (!AGENT_MCP_TOKEN) throw new Error("AGENT_MCP_TOKEN is required");
if (!AGENT_RUNNER_TOKEN) throw new Error("BIK_AGENT_TOKEN (or AGENT_MCP_TOKEN fallback) is required");
if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(AGENT_ID)) {
  throw new Error("AGENT_ID has invalid format (allowed: [a-zA-Z0-9._:-], max 128 chars)");
}
if (!Number.isFinite(CLAIM_INTERVAL_MS) || CLAIM_INTERVAL_MS < 250) {
  throw new Error("AGENT_CLAIM_INTERVAL_MS must be >= 250");
}
if (!Number.isFinite(HEARTBEAT_INTERVAL_MS) || HEARTBEAT_INTERVAL_MS < 1000) {
  throw new Error("AGENT_HEARTBEAT_INTERVAL_MS must be >= 1000");
}
if (!Number.isFinite(HTTP_TIMEOUT_MS) || HTTP_TIMEOUT_MS < 1000) {
  throw new Error("AGENT_HTTP_TIMEOUT_MS must be >= 1000");
}

interface ClaimedJob {
  id: string;
  leaseGeneration: number;
  taskId: string;
  projectId: string;
  taskTitle?: string | null;
  taskType?: string | null;
}

interface ActiveLease {
  jobId: string;
  leaseGeneration: number;
}

let activeLease: ActiveLease | null = null;

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  runtimeType: RuntimeType;
  runtimeCommand?: string | null;
  runtimeArgs?: string[] | null;
  runtimeEnv?: Record<string, string> | null;
  runtimePromptMode?: PromptMode | null;
  systemPrompt: string;
  permissions: string[];
  maxTokensBudget: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runnerPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${RUNNER_URL}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${AGENT_RUNNER_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`runner ${path} failed (${res.status}): ${text}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

function writeRuntimeFiles(workdir: string, agent: AgentInfo): void {
  const mcpConfig = {
    mcpServers: {
      "bik-pm": {
        type: "sse",
        url: MCP_SERVER_URL,
        headers: { Authorization: `Bearer ${AGENT_MCP_TOKEN}` },
      },
    },
  };

  writeFileSync(join(workdir, "mcp.json"), JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

  const claudeMd = `# ${agent.name}\n\nRole: ${agent.role}\nPermissions: ${agent.permissions.join(", ")}\n`;
  writeFileSync(join(workdir, "CLAUDE.md"), claudeMd, { mode: 0o600 });
}

function buildPrompt(agent: AgentInfo, job: ClaimedJob): string {
  return [
    agent.systemPrompt,
    "",
    "## Tarea asignada",
    `- Task ID: ${job.taskId}`,
    `- Project ID: ${job.projectId}`,
    job.taskTitle ? `- Title: ${job.taskTitle}` : "",
    job.taskType ? `- Type: ${job.taskType}` : "",
    "",
    "## Instrucciones",
    '1. Lee la tarea completa via MCP tool "read_data".',
    "2. Ejecuta segun tu rol.",
    '3. Actualiza el estado a "In Review" con "update_entity".',
    "4. Anade comentario resumen de trabajo.",
  ]
    .filter(Boolean)
    .join("\n");
}

function fillTemplate(value: string, vars: Record<string, string>): string {
  let out = value;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

function buildRuntimeCommand(agent: AgentInfo, workdir: string, prompt: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
  promptMode: PromptMode;
} {
  if (agent.runtimeType === "claude_code") {
    return {
      command: CLAUDE_BIN,
      args: ["--mcp-config", join(workdir, "mcp.json"), "-p", prompt, "--max-turns", "20"],
      env: {},
      promptMode: "arg",
    };
  }

  if (agent.runtimeType === "codex") {
    const serverName = process.env.CODEX_MCP_SERVER_NAME ?? "bik_pm";
    const args = [
      "exec",
      "--cd",
      workdir,
      "--skip-git-repo-check",
      "--sandbox",
      process.env.CODEX_SANDBOX_MODE ?? "workspace-write",
      "-c",
      `mcp_servers.${serverName}.url="${MCP_SERVER_URL}"`,
      "-c",
      `mcp_servers.${serverName}.bearer_token_env_var="BIK_PM_MCP_TOKEN"`,
    ];
    const model = process.env.CODEX_MODEL ?? "";
    if (model) args.push("-m", model);
    args.push(prompt);

    return {
      command: CODEX_BIN,
      args,
      env: {},
      promptMode: "arg",
    };
  }

  const defaultGenericCommandByRuntime: Partial<Record<RuntimeType, string>> = {
    cursor: CURSOR_BIN,
    opencode: "opencode",
    kiro: "kiro",
    openclaw: "openclaw",
    chat: "chat-runtime",
  };

  const command = agent.runtimeCommand ?? process.env.AGENT_RUNTIME_COMMAND ?? defaultGenericCommandByRuntime[agent.runtimeType];
  if (!command) {
    throw new Error(`runtime ${agent.runtimeType} not configured. Set runtimeCommand or AGENT_RUNTIME_COMMAND.`);
  }

  const vars = {
    PROMPT: prompt,
    WORKDIR: workdir,
    MCP_URL: MCP_SERVER_URL,
    MCP_CONFIG: join(workdir, "mcp.json"),
    CLAUDE_MD: join(workdir, "CLAUDE.md"),
  };

  const envArgTemplates = process.env.AGENT_RUNTIME_ARGS_JSON;
  let fallbackArgs: string[] | null = null;
  if (envArgTemplates) {
    try {
      const parsed = JSON.parse(envArgTemplates);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        fallbackArgs = parsed;
      }
    } catch {
      // Ignore malformed env fallback and continue to AGENT_RUNTIME_ARGS/plain default.
    }
  }
  if (!fallbackArgs) {
    fallbackArgs = (process.env.AGENT_RUNTIME_ARGS ?? "{PROMPT}").split(" ").filter(Boolean);
  }

  const argTemplates = agent.runtimeArgs ?? fallbackArgs;
  const args = argTemplates.map((value) => fillTemplate(value, vars));
  const runtimeEnv = Object.fromEntries(
    Object.entries(agent.runtimeEnv ?? {}).map(([k, v]) => [k, fillTemplate(v, vars)]),
  );

  const promptMode = agent.runtimePromptMode ?? (process.env.AGENT_RUNTIME_PROMPT_MODE === "stdin" ? "stdin" : "arg");
  if (promptMode === "arg" && !args.some((a) => a.includes(prompt))) {
    args.push(prompt);
  }

  return {
    command,
    args,
    env: runtimeEnv,
    promptMode,
  };
}

function spawnRuntime(agent: AgentInfo, workdir: string, prompt: string): { child: ReturnType<typeof spawn>; promptMode: PromptMode } {
  const runtime = buildRuntimeCommand(agent, workdir, prompt);
  const child = spawn(runtime.command, runtime.args, {
    cwd: workdir,
    env: {
      ...process.env,
      ...runtime.env,
      BIK_PM_MCP_TOKEN: AGENT_MCP_TOKEN,
      BIK_PM_MCP_URL: MCP_SERVER_URL,
      CLAUDE_MD: join(workdir, "CLAUDE.md"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return { child, promptMode: runtime.promptMode };
}

async function executeClaimedJob(job: ClaimedJob, agent: AgentInfo): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), `biklabs-session-${AGENT_ID}-${job.taskId}-`));
  writeRuntimeFiles(workdir, agent);
  const prompt = buildPrompt(agent, job);

  let exitCode: number | null = null;
  let errMessage: string | null = null;

  try {
    // Acquire the running state before starting the runtime. If this lease was
    // fenced or expired, no unowned agent process is allowed to execute.
    await runnerPost(`/agent/session/jobs/${job.id}/start`, {
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      leaseGeneration: job.leaseGeneration,
      pid: null,
    });

    const { child, promptMode } = spawnRuntime(agent, workdir, prompt);

    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    if (promptMode === "stdin" && child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", (err) => {
        errMessage = err.message;
        resolve(1);
      });
    });
  } catch (err) {
    errMessage = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  } finally {
    activeLease = null;
    await runnerPost(`/agent/session/jobs/${job.id}/complete`, {
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      leaseGeneration: job.leaseGeneration,
      exitCode,
      error: errMessage,
      timedOut: false,
      summary: errMessage ? null : "Completed from terminal session",
    }).catch((e) => {
      process.stderr.write(`\\n[agent-session] complete failed: ${String(e)}\\n`);
    });

    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function heartbeatLoop(): Promise<void> {
  for (;;) {
    try {
      const lease = activeLease;
      await runnerPost<{ ok: boolean; requeuedWaitingJobs?: number }>("/agent/session/heartbeat", {
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        label: SESSION_LABEL,
        host: HOST,
        ...(lease
          ? { activeJobId: lease.jobId, leaseGeneration: lease.leaseGeneration }
          : {}),
      });
    } catch (err) {
      process.stderr.write(`\\n[agent-session] heartbeat failed: ${String(err)}\\n`);
    }
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}

async function claimLoop(): Promise<void> {
  for (;;) {
    try {
      const claimed = await runnerPost<{ ok: boolean; job: ClaimedJob | null; agent?: AgentInfo }>("/agent/session/claim", {
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        label: SESSION_LABEL,
        host: HOST,
      });

      if (!claimed.job || !claimed.agent) {
        await sleep(CLAIM_INTERVAL_MS);
        continue;
      }

      if (!Number.isInteger(claimed.job.leaseGeneration) || claimed.job.leaseGeneration < 1) {
        throw new Error(`runner returned invalid leaseGeneration for job ${claimed.job.id}`);
      }

      process.stdout.write(`\\n[agent-session] claimed job ${claimed.job.id} task=${claimed.job.taskId}\\n`);
      activeLease = {
        jobId: claimed.job.id,
        leaseGeneration: claimed.job.leaseGeneration,
      };
      await executeClaimedJob(claimed.job, claimed.agent);
    } catch (err) {
      process.stderr.write(`\\n[agent-session] claim loop error: ${String(err)}\\n`);
      await sleep(CLAIM_INTERVAL_MS);
    }
  }
}

console.log(`[agent-session] starting session=${SESSION_ID} agent=${AGENT_ID} runner=${RUNNER_URL}`);
void heartbeatLoop();
await claimLoop();
