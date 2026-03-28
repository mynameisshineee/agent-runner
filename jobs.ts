/**
 * Agent Jobs CLI — admin operations for durable queue
 *
 * Usage:
 *   bun run scripts/agent-runner/jobs.ts list
 *   bun run scripts/agent-runner/jobs.ts list queued writer-agent
 *   bun run scripts/agent-runner/jobs.ts stats
 *   bun run scripts/agent-runner/jobs.ts events <job-id> [limit]
 *   bun run scripts/agent-runner/jobs.ts cancel <job-id>
 *   bun run scripts/agent-runner/jobs.ts retry <job-id>
 */
export {};

const RUNNER_URL = process.env.AGENT_RUNNER_URL ?? "http://localhost:3939";
const RUNNER_ADMIN_TOKEN = process.env.RUNNER_ADMIN_TOKEN ?? process.env.RUNNER_SECRET ?? "";

function authHeaders(): Record<string, string> {
  if (!RUNNER_ADMIN_TOKEN) {
    throw new Error("RUNNER_ADMIN_TOKEN (or RUNNER_SECRET) is required for jobs admin CLI.");
  }
  return { Authorization: `Bearer ${RUNNER_ADMIN_TOKEN}` };
}

async function listJobs(status?: string, agentId?: string): Promise<void> {
  const url = new URL(`${RUNNER_URL}/jobs`);
  if (status) url.searchParams.set("status", status);
  if (agentId) url.searchParams.set("agentId", agentId);
  url.searchParams.set("limit", "100");

  const res = await fetch(url, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const jobs = JSON.parse(text) as Array<{
    id: string;
    status: string;
    agent_id: string;
    task_id: string;
    attempts: number;
    max_attempts: number;
    last_error?: string | null;
    created_at: string;
  }>;

  if (jobs.length === 0) {
    console.log("No jobs found.");
    return;
  }

  for (const j of jobs) {
    console.log(
      `${j.id} | ${j.status.padEnd(11)} | agent=${j.agent_id.padEnd(14)} | task=${j.task_id.padEnd(14)} | attempts=${j.attempts}/${j.max_attempts} | created=${j.created_at}${j.last_error ? ` | err=${j.last_error}` : ""}`,
    );
  }
}

async function postAction(jobId: string, action: "cancel" | "retry"): Promise<void> {
  const res = await fetch(`${RUNNER_URL}/jobs/${jobId}/${action}`, {
    method: "POST",
    headers: authHeaders(),
  });
  const text = await res.text();

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  console.log(text);
}

async function showStats(): Promise<void> {
  const res = await fetch(`${RUNNER_URL}/stats`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(text);
}

async function listEvents(jobId: string, limit = 200): Promise<void> {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  const url = new URL(`${RUNNER_URL}/jobs/${jobId}/events`);
  url.searchParams.set("limit", String(safeLimit));

  const res = await fetch(url, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const events = JSON.parse(text) as Array<{
    id: string;
    event_type: string;
    payload_json: string;
    created_at: string;
  }>;

  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  for (const ev of events) {
    console.log(`${ev.created_at} | ${ev.event_type.padEnd(24)} | ${ev.payload_json}`);
  }
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);

  if (!cmd) {
    console.error(
      "Usage:\n  jobs.ts list [status] [agentId]\n  jobs.ts stats\n  jobs.ts events <job-id> [limit]\n  jobs.ts cancel <job-id>\n  jobs.ts retry <job-id>",
    );
    process.exit(1);
  }

  if (cmd === "list") {
    await listJobs(a, b);
    return;
  }

  if (cmd === "cancel") {
    if (!a) {
      console.error("Usage: jobs.ts cancel <job-id>");
      process.exit(1);
    }
    await postAction(a, "cancel");
    return;
  }

  if (cmd === "retry") {
    if (!a) {
      console.error("Usage: jobs.ts retry <job-id>");
      process.exit(1);
    }
    await postAction(a, "retry");
    return;
  }

  if (cmd === "stats") {
    await showStats();
    return;
  }

  if (cmd === "events") {
    if (!a) {
      console.error("Usage: jobs.ts events <job-id> [limit]");
      process.exit(1);
    }
    const limit = b ? Number(b) : 200;
    await listEvents(a, Number.isFinite(limit) ? limit : 200);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

await main();
