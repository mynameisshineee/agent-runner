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

type RuntimeType = "claude_code" | "codex" | "opencode" | "kiro" | "chat";

const RUNNER_URL = process.env.AGENT_RUNNER_URL ?? "http://localhost:3939";
const RUNNER_SECRET = process.env.RUNNER_SECRET ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";
const AGENT_MCP_TOKEN = process.env.AGENT_MCP_TOKEN ?? "";
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "https://devapi.biklabs.ai/mcp/sse";

const SESSION_ID = process.env.AGENT_SESSION_ID ?? randomUUID();
const SESSION_LABEL = process.env.AGENT_SESSION_LABEL ?? `${AGENT_ID}-terminal`;
const HOST = process.env.AGENT_SESSION_HOST ?? process.env.HOSTNAME ?? "local-terminal";

const CLAIM_INTERVAL_MS = parseInt(process.env.AGENT_CLAIM_INTERVAL_MS ?? "2000", 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.AGENT_HEARTBEAT_INTERVAL_MS ?? "10000", 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

if (!RUNNER_SECRET) throw new Error("RUNNER_SECRET is required");
if (!AGENT_ID) throw new Error("AGENT_ID is required");
if (!AGENT_MCP_TOKEN) throw new Error("AGENT_MCP_TOKEN is required");

interface ClaimedJob {
  id: string;
  taskId: string;
  projectId: string;
  taskTitle?: string | null;
  taskType?: string | null;
}

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  runtimeType: RuntimeType;
  systemPrompt: string;
  permissions: string[];
  maxTokensBudget: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runnerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${RUNNER_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${RUNNER_SECRET}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`runner ${path} failed (${res.status}): ${text}`);
  }

  return JSON.parse(text) as T;
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

function spawnRuntime(runtimeType: RuntimeType, workdir: string, prompt: string) {
  if (runtimeType === "claude_code") {
    return spawn(CLAUDE_BIN, ["--mcp-config", join(workdir, "mcp.json"), "-p", prompt, "--max-turns", "20"], {
      cwd: workdir,
      env: { ...process.env, BIK_PM_MCP_TOKEN: AGENT_MCP_TOKEN, CLAUDE_MD: join(workdir, "CLAUDE.md") },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  if (runtimeType === "codex") {
    return spawn(
      CODEX_BIN,
      [
        "exec",
        "--cd",
        workdir,
        "--skip-git-repo-check",
        "--sandbox",
        process.env.CODEX_SANDBOX_MODE ?? "workspace-write",
        "-c",
        `mcp_servers.bik_pm.url=\"${MCP_SERVER_URL}\"`,
        "-c",
        "mcp_servers.bik_pm.bearer_token_env_var=\"BIK_PM_MCP_TOKEN\"",
        prompt,
      ],
      {
        cwd: workdir,
        env: { ...process.env, BIK_PM_MCP_TOKEN: AGENT_MCP_TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  const genericCmd = process.env.AGENT_RUNTIME_COMMAND;
  if (!genericCmd) {
    throw new Error(`runtime ${runtimeType} not configured. Set AGENT_RUNTIME_COMMAND for generic runtime.`);
  }

  const genericArgs = (process.env.AGENT_RUNTIME_ARGS ?? "{PROMPT}")
    .split(" ")
    .filter(Boolean)
    .map((x) =>
      x
        .replaceAll("{PROMPT}", prompt)
        .replaceAll("{WORKDIR}", workdir)
        .replaceAll("{MCP_URL}", MCP_SERVER_URL)
        .replaceAll("{MCP_CONFIG}", join(workdir, "mcp.json")),
    );

  return spawn(genericCmd, genericArgs, {
    cwd: workdir,
    env: { ...process.env, BIK_PM_MCP_TOKEN: AGENT_MCP_TOKEN, BIK_PM_MCP_URL: MCP_SERVER_URL },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function executeClaimedJob(job: ClaimedJob, agent: AgentInfo): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), `biklabs-session-${AGENT_ID}-${job.taskId}-`));
  writeRuntimeFiles(workdir, agent);
  const prompt = buildPrompt(agent, job);

  let exitCode: number | null = null;
  let errMessage: string | null = null;

  try {
    const child = spawnRuntime(agent.runtimeType, workdir, prompt);

    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

    await runnerPost(`/agent/session/jobs/${job.id}/start`, {
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      pid: child.pid ?? null,
    });

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
    await runnerPost(`/agent/session/jobs/${job.id}/complete`, {
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
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
      await runnerPost<{ ok: boolean; requeuedWaitingJobs?: number }>("/agent/session/heartbeat", {
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        label: SESSION_LABEL,
        host: HOST,
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

      process.stdout.write(`\\n[agent-session] claimed job ${claimed.job.id} task=${claimed.job.taskId}\\n`);
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
