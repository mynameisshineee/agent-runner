#!/usr/bin/env bun
/**
 * Agent Runner — MCP Agent Dispatcher + Durable Queue
 *
 * Fase 1:
 * - Webhook firmado (HMAC)
 * - Cola durable SQLite
 * - Worker loop con lease + retry + DLQ
 * - Idempotencia por event_id
 * - Endpoints admin protegidos
 */

import {
  chmodSync,
  createWriteStream,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { printBiklabsBanner } from "./banner";

declare const Bun: {
  serve: (config: {
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }) => { port: number };
};

// ── Config ──────────────────────────────────────────────────────────────────

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "https://devapi.biklabs.ai/mcp/sse";
const RUNNER_PORT = parseInt(process.env.RUNNER_PORT ?? "3939", 10);
const RUNNER_SECRET = process.env.RUNNER_SECRET ?? "";
const RUNNER_ADMIN_TOKEN = process.env.RUNNER_ADMIN_TOKEN ?? RUNNER_SECRET;
const REQUIRE_RUNNER_SECRET = (process.env.REQUIRE_RUNNER_SECRET ?? "true") !== "false";

const WEBHOOK_MAX_SKEW_MS = parseInt(process.env.WEBHOOK_MAX_SKEW_MS ?? "300000", 10); // 5m
const MAX_WEBHOOK_BODY_BYTES = parseInt(process.env.MAX_WEBHOOK_BODY_BYTES ?? "65536", 10); // 64 KiB
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS ?? "1800000", 10); // 30m
const RUNNER_SKIP_PERMISSIONS = process.env.RUNNER_SKIP_PERMISSIONS === "true";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_SANDBOX_MODE = process.env.CODEX_SANDBOX_MODE ?? "workspace-write";
const CODEX_MCP_SERVER_NAME = process.env.CODEX_MCP_SERVER_NAME ?? "bik_pm";
const CODEX_MODEL = process.env.CODEX_MODEL ?? "";

const WORKDIR_BASE = process.env.RUNNER_WORKDIR_BASE ?? join(tmpdir(), "biklabs-agent-runs");
const RUNNER_DB_PATH = process.env.RUNNER_DB_PATH ?? join(WORKDIR_BASE, "runner.db");

const QUEUE_POLL_INTERVAL_MS = parseInt(process.env.QUEUE_POLL_INTERVAL_MS ?? "1000", 10);
const LEASE_MS = parseInt(process.env.LEASE_MS ?? "90000", 10);
const MAX_ATTEMPTS_DEFAULT = parseInt(process.env.MAX_ATTEMPTS_DEFAULT ?? "3", 10);
const MAX_QUEUE_DEPTH_PER_AGENT = parseInt(process.env.MAX_QUEUE_DEPTH_PER_AGENT ?? "20", 10);
const RUNNER_EXECUTION_MODE = (process.env.RUNNER_EXECUTION_MODE ?? "spawn") as "spawn" | "terminal";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? "30000", 10);

const AGENTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "agents.json");

const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

type JobStatus =
  | "queued"
  | "waiting_session"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "dead_letter";

type RuntimeType = "claude_code" | "codex" | "opencode" | "kiro" | "chat";
type PromptMode = "arg" | "stdin";

interface AgentConfig {
  id: string;
  name: string;
  runtimeType?: RuntimeType;
  // Generic CLI adapter fields (for opencode/kiro/other CLIs without hardcoded integration)
  runtimeCommand?: string;
  runtimeArgs?: string[];
  runtimeEnv?: Record<string, string>;
  runtimePromptMode?: PromptMode;
  role: string;
  mcpToken: string;
  systemPrompt: string;
  permissions: string[];
  maxTokensBudget: number;
}

interface WebhookPayload {
  event: "task.assigned_to_agent";
  agentId: string;
  taskId: string;
  projectId: string;
  taskTitle?: string;
  taskType?: string;
}

interface RunRecord {
  jobId: string;
  agentId: string;
  runtimeType: RuntimeType;
  taskId: string;
  startedAt: string;
  finishedAt?: string;
  pid: number;
  status: "running" | "completed" | "failed" | "timed_out" | "cancelled";
  workdir: string;
  exitCode?: number | null;
}

interface JobRow {
  id: string;
  event_id: string;
  event_type: string;
  agent_id: string;
  task_id: string;
  project_id: string;
  task_title: string | null;
  task_type: string | null;
  payload_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  lease_until: number | null;
  run_key: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface JobEventRow {
  id: string;
  job_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface AgentSessionRow {
  id: string;
  agent_id: string;
  label: string | null;
  host: string | null;
  runtime_type: string | null;
  last_seen: number;
  created_at: string;
  updated_at: string;
}

if (REQUIRE_RUNNER_SECRET && !RUNNER_SECRET) {
  throw new Error(
    "RUNNER_SECRET is required. Set RUNNER_SECRET or set REQUIRE_RUNNER_SECRET=false only for local throwaway dev.",
  );
}

class PermanentJobError extends Error {}

// ── State ───────────────────────────────────────────────────────────────────

const activeRuns = new Map<string, RunRecord>();
const activeProcesses = new Map<string, ChildProcess>();
const replayCache = new Map<string, number>();
let workerTickRunning = false;

mkdirSync(WORKDIR_BASE, { recursive: true });
chmodSync(WORKDIR_BASE, 0o700);

const db = new Database(RUNNER_DB_PATH);

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.now();
}

function initDb(): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_title TEXT,
      task_type TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT ${MAX_ATTEMPTS_DEFAULT},
      next_attempt_at INTEGER NOT NULL,
      lease_until INTEGER,
      run_key TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_jobs_status_next ON agent_jobs(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent_status ON agent_jobs(agent_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_run_key ON agent_jobs(run_key);

    CREATE TABLE IF NOT EXISTS agent_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_job_events_job_created
      ON agent_job_events(job_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      label TEXT,
      host TEXT,
      runtime_type TEXT,
      last_seen INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_seen
      ON agent_sessions(agent_id, last_seen);
  `);

  // Recovery on restart: anything left leased/running is re-queued.
  const t = nowMs();
  const ts = nowIso();
  db.query(
    `
    UPDATE agent_jobs
    SET status='queued',
        lease_until=NULL,
        next_attempt_at=?,
        last_error=COALESCE(last_error, 'runner_restart_recovery'),
        updated_at=?
    WHERE status IN ('leased','running')
  `,
  ).run(t, ts);
}

initDb();

function loadAgents(): AgentConfig[] {
  const raw = readFileSync(AGENTS_PATH, "utf-8");
  const data = JSON.parse(raw);

  return data.agents.map((agent: AgentConfig) => ({
    ...agent,
    mcpToken: agent.mcpToken.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? ""),
  }));
}

function getAgent(agentId: string): AgentConfig | undefined {
  const agents = loadAgents();
  return agents.find((a) => a.id === agentId);
}

function isSessionAuthorized(req: Request): boolean {
  if (!RUNNER_SECRET) return false;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const direct = req.headers.get("x-runner-secret") ?? "";
  const provided = bearer || direct;
  return constantTimeTextEqual(RUNNER_SECRET, provided);
}

function cleanupExpiredSessions(): void {
  const cutoff = nowMs() - SESSION_TTL_MS;
  db.query("DELETE FROM agent_sessions WHERE last_seen < ?").run(cutoff);
}

function upsertSession(
  sessionId: string,
  agentId: string,
  meta?: { label?: string; host?: string; runtimeType?: string },
): void {
  const t = nowMs();
  const iso = nowIso();

  db.query(
    `
    INSERT INTO agent_sessions (id, agent_id, label, host, runtime_type, last_seen, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_id=excluded.agent_id,
      label=excluded.label,
      host=excluded.host,
      runtime_type=excluded.runtime_type,
      last_seen=excluded.last_seen,
      updated_at=excluded.updated_at
  `,
  ).run(
    sessionId,
    agentId,
    meta?.label ?? null,
    meta?.host ?? null,
    meta?.runtimeType ?? null,
    t,
    iso,
    iso,
  );
}

function isAgentOnline(agentId: string): boolean {
  cleanupExpiredSessions();
  const cutoff = nowMs() - SESSION_TTL_MS;
  const row = db
    .query(
      `
      SELECT COUNT(*) as count
      FROM agent_sessions
      WHERE agent_id = ? AND last_seen >= ?
    `,
    )
    .get(agentId, cutoff) as { count: number } | null;
  return (row?.count ?? 0) > 0;
}

function activeSessionsCount(): number {
  cleanupExpiredSessions();
  const cutoff = nowMs() - SESSION_TTL_MS;
  const row = db
    .query("SELECT COUNT(*) as count FROM agent_sessions WHERE last_seen >= ?")
    .get(cutoff) as { count: number } | null;
  return row?.count ?? 0;
}

function requeueWaitingJobsForAgent(agentId: string): number {
  const result = db
    .query(
      `
      UPDATE agent_jobs
      SET status='queued',
          next_attempt_at=?,
          updated_at=?,
          last_error=NULL
      WHERE agent_id=? AND status='waiting_session'
    `,
    )
    .run(nowMs(), nowIso(), agentId) as { changes?: number };

  return result.changes ?? 0;
}

function sanitizeId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`invalid ${label}: only [a-zA-Z0-9._:-], max 128 chars`);
  }
  return value;
}

function sanitizeEventId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(value)) {
    throw new Error("invalid eventId: only [a-zA-Z0-9._:-], min 8, max 128 chars");
  }
  return value;
}

function sanitizeOptionalShortText(
  value: string | null | undefined,
  label: string,
  maxLength = 256,
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new Error(`invalid ${label}: max length ${maxLength}`);
  }
  return trimmed;
}

function hmacHex(input: string): string {
  return createHmac("sha256", RUNNER_SECRET).update(input).digest("hex");
}

function constantTimeHexEqual(expectedHex: string, gotHex: string): boolean {
  if (!expectedHex || !gotHex) return false;
  if (expectedHex.length !== gotHex.length) return false;

  const expected = Buffer.from(expectedHex, "hex");
  const got = Buffer.from(gotHex, "hex");

  if (expected.length === 0 || got.length === 0) return false;
  if (expected.length !== got.length) return false;

  return timingSafeEqual(expected, got);
}

function constantTimeTextEqual(expected: string, got: string): boolean {
  if (!expected || !got) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const gotBuf = Buffer.from(got, "utf8");
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

function validateWebhookSignature(req: Request, rawBody: string): { ok: true } | { ok: false; reason: string } {
  if (!RUNNER_SECRET) {
    return { ok: false, reason: "runner secret not configured" };
  }

  const signatureHeader = req.headers.get("x-bik-signature") ?? "";
  const timestampHeader = req.headers.get("x-bik-timestamp") ?? "";
  const eventId = req.headers.get("x-bik-event-id") ?? "";

  if (!signatureHeader || !timestampHeader || !eventId) {
    return { ok: false, reason: "missing signature headers" };
  }

  try {
    sanitizeEventId(eventId);
  } catch {
    return { ok: false, reason: "invalid event id" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "invalid timestamp" };
  }

  const now = nowMs();
  if (Math.abs(now - timestamp) > WEBHOOK_MAX_SKEW_MS) {
    return { ok: false, reason: "stale request" };
  }

  // Replay note:
  // We do NOT hard-reject repeated event IDs here, because legitimate sender retries
  // should be accepted and deduplicated at DB layer (event_id UNIQUE).
  // We still track event IDs for observability/debug.
  const previous = replayCache.get(eventId);
  void previous;

  const received = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  const expected = hmacHex(`${timestampHeader}.${eventId}.${rawBody}`);
  if (!constantTimeHexEqual(expected, received)) {
    return { ok: false, reason: "bad signature" };
  }

  replayCache.set(eventId, now);
  for (const [id, ts] of replayCache.entries()) {
    if (now - ts > WEBHOOK_MAX_SKEW_MS * 2) replayCache.delete(id);
  }

  return { ok: true };
}

function isAdminAuthorized(req: Request): boolean {
  if (!RUNNER_ADMIN_TOKEN) return false;

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const direct = req.headers.get("x-runner-secret") ?? "";
  const provided = bearer || direct;

  return constantTimeTextEqual(RUNNER_ADMIN_TOKEN, provided);
}

function safeJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function logJobEvent(jobId: string, eventType: string, payload: Record<string, unknown> = {}): void {
  db.query(
    `
    INSERT INTO agent_job_events (id, job_id, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(randomUUID(), jobId, eventType, JSON.stringify(payload), nowIso());
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getRuntimeType(agent: AgentConfig): RuntimeType {
  return agent.runtimeType ?? "claude_code";
}

function queueDepthByAgent(agentId: string): number {
  const row = db
    .query(
      `
      SELECT COUNT(*) as count
      FROM agent_jobs
      WHERE agent_id = ?
        AND status IN ('queued','waiting_session','leased','running')
    `,
    )
    .get(agentId) as { count: number } | null;

  return row?.count ?? 0;
}

function enqueueJob(payload: WebhookPayload, eventId: string):
  | { ok: true; duplicate: boolean; jobId: string; queueDepth: number }
  | { ok: false; error: string; status: number } {
  const safeAgentId = sanitizeId(payload.agentId, "agentId");
  const safeTaskId = sanitizeId(payload.taskId, "taskId");
  const safeProjectId = sanitizeId(payload.projectId, "projectId");
  const safeTaskTitle = sanitizeOptionalShortText(payload.taskTitle, "taskTitle");
  const safeTaskType = sanitizeOptionalShortText(payload.taskType, "taskType", 128);
  sanitizeEventId(eventId);

  const queueDepth = queueDepthByAgent(safeAgentId);
  if (queueDepth >= MAX_QUEUE_DEPTH_PER_AGENT) {
    return {
      ok: false,
      error: `queue full for agent ${safeAgentId} (max ${MAX_QUEUE_DEPTH_PER_AGENT})`,
      status: 429,
    };
  }

  const jobId = randomUUID();
  const runKey = `${safeAgentId}:${safeTaskId}`;
  const createdAt = nowIso();
  const nextAttemptAt = nowMs();
  const initialStatus: JobStatus =
    RUNNER_EXECUTION_MODE === "terminal" && !isAgentOnline(safeAgentId)
      ? "waiting_session"
      : "queued";

  const activeSameTask = db
    .query(
      `
      SELECT id
      FROM agent_jobs
      WHERE run_key = ?
        AND status IN ('queued','waiting_session','leased','running')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(runKey) as { id: string } | null;

  if (activeSameTask) {
    return {
      ok: true,
      duplicate: true,
      jobId: activeSameTask.id,
      queueDepth,
    };
  }

  try {
    db.query(
      `
      INSERT INTO agent_jobs (
        id, event_id, event_type, agent_id, task_id, project_id,
        task_title, task_type, payload_json, status, attempts, max_attempts,
        next_attempt_at, lease_until, run_key, last_error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, ?, ?)
    `,
    ).run(
      jobId,
      eventId,
      payload.event,
      safeAgentId,
      safeTaskId,
      safeProjectId,
      safeTaskTitle,
      safeTaskType,
      JSON.stringify(payload),
      initialStatus,
      MAX_ATTEMPTS_DEFAULT,
      nextAttemptAt,
      runKey,
      createdAt,
      createdAt,
    );

    logJobEvent(jobId, initialStatus === "queued" ? "job.queued" : "job.waiting_session", {
      eventId,
      agentId: safeAgentId,
      taskId: safeTaskId,
      projectId: safeProjectId,
    });

    return { ok: true, duplicate: false, jobId, queueDepth: queueDepth + 1 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint failed: agent_jobs.event_id")) {
      const existing = db
        .query("SELECT id FROM agent_jobs WHERE event_id = ?")
        .get(eventId) as { id: string } | null;
      return {
        ok: true,
        duplicate: true,
        jobId: existing?.id ?? "unknown",
        queueDepth,
      };
    }

    return { ok: false, error: `db enqueue failed: ${msg}`, status: 500 };
  }
}

function claimNextEligibleJob(): JobRow | null {
  const candidate = db
    .query(
      `
      SELECT j.*
      FROM agent_jobs j
      WHERE j.status = 'queued'
        AND j.next_attempt_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM agent_jobs r
          WHERE r.agent_id = j.agent_id
            AND r.status IN ('leased', 'running')
        )
      ORDER BY j.created_at ASC
      LIMIT 1
    `,
    )
    .get(nowMs()) as JobRow | null;

  if (!candidate) return null;

  const leaseUntil = nowMs() + LEASE_MS;
  const updatedAt = nowIso();

  const claimed = db
    .query(
      `
      UPDATE agent_jobs
      SET status='leased', lease_until=?, attempts=attempts + 1, updated_at=?
      WHERE id=? AND status='queued'
    `,
    )
    .run(leaseUntil, updatedAt, candidate.id);

  if ((claimed as { changes?: number }).changes !== 1) {
    return null;
  }

  logJobEvent(candidate.id, "job.leased", {
    leaseUntil,
  });

  const leased = db
    .query("SELECT * FROM agent_jobs WHERE id = ?")
    .get(candidate.id) as JobRow | null;

  return leased;
}

function claimNextJobForAgentSession(agentId: string): JobRow | null {
  const safeAgentId = sanitizeId(agentId, "agentId");
  const candidate = db
    .query(
      `
      SELECT *
      FROM agent_jobs
      WHERE agent_id = ?
        AND status IN ('queued','waiting_session')
        AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT 1
    `,
    )
    .get(safeAgentId, nowMs()) as JobRow | null;

  if (!candidate) return null;

  const leaseUntil = nowMs() + LEASE_MS;
  const claimed = db
    .query(
      `
      UPDATE agent_jobs
      SET status='leased', lease_until=?, attempts=attempts + 1, updated_at=?
      WHERE id=? AND status IN ('queued','waiting_session')
    `,
    )
    .run(leaseUntil, nowIso(), candidate.id) as { changes?: number };

  if ((claimed.changes ?? 0) !== 1) return null;

  logJobEvent(candidate.id, "job.leased", {
    leaseUntil,
    via: "terminal_session",
  });

  return getJobById(candidate.id);
}

function markJobRunning(jobId: string): boolean {
  const result = db.query(
    `
    UPDATE agent_jobs
    SET status='running',
        lease_until=?,
        last_error=NULL,
        updated_at=?
    WHERE id=? AND status='leased'
  `,
  ).run(nowMs() + LEASE_MS, nowIso(), jobId) as { changes?: number };
  if ((result.changes ?? 0) !== 1) return false;
  logJobEvent(jobId, "job.running");
  return true;
}

function markJobCompleted(jobId: string): boolean {
  const result = db.query(
    `
    UPDATE agent_jobs
    SET status='completed', lease_until=NULL, updated_at=?
    WHERE id=? AND status IN ('running','leased')
  `,
  ).run(nowIso(), jobId) as { changes?: number };
  if ((result.changes ?? 0) !== 1) return false;
  logJobEvent(jobId, "job.completed");
  return true;
}

function markJobCancelled(jobId: string, reason: string): boolean {
  const result = db.query(
    `
    UPDATE agent_jobs
    SET status='cancelled',
        lease_until=NULL,
        last_error=?,
        updated_at=?
    WHERE id=?
      AND status NOT IN ('completed','dead_letter','cancelled')
  `,
  ).run(reason, nowIso(), jobId) as { changes?: number };
  if ((result.changes ?? 0) !== 1) return false;
  logJobEvent(jobId, "job.cancelled", { reason });
  return true;
}

function markJobDeadLetter(jobId: string, reason: string): void {
  db.query(
    `
    UPDATE agent_jobs
    SET status='dead_letter',
        lease_until=NULL,
        last_error=?,
        updated_at=?
    WHERE id=?
  `,
  ).run(reason, nowIso(), jobId);
  logJobEvent(jobId, "job.dead_letter", { reason });
}

function getJobById(jobId: string): JobRow | null {
  return db.query("SELECT * FROM agent_jobs WHERE id = ?").get(jobId) as JobRow | null;
}

function retryJobNow(jobId: string): { ok: true } | { ok: false; status: number; error: string } {
  const job = getJobById(jobId);
  if (!job) return { ok: false, status: 404, error: "job not found" };

  if (job.status === "running" || job.status === "leased") {
    return { ok: false, status: 409, error: `cannot retry job in status=${job.status}` };
  }

  db.query(
    `
    UPDATE agent_jobs
    SET status='queued',
        attempts=0,
        lease_until=NULL,
        next_attempt_at=?,
        last_error=NULL,
        updated_at=?
    WHERE id=?
  `,
  ).run(nowMs(), nowIso(), jobId);
  logJobEvent(jobId, "job.retry_manual");

  processQueueTick();
  return { ok: true };
}

function cancelJobNow(jobId: string): { ok: true } | { ok: false; status: number; error: string } {
  const job = getJobById(jobId);
  if (!job) return { ok: false, status: 404, error: "job not found" };

  if (job.status === "completed" || job.status === "dead_letter" || job.status === "cancelled") {
    return { ok: false, status: 409, error: `cannot cancel job in status=${job.status}` };
  }

  const active = activeProcesses.get(jobId);
  if (active) {
    for (const run of activeRuns.values()) {
      if (run.jobId === jobId) {
        run.status = "cancelled";
        break;
      }
    }
  }

  if (active) {
    try {
      active.kill("SIGTERM");
      setTimeout(() => {
        try {
          active.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5_000);
    } catch {
      // ignore
    }
  }

  const cancelled = markJobCancelled(jobId, "cancelled_by_admin");
  if (!cancelled) {
    return { ok: false, status: 409, error: "cancel transition failed" };
  }
  return { ok: true };
}

function backoffMsForAttempt(attempts: number): number {
  const idx = Math.max(0, Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1));
  return RETRY_BACKOFF_MS[idx] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
}

function markJobFailedWithRetry(jobId: string, reason: string, timedOut = false): void {
  const row = db
    .query("SELECT attempts, max_attempts FROM agent_jobs WHERE id = ?")
    .get(jobId) as { attempts: number; max_attempts: number } | null;

  if (!row) return;

  const attempts = row.attempts;
  const maxAttempts = row.max_attempts;
  const updatedAt = nowIso();

  if (attempts >= maxAttempts) {
    db.query(
      `
      UPDATE agent_jobs
      SET status='dead_letter',
          lease_until=NULL,
          last_error=?,
          updated_at=?
      WHERE id=?
    `,
    ).run(reason, updatedAt, jobId);
    logJobEvent(jobId, "job.dead_letter", { reason, attempts, maxAttempts });
    return;
  }

  const delay = backoffMsForAttempt(attempts);
  const nextAttemptAt = nowMs() + delay;
  const status: JobStatus = timedOut ? "timed_out" : "failed";

  db.query(
    `
    UPDATE agent_jobs
    SET status='queued',
        lease_until=NULL,
        last_error=?,
        next_attempt_at=?,
        updated_at=?
    WHERE id=?
  `,
  ).run(`${status}: ${reason}`, nextAttemptAt, updatedAt, jobId);
  logJobEvent(jobId, "job.requeued", {
    reason,
    timedOut,
    attempts,
    maxAttempts,
    nextAttemptAt,
  });
}

function recoverStaleLeases(): void {
  const stale = db
    .query(
      `
      SELECT id
      FROM agent_jobs
      WHERE status='leased' AND lease_until IS NOT NULL AND lease_until < ?
    `,
    )
    .all(nowMs()) as Array<{ id: string }>;

  const t = nowMs();
  const ts = nowIso();
  db.query(
    `
    UPDATE agent_jobs
    SET status='queued',
        lease_until=NULL,
        next_attempt_at=?,
        updated_at=?,
        last_error=COALESCE(last_error, 'lease_expired_recovery')
    WHERE status='leased' AND lease_until IS NOT NULL AND lease_until < ?
  `,
  ).run(t, ts, t);

  for (const row of stale) {
    logJobEvent(row.id, "job.recovered_stale_lease");
  }
}

// ── MCP Config Generation ───────────────────────────────────────────────────

function createAgentWorkdir(agent: AgentConfig, taskId: string): string {
  const safeAgentId = sanitizeId(agent.id, "agentId");
  const safeTaskId = sanitizeId(taskId, "taskId");

  const workdir = mkdtempSync(join(WORKDIR_BASE, `biklabs-agent-${safeAgentId}-${safeTaskId}-`));

  const mcpConfig = {
    mcpServers: {
      "bik-pm": {
        type: "sse",
        url: MCP_SERVER_URL,
        headers: {
          Authorization: `Bearer ${agent.mcpToken}`,
        },
      },
    },
  };

  writeFileSync(join(workdir, "mcp.json"), JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

  const claudeMd = `# ${agent.name}

Role: ${agent.role}
Permissions: ${agent.permissions.join(", ")}

## Rules
- You are ${agent.name}. All MCP actions are authenticated with YOUR token.
- The PM knows your identity from your token. You can only do what your permissions allow.
- When done, update the work item status to \"In Review\".
- Add a comment summarizing what you did.
- Never modify work items assigned to other agents.
- Budget: max ${agent.maxTokensBudget} tokens per task.
`;

  writeFileSync(join(workdir, "CLAUDE.md"), claudeMd, { mode: 0o600 });

  return workdir;
}

function buildPrompt(agent: AgentConfig, payload: WebhookPayload): string {
  const prompt = [
    agent.systemPrompt,
    "",
    "## Tarea asignada",
    `- Task ID: ${payload.taskId}`,
    `- Project ID: ${payload.projectId}`,
    payload.taskTitle ? `- Title: ${payload.taskTitle}` : "",
    payload.taskType ? `- Type: ${payload.taskType}` : "",
    "",
    "## Instrucciones",
    '1. Usa la herramienta MCP "read_data" para leer los detalles completos de la tarea.',
    `2. Ejecuta segun tu rol (${agent.role}).`,
    '3. Cuando termines, actualiza el estado a "In Review" con "update_entity".',
    "4. Anade un comentario con el resumen de lo que hiciste.",
  ]
    .filter(Boolean)
    .join("\n");

  return prompt;
}

function fillTemplate(value: string, vars: Record<string, string>): string {
  let out = value;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

function buildRuntimeCommand(
  runtimeType: RuntimeType,
  agent: AgentConfig,
  workdir: string,
  prompt: string,
): { command: string; args: string[]; env: Record<string, string>; promptMode: PromptMode } {
  if (runtimeType === "claude_code") {
    const args = [
      "--mcp-config",
      join(workdir, "mcp.json"),
      "-p",
      prompt,
      "--max-turns",
      "20",
    ];

    if (RUNNER_SKIP_PERMISSIONS) {
      args.push("--dangerously-skip-permissions");
    }

    return { command: CLAUDE_BIN, args, env: {}, promptMode: "arg" };
  }

  if (runtimeType === "codex") {
    const serverName = CODEX_MCP_SERVER_NAME;
    const args = [
      "exec",
      "--cd",
      workdir,
      "--skip-git-repo-check",
      "--sandbox",
      CODEX_SANDBOX_MODE,
      "-c",
      `mcp_servers.${serverName}.url=${tomlString(MCP_SERVER_URL)}`,
      "-c",
      `mcp_servers.${serverName}.bearer_token_env_var=${tomlString("BIK_PM_MCP_TOKEN")}`,
    ];

    if (CODEX_MODEL) {
      args.push("-m", CODEX_MODEL);
    }

    args.push(prompt);

    return {
      command: CODEX_BIN,
      args,
      env: {},
      promptMode: "arg",
    };
  }

  if (
    (runtimeType === "opencode" || runtimeType === "kiro" || runtimeType === "chat") &&
    agent.runtimeCommand
  ) {
    const vars = {
      PROMPT: prompt,
      WORKDIR: workdir,
      MCP_URL: MCP_SERVER_URL,
      MCP_CONFIG: join(workdir, "mcp.json"),
      CLAUDE_MD: join(workdir, "CLAUDE.md"),
    };

    const args = (agent.runtimeArgs ?? []).map((a) => fillTemplate(a, vars));
    const env = Object.fromEntries(
      Object.entries(agent.runtimeEnv ?? {}).map(([k, v]) => [k, fillTemplate(v, vars)]),
    );

    const mode: PromptMode = agent.runtimePromptMode ?? "arg";
    if (mode === "arg" && !args.some((a) => a.includes(prompt))) {
      args.push(prompt);
    }

    return {
      command: agent.runtimeCommand,
      args,
      env,
      promptMode: mode,
    };
  }

  throw new PermanentJobError(
    `runtime not implemented: ${runtimeType}. Configure runtimeCommand/runtimeArgs for generic CLI adapter.`,
  );
}

function spawnAgent(agent: AgentConfig, payload: WebhookPayload, jobId: string): RunRecord {
  const runtimeType = getRuntimeType(agent);
  const workdir = createAgentWorkdir(agent, payload.taskId);
  const prompt = buildPrompt(agent, payload);

  const runtime = buildRuntimeCommand(runtimeType, agent, workdir, prompt);

  const args = [
    ...runtime.args,
  ];

  const child = spawn(runtime.command, args, {
    cwd: workdir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...runtime.env,
      CLAUDE_MD: join(workdir, "CLAUDE.md"),
      BIK_PM_MCP_TOKEN: agent.mcpToken,
      BIK_PM_MCP_URL: MCP_SERVER_URL,
    },
    detached: true,
  });

  const logPath = join(workdir, "run.log");
  const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  let spawnError: string | null = null;

  child.stdout?.on("data", (chunk: Buffer) => logStream.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => logStream.write(chunk));
  if (runtime.promptMode === "stdin" && child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }
  child.on("error", (err) => {
    spawnError = `spawn_error: ${err.message}`;
    logStream.write(`${spawnError}\n`);
  });

  const record: RunRecord = {
    jobId,
    agentId: agent.id,
    runtimeType,
    taskId: payload.taskId,
    startedAt: nowIso(),
    pid: child.pid ?? -1,
    status: "running",
    workdir,
  };

  const runKey = `${agent.id}:${payload.taskId}`;
  activeRuns.set(runKey, record);
  activeProcesses.set(jobId, child);
  logJobEvent(jobId, "runtime.spawned", {
    runtimeType,
    pid: record.pid,
    taskId: payload.taskId,
  });

  const timeoutHandle = setTimeout(() => {
    if (record.status !== "running") return;
    record.status = "timed_out";

    try {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    } catch {
      // ignore
    }
  }, RUN_TIMEOUT_MS);

  child.on("exit", (code) => {
    clearTimeout(timeoutHandle);

    if (record.status === "running") {
      record.status = code === 0 ? "completed" : "failed";
    }

    record.finishedAt = nowIso();
    record.exitCode = code;

    activeRuns.delete(runKey);
    activeProcesses.delete(jobId);

    if (record.status === "cancelled") {
      // cancelJobNow() may have already transitioned this job to cancelled.
      // Avoid clobbering reason/timestamps twice on normal process teardown.
      const current = getJobById(jobId);
      if (current?.status !== "cancelled") {
        markJobCancelled(jobId, "cancelled_runtime");
      }
    } else if (spawnError) {
      markJobFailedWithRetry(jobId, spawnError);
    } else if (record.status === "completed") {
      markJobCompleted(jobId);
    } else if (record.status === "timed_out") {
      markJobFailedWithRetry(jobId, "process timeout", true);
    } else {
      markJobFailedWithRetry(jobId, `process exited code=${String(code)}`);
    }

    logStream.end();

    console.log(
      `[${nowIso()}] ${agent.name} finished task ${payload.taskId} (job=${jobId}) — ${record.status}`,
    );

    setTimeout(() => {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }, 15_000);
  });

  child.unref();

  return record;
}

function processQueueTick(): void {
  if (RUNNER_EXECUTION_MODE !== "spawn") return;
  if (workerTickRunning) return;
  workerTickRunning = true;

  try {
    recoverStaleLeases();

    for (;;) {
      const job = claimNextEligibleJob();
      if (!job) break;

      const agent = getAgent(job.agent_id);
      if (!agent) {
        markJobDeadLetter(job.id, `agent not found: ${job.agent_id}`);
        continue;
      }

      if (!agent.mcpToken) {
        markJobFailedWithRetry(job.id, `missing MCP token for agent: ${agent.id}`);
        continue;
      }

      let payload: WebhookPayload;
      try {
        payload = JSON.parse(job.payload_json) as WebhookPayload;
      } catch {
        markJobDeadLetter(job.id, "invalid payload_json");
        continue;
      }

      try {
        spawnAgent(agent, payload, job.id);
        if (!markJobRunning(job.id)) {
          markJobFailedWithRetry(job.id, "state transition failed: leased->running");
        }
      } catch (err) {
        if (err instanceof PermanentJobError) {
          markJobDeadLetter(job.id, err.message);
          continue;
        }
        markJobFailedWithRetry(
          job.id,
          `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    workerTickRunning = false;
  }
}

if (RUNNER_EXECUTION_MODE === "spawn") {
  setInterval(processQueueTick, QUEUE_POLL_INTERVAL_MS);
  processQueueTick(); // initial kick
} else {
  // Terminal-first mode: runner does not spawn runtimes itself.
  // Keep stale lease recovery active so abandoned leased jobs are requeued.
  setInterval(recoverStaleLeases, QUEUE_POLL_INTERVAL_MS);
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: RUNNER_PORT,

  async fetch(req: Request) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      const queuedRow = db.query("SELECT COUNT(*) as count FROM agent_jobs WHERE status='queued'").get() as {
        count: number;
      } | null;
      const waitingRow = db.query(
        "SELECT COUNT(*) as count FROM agent_jobs WHERE status='waiting_session'",
      ).get() as {
        count: number;
      } | null;
      return safeJsonResponse({
        status: "ok",
        mode: RUNNER_EXECUTION_MODE,
        activeRuns: activeRuns.size,
        queuedJobs: queuedRow?.count ?? 0,
        waitingSessionJobs: waitingRow?.count ?? 0,
        onlineSessions: activeSessionsCount(),
      });
    }

    if (url.pathname === "/stats" && req.method === "GET") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      const byStatus = db
        .query(
          `
          SELECT status, COUNT(*) as count
          FROM agent_jobs
          GROUP BY status
        `,
        )
        .all() as Array<{ status: string; count: number }>;

      const totals = db
        .query(
          `
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                 SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) as dead_letter
          FROM agent_jobs
        `,
        )
        .get() as {
        total: number;
        completed: number;
        dead_letter: number;
      } | null;

      return safeJsonResponse({
        activeRuns: activeRuns.size,
        byStatus,
        totals: totals ?? { total: 0, completed: 0, dead_letter: 0 },
      });
    }

    if (url.pathname === "/runs" && req.method === "GET") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      return safeJsonResponse([...activeRuns.values()]);
    }

    if (url.pathname === "/agents" && req.method === "GET") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      const agents = loadAgents().map(({ mcpToken, ...rest }) => rest);
      return safeJsonResponse(agents);
    }

    if (url.pathname === "/sessions" && req.method === "GET") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      cleanupExpiredSessions();
      const rows = db
        .query(
          `
          SELECT id, agent_id, label, host, runtime_type, last_seen, created_at, updated_at
          FROM agent_sessions
          ORDER BY updated_at DESC
        `,
        )
        .all() as AgentSessionRow[];
      return safeJsonResponse(rows);
    }

    if (url.pathname === "/jobs" && req.method === "GET") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      const status = url.searchParams.get("status");
      const agentId = url.searchParams.get("agentId");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100;

      const rows = db
        .query(
          `
          SELECT *
          FROM agent_jobs
          WHERE (?1 IS NULL OR status = ?1)
            AND (?2 IS NULL OR agent_id = ?2)
          ORDER BY created_at DESC
          LIMIT ?3
        `,
        )
        .all(status, agentId, safeLimit) as JobRow[];

      return safeJsonResponse(rows);
    }

    const eventsMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/events$/i);
    if (eventsMatch && req.method === "GET") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      const jobId = eventsMatch[1] ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;

      const rows = db
        .query(
          `
          SELECT id, job_id, event_type, payload_json, created_at
          FROM agent_job_events
          WHERE job_id = ?
          ORDER BY created_at ASC
          LIMIT ?
        `,
        )
        .all(jobId, safeLimit) as JobEventRow[];

      return safeJsonResponse(rows);
    }

    const cancelMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/cancel$/i);
    if (cancelMatch && req.method === "POST") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      const jobId = cancelMatch[1] ?? "";
      const result = cancelJobNow(jobId);
      if (!result.ok) {
        return safeJsonResponse({ error: result.error }, { status: result.status });
      }
      return safeJsonResponse({ ok: true, jobId });
    }

    const retryMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/retry$/i);
    if (retryMatch && req.method === "POST") {
      if (!isAdminAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      const jobId = retryMatch[1] ?? "";
      const result = retryJobNow(jobId);
      if (!result.ok) {
        return safeJsonResponse({ error: result.error }, { status: result.status });
      }
      return safeJsonResponse({ ok: true, jobId });
    }

    if (url.pathname === "/agent/session/heartbeat" && req.method === "POST") {
      if (!isSessionAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      type SessionHeartbeatPayload = {
        sessionId: string;
        agentId: string;
        label?: string;
        host?: string;
        runtimeType?: string;
      };

      let body: SessionHeartbeatPayload;
      try {
        body = (await req.json()) as SessionHeartbeatPayload;
      } catch {
        return safeJsonResponse({ error: "invalid json" }, { status: 400 });
      }

      try {
        sanitizeId(body.sessionId, "sessionId");
        sanitizeId(body.agentId, "agentId");
      } catch (err) {
        return safeJsonResponse({ error: String(err) }, { status: 400 });
      }

      upsertSession(body.sessionId, body.agentId, {
        label: body.label,
        host: body.host,
        runtimeType: body.runtimeType,
      });

      const requeued = requeueWaitingJobsForAgent(body.agentId);

      return safeJsonResponse({
        ok: true,
        mode: RUNNER_EXECUTION_MODE,
        requeuedWaitingJobs: requeued,
        online: isAgentOnline(body.agentId),
        sessionTtlMs: SESSION_TTL_MS,
      });
    }

    if (url.pathname === "/agent/session/claim" && req.method === "POST") {
      if (!isSessionAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      if (RUNNER_EXECUTION_MODE !== "terminal") {
        return safeJsonResponse({ error: "session claim disabled in spawn mode" }, { status: 409 });
      }

      type SessionClaimPayload = {
        sessionId: string;
        agentId: string;
        label?: string;
        host?: string;
        runtimeType?: string;
      };

      let body: SessionClaimPayload;
      try {
        body = (await req.json()) as SessionClaimPayload;
      } catch {
        return safeJsonResponse({ error: "invalid json" }, { status: 400 });
      }

      try {
        sanitizeId(body.sessionId, "sessionId");
        sanitizeId(body.agentId, "agentId");
      } catch (err) {
        return safeJsonResponse({ error: String(err) }, { status: 400 });
      }

      upsertSession(body.sessionId, body.agentId, {
        label: body.label,
        host: body.host,
        runtimeType: body.runtimeType,
      });

      requeueWaitingJobsForAgent(body.agentId);

      const job = claimNextJobForAgentSession(body.agentId);
      if (!job) {
        return safeJsonResponse({ ok: true, job: null });
      }

      const agent = getAgent(body.agentId);
      if (!agent) {
        markJobDeadLetter(job.id, `agent not found on claim: ${body.agentId}`);
        return safeJsonResponse({ ok: false, error: "agent not found" }, { status: 404 });
      }

      return safeJsonResponse({
        ok: true,
        job: {
          id: job.id,
          taskId: job.task_id,
          projectId: job.project_id,
          taskTitle: job.task_title,
          taskType: job.task_type,
          attempts: job.attempts,
          maxAttempts: job.max_attempts,
          payload: JSON.parse(job.payload_json),
        },
        agent: {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          systemPrompt: agent.systemPrompt,
          runtimeType: getRuntimeType(agent),
          permissions: agent.permissions,
          maxTokensBudget: agent.maxTokensBudget,
        },
      });
    }

    const sessionStartMatch = url.pathname.match(/^\/agent\/session\/jobs\/([a-f0-9-]+)\/start$/i);
    if (sessionStartMatch && req.method === "POST") {
      if (!isSessionAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      type SessionStartPayload = { sessionId: string; agentId: string; pid?: number };
      let body: SessionStartPayload;
      try {
        body = (await req.json()) as SessionStartPayload;
      } catch {
        return safeJsonResponse({ error: "invalid json" }, { status: 400 });
      }

      try {
        sanitizeId(body.sessionId, "sessionId");
        sanitizeId(body.agentId, "agentId");
      } catch (err) {
        return safeJsonResponse({ error: String(err) }, { status: 400 });
      }

      const jobId = sessionStartMatch[1] ?? "";
      const job = getJobById(jobId);
      if (!job) return safeJsonResponse({ error: "job not found" }, { status: 404 });
      if (job.agent_id !== body.agentId) {
        return safeJsonResponse({ error: "agent mismatch" }, { status: 403 });
      }
      if (job.status !== "leased") {
        return safeJsonResponse({ error: `job not leased (status=${job.status})` }, { status: 409 });
      }

      if (!markJobRunning(jobId)) {
        return safeJsonResponse({ error: "state transition failed: leased->running" }, { status: 409 });
      }
      logJobEvent(jobId, "runtime.started_terminal", {
        sessionId: body.sessionId,
        agentId: body.agentId,
        pid: body.pid ?? null,
      });
      return safeJsonResponse({ ok: true, jobId });
    }

    const sessionCompleteMatch = url.pathname.match(/^\/agent\/session\/jobs\/([a-f0-9-]+)\/complete$/i);
    if (sessionCompleteMatch && req.method === "POST") {
      if (!isSessionAuthorized(req)) {
        return safeJsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      type SessionCompletePayload = {
        sessionId: string;
        agentId: string;
        exitCode?: number | null;
        timedOut?: boolean;
        error?: string | null;
        summary?: string | null;
      };
      let body: SessionCompletePayload;
      try {
        body = (await req.json()) as SessionCompletePayload;
      } catch {
        return safeJsonResponse({ error: "invalid json" }, { status: 400 });
      }

      try {
        sanitizeId(body.sessionId, "sessionId");
        sanitizeId(body.agentId, "agentId");
      } catch (err) {
        return safeJsonResponse({ error: String(err) }, { status: 400 });
      }

      const jobId = sessionCompleteMatch[1] ?? "";
      const job = getJobById(jobId);
      if (!job) return safeJsonResponse({ error: "job not found" }, { status: 404 });
      if (job.agent_id !== body.agentId) {
        return safeJsonResponse({ error: "agent mismatch" }, { status: 403 });
      }
      if (!["running", "leased"].includes(job.status)) {
        return safeJsonResponse({ error: `job not active (status=${job.status})` }, { status: 409 });
      }

      const ok = (body.exitCode ?? 1) === 0 && !body.error && !body.timedOut;
      if (ok) {
        if (!markJobCompleted(jobId)) {
          return safeJsonResponse({ error: "state transition failed: active->completed" }, { status: 409 });
        }
      } else {
        markJobFailedWithRetry(jobId, body.error ?? `exit_code=${String(body.exitCode ?? "unknown")}`, !!body.timedOut);
      }
      logJobEvent(jobId, "runtime.completed_terminal", {
        sessionId: body.sessionId,
        agentId: body.agentId,
        exitCode: body.exitCode ?? null,
        timedOut: !!body.timedOut,
        summary: body.summary ?? null,
        error: body.error ?? null,
      });
      return safeJsonResponse({ ok: true, jobId });
    }

    if (url.pathname === "/webhook" && req.method === "POST") {
      const contentLengthHeader = req.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
          return safeJsonResponse({ error: "payload too large" }, { status: 413 });
        }
      }

      const rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
        return safeJsonResponse({ error: "payload too large" }, { status: 413 });
      }

      let payload: WebhookPayload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return safeJsonResponse({ error: "invalid json" }, { status: 400 });
      }

      const sig = validateWebhookSignature(req, rawBody);
      if (!sig.ok) {
        const reason = "reason" in sig ? sig.reason : "invalid signature";
        return safeJsonResponse({ error: "unauthorized", reason }, { status: 401 });
      }

      if (payload.event !== "task.assigned_to_agent") {
        return safeJsonResponse({ error: `unknown event: ${payload.event}` }, { status: 400 });
      }

      const eventId = req.headers.get("x-bik-event-id") ?? "";
      if (!eventId) {
        return safeJsonResponse({ error: "missing x-bik-event-id" }, { status: 400 });
      }

      try {
        sanitizeEventId(eventId);
        sanitizeId(payload.agentId, "agentId");
        sanitizeId(payload.taskId, "taskId");
        sanitizeId(payload.projectId, "projectId");
      } catch (err) {
        return safeJsonResponse({ error: String(err) }, { status: 400 });
      }

      const enqueued = enqueueJob(payload, eventId);
      if (!enqueued.ok) {
        return safeJsonResponse({ error: enqueued.error }, { status: enqueued.status });
      }

      if (RUNNER_EXECUTION_MODE === "spawn") {
        processQueueTick();
      }

      return safeJsonResponse(
        {
          accepted: true,
          duplicate: enqueued.duplicate,
          jobId: enqueued.jobId,
          agentId: payload.agentId,
          taskId: payload.taskId,
          queueDepth: enqueued.queueDepth,
        },
        { status: 202 },
      );
    }

    return safeJsonResponse({ error: "not found" }, { status: 404 });
  },
});

printBiklabsBanner("Agent Runner — Durable Queue");
console.log(`
╔══════════════════════════════════════════════════╗
║ BIKLabs Agent Runner — Durable Queue (Fase 1)   ║
╠══════════════════════════════════════════════════╣
║  Port:     ${String(RUNNER_PORT).padEnd(37)}║
║  MCP URL:  ${MCP_SERVER_URL.slice(0, 37).padEnd(37)}║
║  DB:       ${RUNNER_DB_PATH.slice(0, 37).padEnd(37)}║
║  Agents:   ${String(loadAgents().length).padEnd(37)}║
║  Poll:     ${`${QUEUE_POLL_INTERVAL_MS}ms`.padEnd(37)}║
║  Lease:    ${`${LEASE_MS}ms`.padEnd(37)}║
║  Timeout:  ${`${Math.floor(RUN_TIMEOUT_MS / 1000)}s`.padEnd(37)}║
║  Mode:     ${RUNNER_EXECUTION_MODE.padEnd(37)}║
║  Secure:   ${(RUNNER_SECRET ? "yes" : "no").padEnd(37)}║
╚══════════════════════════════════════════════════╝

Endpoints:
  POST /webhook     — Dispatch agent (signed, enqueues durable job)
  GET  /jobs        — Durable jobs (admin auth)
  GET  /jobs/:id/events — Job event timeline (admin auth)
  POST /jobs/:id/cancel — Cancel job (admin auth)
  POST /jobs/:id/retry  — Retry job (admin auth)
  GET  /stats       — Queue/run aggregates (admin auth)
  GET  /runs        — Active process runs (admin auth)
  GET  /agents      — Registered agents (admin auth)
  GET  /sessions    — Active terminal sessions (admin auth)
  GET  /health      — Health check + queue stats
  POST /agent/session/heartbeat — Session keepalive (runner secret)
  POST /agent/session/claim     — Claim next job for session agent
  POST /agent/session/jobs/:id/start    — Mark running
  POST /agent/session/jobs/:id/complete — Mark complete/fail

Server listening on :${server.port}
${RUNNER_EXECUTION_MODE === "spawn" ? "Worker running (spawn mode)..." : "Terminal mode active (session-driven)..."}
`);
