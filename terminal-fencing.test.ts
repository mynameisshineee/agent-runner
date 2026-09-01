/**
 * Black-box falsifier for terminal-session identity, WIP=1, and fenced leases.
 *
 * This intentionally starts runner.ts as a separate process and only speaks its
 * public HTTP contract. A green result therefore proves the guarantees survive
 * process boundaries and SQLite restart recovery; it does not rely on internal
 * helpers or mocks.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = import.meta.dir;
const WEBHOOK_SECRET = "terminal-fencing-webhook-secret";
const ADMIN_TOKEN = "terminal-fencing-admin-token";
const WRITER_TOKEN = "terminal-fencing-writer-token";
const TEST_TOKEN = "terminal-fencing-test-token";
const DEPLOY_TOKEN = "terminal-fencing-deploy-token";
const LEASE_MS = 800;

type JsonObject = Record<string, unknown>;

type ClaimedJob = {
  id: string;
  leaseGeneration: number;
};

type ClaimResult = {
  sessionId: string;
  response: Response;
  body: JsonObject;
  job: ClaimedJob | null;
};

type RunnerProcess = {
  child: ChildProcess;
  logs: () => string;
};

const liveProcesses = new Set<ChildProcess>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function unusedPort(): Promise<number> {
  const probe = createServer();
  probe.unref();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    probe.close();
    throw new Error("could not allocate an ephemeral TCP port");
  }
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function startRunner(port: number, dbPath: string, workdir: string): RunnerProcess {
  const child = spawn(process.execPath, ["run", join(ROOT, "runner.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      RUNNER_PORT: String(port),
      RUNNER_DB_PATH: dbPath,
      RUNNER_WORKDIR_BASE: workdir,
      RUNNER_EXECUTION_MODE: "terminal",
      RUNNER_SECRET: WEBHOOK_SECRET,
      RUNNER_ADMIN_TOKEN: ADMIN_TOKEN,
      AGENT_SESSION_AUTH_MODE: "agent-token",
      WRITER_AGENT_MCP_TOKEN: "terminal-fencing-writer-mcp-token",
      TEST_AGENT_MCP_TOKEN: "terminal-fencing-test-mcp-token",
      DEPLOY_AGENT_MCP_TOKEN: "terminal-fencing-deploy-mcp-token",
      WRITER_AGENT_RUNNER_TOKEN: WRITER_TOKEN,
      TEST_AGENT_RUNNER_TOKEN: TEST_TOKEN,
      DEPLOY_AGENT_RUNNER_TOKEN: DEPLOY_TOKEN,
      LEASE_MS: String(LEASE_MS),
      QUEUE_POLL_INTERVAL_MS: "25",
      SESSION_TTL_MS: "10000",
      WEBHOOK_MAX_SKEW_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  liveProcesses.add(child);
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.once("exit", () => liveProcesses.delete(child));

  return { child, logs: () => output };
}

async function stopRunner(runner: RunnerProcess): Promise<void> {
  if (runner.child.exitCode !== null || runner.child.signalCode !== null) return;
  const exited = once(runner.child, "exit").then(() => undefined);
  runner.child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    sleep(2_000).then(() => false),
  ]);
  if (!stopped) {
    runner.child.kill("SIGKILL");
    await exited;
  }
}

async function waitUntilReady(baseUrl: string, runner: RunnerProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (runner.child.exitCode !== null || runner.child.signalCode !== null) {
      throw new Error(`runner exited before becoming ready\n${runner.logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The socket is expected to reject while Bun.serve is still starting.
    }
    await sleep(25);
  }
  throw new Error(`runner did not become ready\n${runner.logs()}`);
}

async function jsonResponse(response: Response): Promise<JsonObject> {
  const text = await response.text();
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    throw new Error(`expected JSON from ${response.url}, got ${response.status}: ${text}`);
  }
}

async function sessionPost(
  baseUrl: string,
  path: string,
  token: string | null,
  body: JsonObject,
): Promise<{ response: Response; body: JsonObject }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await jsonResponse(response) };
}

async function claim(
  baseUrl: string,
  sessionId: string,
  token = WRITER_TOKEN,
  agentId = "writer-agent",
): Promise<ClaimResult> {
  const result = await sessionPost(baseUrl, "/agent/session/claim", token, {
    sessionId,
    agentId,
    label: "terminal-fencing-test",
    host: "black-box",
    runtimeType: "claude_code",
  });
  const rawJob = result.body.job;
  let job: ClaimedJob | null = null;
  if (rawJob !== null && rawJob !== undefined) {
    expect(typeof rawJob).toBe("object");
    const value = rawJob as JsonObject;
    expect(typeof value.id).toBe("string");
    expect(Number.isInteger(value.leaseGeneration)).toBe(true);
    job = {
      id: value.id as string,
      leaseGeneration: value.leaseGeneration as number,
    };
  }
  return { sessionId, ...result, job };
}

async function waitForClaim(
  baseUrl: string,
  sessionId: string,
  timeoutMs = 3_000,
): Promise<ClaimResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await claim(baseUrl, sessionId);
    expect(result.response.status).toBe(200);
    if (result.job) return result;
    await sleep(30);
  }
  throw new Error(`no job became claimable for session ${sessionId}`);
}

async function enqueue(
  baseUrl: string,
  taskId: string,
): Promise<{ jobId: string; body: JsonObject }> {
  const eventId = `evt-${randomUUID()}`;
  const rawBody = JSON.stringify({
    event: "task.assigned_to_agent",
    workItemId: taskId,
    projectId: "terminal-fencing-project",
    agentId: "writer-agent",
    title: `Terminal fencing ${taskId}`,
    taskType: "TEST",
  });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${eventId}.${rawBody}`)
    .digest("hex");
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bik-event-id": eventId,
      "x-bik-timestamp": timestamp,
      "x-bik-signature": `sha256=${signature}`,
    },
    body: rawBody,
  });
  const body = await jsonResponse(response);
  expect(response.status).toBe(202);
  expect(body.accepted).toBe(true);
  expect(typeof body.jobId).toBe("string");
  return { jobId: body.jobId as string, body };
}

function expectRejected(result: { response: Response }): void {
  expect(result.response.ok).toBe(false);
  expect(result.response.status).toBeGreaterThanOrEqual(400);
  expect(result.response.status).toBeLessThan(500);
}

async function startJob(
  baseUrl: string,
  lease: ClaimedJob,
  sessionId: string,
  leaseGeneration = lease.leaseGeneration,
) {
  return sessionPost(
    baseUrl,
    `/agent/session/jobs/${lease.id}/start`,
    WRITER_TOKEN,
    {
      sessionId,
      agentId: "writer-agent",
      leaseGeneration,
      pid: process.pid,
    },
  );
}

async function completeJob(
  baseUrl: string,
  lease: ClaimedJob,
  sessionId: string,
  leaseGeneration = lease.leaseGeneration,
) {
  return sessionPost(
    baseUrl,
    `/agent/session/jobs/${lease.id}/complete`,
    WRITER_TOKEN,
    {
      sessionId,
      agentId: "writer-agent",
      leaseGeneration,
      exitCode: 0,
      summary: "black-box terminal fencing test",
    },
  );
}

afterEach(async () => {
  await Promise.all(
    [...liveProcesses].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await once(child, "exit");
    }),
  );
});

describe("terminal sessions — identity, WIP=1, and fenced leases", () => {
  it(
    "rejects spoofing and stale writers across expiry and runner restart",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "agent-runner-terminal-fencing-"));
      const dbPath = join(tempDir, "runner.db");
      const port = await unusedPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      let runner = startRunner(port, dbPath, tempDir);

      try {
        await waitUntilReady(baseUrl, runner);

        const unauthenticated = await sessionPost(
          baseUrl,
          "/agent/session/claim",
          null,
          { sessionId: "missing-token", agentId: "writer-agent" },
        );
        expect(unauthenticated.response.status).toBe(401);

        const spoofedIdentity = await sessionPost(
          baseUrl,
          "/agent/session/claim",
          WRITER_TOKEN,
          { sessionId: "spoofed-agent", agentId: "test-agent" },
        );
        expect(spoofedIdentity.response.status).toBe(403);

        const legacySharedHeader = await fetch(`${baseUrl}/agent/session/claim`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-runner-secret": WEBHOOK_SECRET,
          },
          body: JSON.stringify({ sessionId: "legacy-secret", agentId: "writer-agent" }),
        });
        expect(legacySharedHeader.status).toBe(401);

        const firstEnqueued = await enqueue(baseUrl, "terminal-fence-first");

        const contenders = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            claim(baseUrl, `race-session-${index}`),
          ),
        );
        for (const contender of contenders) {
          expect(contender.response.status).toBe(200);
        }
        const winners = contenders.filter((candidate) => candidate.job !== null);
        expect(winners).toHaveLength(1);
        const firstLease = winners[0]!.job!;
        const firstSession = winners[0]!.sessionId;
        expect(firstLease.id).toBe(firstEnqueued.jobId);
        expect(firstLease.leaseGeneration).toBeGreaterThan(0);

        await enqueue(baseUrl, "terminal-fence-second");
        const blockedByWip = await claim(baseUrl, "wip-contender");
        expect(blockedByWip.response.status).toBe(200);
        expect(blockedByWip.job).toBeNull();

        expectRejected(await startJob(baseUrl, firstLease, "wrong-session"));
        expectRejected(
          await startJob(
            baseUrl,
            firstLease,
            firstSession,
            firstLease.leaseGeneration + 1,
          ),
        );
        expectRejected(await completeJob(baseUrl, firstLease, "wrong-session"));
        expectRejected(
          await completeJob(
            baseUrl,
            firstLease,
            firstSession,
            firstLease.leaseGeneration + 1,
          ),
        );
        // A successful completion cannot skip the explicit leased -> running transition.
        expectRejected(await completeJob(baseUrl, firstLease, firstSession));

        // Let the original worker lose its lease, then claim the same job with
        // a new session. The generation must monotonically fence the old writer.
        await sleep(LEASE_MS + 300);
        const reclaimed = await waitForClaim(baseUrl, "post-expiry-session");
        expect(reclaimed.job!.id).toBe(firstLease.id);
        expect(reclaimed.job!.leaseGeneration).toBeGreaterThan(
          firstLease.leaseGeneration,
        );
        expectRejected(await completeJob(baseUrl, firstLease, firstSession));

        // A matching heartbeat extends the active lease. After the original
        // deadline has passed, WIP=1 must still keep another session out.
        await sleep(450);
        const heartbeat = await sessionPost(
          baseUrl,
          "/agent/session/heartbeat",
          WRITER_TOKEN,
          {
            sessionId: reclaimed.sessionId,
            agentId: "writer-agent",
            activeJobId: reclaimed.job!.id,
            leaseGeneration: reclaimed.job!.leaseGeneration,
          },
        );
        expect(heartbeat.response.status).toBe(200);
        expect(heartbeat.body.ok).toBe(true);
        const staleHeartbeat = await sessionPost(
          baseUrl,
          "/agent/session/heartbeat",
          WRITER_TOKEN,
          {
            sessionId: reclaimed.sessionId,
            agentId: "writer-agent",
            activeJobId: reclaimed.job!.id,
            leaseGeneration: reclaimed.job!.leaseGeneration - 1,
          },
        );
        expect(staleHeartbeat.response.status).toBe(409);
        await sleep(450);
        const blockedAfterRenewal = await claim(baseUrl, "renewal-contender");
        expect(blockedAfterRenewal.response.status).toBe(200);
        expect(blockedAfterRenewal.job).toBeNull();

        const startedAfterExpiry = await startJob(
          baseUrl,
          reclaimed.job!,
          reclaimed.sessionId,
        );
        expect(startedAfterExpiry.response.status).toBe(200);
        const completedAfterExpiry = await completeJob(
          baseUrl,
          reclaimed.job!,
          reclaimed.sessionId,
        );
        expect(completedAfterExpiry.response.status).toBe(200);

        // Claim the second job and kill the runner while its lease is live.
        const beforeRestart = await waitForClaim(baseUrl, "pre-restart-session");
        await stopRunner(runner);
        runner = startRunner(port, dbPath, tempDir);
        await waitUntilReady(baseUrl, runner);

        const afterRestart = await waitForClaim(baseUrl, "post-restart-session");
        expect(afterRestart.job!.id).toBe(beforeRestart.job!.id);
        expect(afterRestart.job!.leaseGeneration).toBeGreaterThan(
          beforeRestart.job!.leaseGeneration,
        );
        expectRejected(
          await completeJob(
            baseUrl,
            beforeRestart.job!,
            beforeRestart.sessionId,
          ),
        );

        const startedAfterRestart = await startJob(
          baseUrl,
          afterRestart.job!,
          afterRestart.sessionId,
        );
        expect(startedAfterRestart.response.status).toBe(200);
        const completedAfterRestart = await completeJob(
          baseUrl,
          afterRestart.job!,
          afterRestart.sessionId,
        );
        expect(completedAfterRestart.response.status).toBe(200);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.stack ?? error.message : String(error)}\n\nrunner output:\n${runner.logs()}`,
        );
      } finally {
        await stopRunner(runner);
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
