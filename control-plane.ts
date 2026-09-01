import { randomUUID } from "node:crypto";

export interface SessionIdentity {
  sessionId: string;
  agentId: string;
  label?: string;
  host?: string;
  runtimeType?: string;
}

export interface ClaimedControlJob {
  id: string; // control-plane job id
  leaseGeneration?: number;
  taskId: string;
  projectId: string;
  taskTitle?: string | null;
  taskType?: string | null;
  payload?: Record<string, unknown>;
}

export interface ControlPlaneClient {
  mode: "runner" | "generic";
  heartbeat(session: SessionIdentity): Promise<void>;
  claim(session: SessionIdentity): Promise<ClaimedControlJob | null>;
  markStart(jobId: string, session: SessionIdentity, pid: number | null): Promise<void>;
  markComplete(
    jobId: string,
    session: SessionIdentity,
    result: { exitCode: number | null; timedOut: boolean; error: string | null; summary?: string | null },
  ): Promise<void>;
  getControl(jobId: string, session: SessionIdentity): Promise<{ shouldCancel: boolean; status?: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<T>(
  url: string,
  bearer: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} (${res.status}): ${text.slice(0, 250)}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, bearer: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${bearer}`,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} (${res.status}): ${text.slice(0, 250)}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

class RunnerControlPlaneClient implements ControlPlaneClient {
  mode: "runner" = "runner";
  private activeLease: { jobId: string; leaseGeneration: number } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly agentToken: string,
    private readonly timeoutMs: number,
  ) {}

  async heartbeat(session: SessionIdentity): Promise<void> {
    const lease = this.activeLease;
    await postJson(
      `${this.baseUrl}/agent/session/heartbeat`,
      this.agentToken,
      {
        ...session,
        ...(lease
          ? { activeJobId: lease.jobId, leaseGeneration: lease.leaseGeneration }
          : {}),
      },
      this.timeoutMs,
    );
  }

  async claim(session: SessionIdentity): Promise<ClaimedControlJob | null> {
    type ClaimResponse = {
      ok: boolean;
      job: null | {
        id: string;
        leaseGeneration: number;
        taskId: string;
        projectId: string;
        taskTitle?: string | null;
        taskType?: string | null;
        payload?: Record<string, unknown>;
      };
    };
    const out = await postJson<ClaimResponse>(
      `${this.baseUrl}/agent/session/claim`,
      this.agentToken,
      session,
      this.timeoutMs,
    );
    if (!out.job) return null;
    if (!Number.isInteger(out.job.leaseGeneration) || out.job.leaseGeneration < 1) {
      throw new Error(`runner returned invalid leaseGeneration for job ${out.job.id}`);
    }
    this.activeLease = {
      jobId: out.job.id,
      leaseGeneration: out.job.leaseGeneration,
    };
    return out.job;
  }

  private leaseGenerationFor(jobId: string): number {
    if (!this.activeLease || this.activeLease.jobId !== jobId) {
      throw new Error(`no active lease for runner job ${jobId}`);
    }
    return this.activeLease.leaseGeneration;
  }

  async markStart(jobId: string, session: SessionIdentity, pid: number | null): Promise<void> {
    const leaseGeneration = this.leaseGenerationFor(jobId);
    await postJson(
      `${this.baseUrl}/agent/session/jobs/${jobId}/start`,
      this.agentToken,
      { ...session, leaseGeneration, pid },
      this.timeoutMs,
    );
  }

  async markComplete(
    jobId: string,
    session: SessionIdentity,
    result: { exitCode: number | null; timedOut: boolean; error: string | null; summary?: string | null },
  ): Promise<void> {
    const leaseGeneration = this.leaseGenerationFor(jobId);
    await postJson(
      `${this.baseUrl}/agent/session/jobs/${jobId}/complete`,
      this.agentToken,
      {
        ...session,
        leaseGeneration,
        ...result,
      },
      this.timeoutMs,
    );
    this.activeLease = null;
  }

  async getControl(jobId: string, session: SessionIdentity): Promise<{ shouldCancel: boolean; status?: string }> {
    type ControlResponse = { ok: boolean; shouldCancel: boolean; status?: string };
    const leaseGeneration = this.leaseGenerationFor(jobId);
    const out = await postJson<ControlResponse>(
      `${this.baseUrl}/agent/session/jobs/${jobId}/control`,
      this.agentToken,
      { ...session, leaseGeneration },
      this.timeoutMs,
    );
    return { shouldCancel: !!out.shouldCancel, status: out.status };
  }
}

class GenericControlPlaneClient implements ControlPlaneClient {
  mode: "generic" = "generic";
  private activeLease: { jobId: string; leaseGeneration: number } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  async heartbeat(session: SessionIdentity): Promise<void> {
    const lease = this.activeLease;
    await postJson(
      `${this.baseUrl}/v1/agent-control/sessions/heartbeat`,
      this.token,
      {
        ...session,
        ...(lease
          ? { activeJobId: lease.jobId, leaseGeneration: lease.leaseGeneration }
          : {}),
      },
      this.timeoutMs,
    );
  }

  async claim(session: SessionIdentity): Promise<ClaimedControlJob | null> {
    type ClaimResponse = { job: ClaimedControlJob | null };
    const out = await postJson<ClaimResponse>(
      `${this.baseUrl}/v1/agent-control/claims/next`,
      this.token,
      session,
      this.timeoutMs,
    );
    if (out.job?.leaseGeneration != null) {
      this.activeLease = {
        jobId: out.job.id,
        leaseGeneration: out.job.leaseGeneration,
      };
    }
    return out.job ?? null;
  }

  async markStart(jobId: string, session: SessionIdentity, pid: number | null): Promise<void> {
    const leaseGeneration = this.activeLease?.jobId === jobId
      ? this.activeLease.leaseGeneration
      : undefined;
    await postJson(
      `${this.baseUrl}/v1/agent-control/jobs/${jobId}/start`,
      this.token,
      { ...session, ...(leaseGeneration == null ? {} : { leaseGeneration }), pid },
      this.timeoutMs,
    );
  }

  async markComplete(
    jobId: string,
    session: SessionIdentity,
    result: { exitCode: number | null; timedOut: boolean; error: string | null; summary?: string | null },
  ): Promise<void> {
    const leaseGeneration = this.activeLease?.jobId === jobId
      ? this.activeLease.leaseGeneration
      : undefined;
    await postJson(
      `${this.baseUrl}/v1/agent-control/jobs/${jobId}/complete`,
      this.token,
      { ...session, ...(leaseGeneration == null ? {} : { leaseGeneration }), ...result },
      this.timeoutMs,
    );
    if (this.activeLease?.jobId === jobId) this.activeLease = null;
  }

  async getControl(jobId: string, session: SessionIdentity): Promise<{ shouldCancel: boolean; status?: string }> {
    type ControlResponse = { shouldCancel: boolean; status?: string };
    const url = new URL(`${this.baseUrl}/v1/agent-control/jobs/${jobId}/control`);
    url.searchParams.set("sessionId", session.sessionId);
    url.searchParams.set("agentId", session.agentId);
    if (this.activeLease?.jobId === jobId) {
      url.searchParams.set("leaseGeneration", String(this.activeLease.leaseGeneration));
    }
    const out = await getJson<ControlResponse>(
      url.toString(),
      this.token,
      this.timeoutMs,
    );
    return { shouldCancel: !!out.shouldCancel, status: out.status };
  }
}

export function resolveControlPlaneClient(): ControlPlaneClient | null {
  const timeoutMs = parseInt(process.env.BIK_CONTROL_HTTP_TIMEOUT_MS ?? "10000", 10);

  const runnerUrl = process.env.AGENT_RUNNER_URL ?? "";
  const runnerAgentToken = process.env.BIK_AGENT_TOKEN ?? process.env.AGENT_MCP_TOKEN ?? "";
  if (runnerUrl && runnerAgentToken) {
    return new RunnerControlPlaneClient(runnerUrl.replace(/\/+$/, ""), runnerAgentToken, timeoutMs);
  }

  const cpUrl = process.env.BIK_CONTROL_PLANE_URL ?? "";
  const cpToken = process.env.BIK_CONTROL_PLANE_TOKEN ?? "";
  if (cpUrl && cpToken) {
    return new GenericControlPlaneClient(cpUrl.replace(/\/+$/, ""), cpToken, timeoutMs);
  }

  return null;
}

export function buildSessionIdentity(agentId: string, runtimeType: string): SessionIdentity {
  return {
    sessionId: process.env.BIK_AGENT_SESSION_ID ?? randomUUID(),
    agentId,
    label: process.env.BIK_AGENT_SESSION_LABEL ?? `${agentId}-terminal`,
    host: process.env.BIK_AGENT_SESSION_HOST ?? process.env.HOSTNAME ?? "local-terminal",
    runtimeType,
  };
}

export async function runHeartbeatLoop(
  client: ControlPlaneClient,
  session: SessionIdentity,
  intervalMs: number,
  onError?: (err: unknown) => void,
): Promise<never> {
  for (;;) {
    try {
      await client.heartbeat(session);
    } catch (err) {
      if (onError) onError(err);
    }
    await sleep(intervalMs);
  }
}
