/**
 * Agent Dispatch — call from PM when assigning a task to an agent
 *
 * Usage from PM code:
 *   import { dispatchToAgent } from "@/lib/agent-dispatch"
 *   await dispatchToAgent({ agentId: "writer-agent", taskId, projectId })
 *
 * Or from CLI:
 *   bun run scripts/agent-runner/dispatch.ts writer-agent AIFW-18 proj-123
 */

import { createHmac, randomUUID } from "node:crypto";

const RUNNER_URL = process.env.AGENT_RUNNER_URL ?? "http://localhost:3939";
const RUNNER_SECRET = process.env.RUNNER_SECRET ?? "";

interface DispatchParams {
  agentId: string;
  taskId: string;
  projectId: string;
  taskTitle?: string;
  taskType?: string;
}

function buildSignature(timestamp: string, body: string): string {
  return createHmac("sha256", RUNNER_SECRET).update(`${timestamp}.${body}`).digest("hex");
}

export async function dispatchToAgent(
  params: DispatchParams,
): Promise<{ accepted: boolean; pid?: number; error?: string }> {
  if (!RUNNER_SECRET) {
    return {
      accepted: false,
      error: "RUNNER_SECRET is required for signed webhook dispatch.",
    };
  }

  const payload = {
    event: "task.assigned_to_agent" as const,
    ...params,
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = buildSignature(timestamp, body);

  try {
    const res = await fetch(`${RUNNER_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BIK-Timestamp": timestamp,
        "X-BIK-Event-Id": randomUUID(),
        "X-BIK-Signature": `sha256=${signature}`,
      },
      body,
    });

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return {
        accepted: false,
        error: `Runner returned non-JSON response (${res.status}): ${text.slice(0, 200)}`,
      };
    }
  } catch (err) {
    return { accepted: false, error: `Runner not reachable: ${err}` };
  }
}

// CLI mode
if (import.meta.main) {
  const [agentId, taskId, projectId] = process.argv.slice(2);

  if (!agentId || !taskId || !projectId) {
    console.error("Usage: bun dispatch.ts <agent-id> <task-id> <project-id>");
    console.error("Example: bun dispatch.ts writer-agent AIFW-18 019d320f-d990-...");
    process.exit(1);
  }

  const result = await dispatchToAgent({ agentId, taskId, projectId });
  console.log(JSON.stringify(result, null, 2));
}
