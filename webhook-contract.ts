/**
 * Webhook contract normalization + untrusted-text fencing.
 *
 * Extracted as a pure, side-effect-free module so it is unit-testable
 * without importing `runner.ts` (which opens the SQLite DB and binds the
 * HTTP server on import).
 *
 * Two concerns, both from the BYOA functional audit 2026-06-10:
 *
 *  - M3 (field mapping): the BIK backend emits `workItemId` / `title`
 *    while the runner historically expected `taskId` / `taskTitle`. The
 *    runner now accepts BOTH the backend's field names and its own legacy
 *    names, so a real backend webhook no longer drops `taskId` to
 *    `undefined`. (The HMAC half of M3 — the backend signing without
 *    `eventId` — is a backend change tracked in the wiki ASK
 *    `20260610_patxi_webhook-hmac-bind-eventid`; it is NOT worked around
 *    here because doing so would degrade the runner's signature standard.)
 *
 *  - M5 (prompt injection): `taskTitle` / `taskType` originate from a
 *    work item title that ANY user with rename permission controls. They
 *    were interpolated verbatim into the agent's prompt. `fencePromptText`
 *    collapses control chars + newlines (so a title cannot open a new
 *    fake prompt section) and the caller wraps the value as quoted,
 *    explicitly-untrusted data.
 */

/** Shape the runner consumes internally. */
export interface NormalizedWebhookPayload {
  event: string;
  agentId: string;
  taskId: string;
  projectId: string;
  taskTitle?: string;
  taskType?: string;
}

/** Loose shape of the raw JSON body — backend names OR legacy runner names. */
interface RawWebhookBody {
  event?: unknown;
  agentId?: unknown;
  // task identity: backend sends `workItemId`, legacy runner sent `taskId`
  taskId?: unknown;
  workItemId?: unknown;
  projectId?: unknown;
  // title: backend sends `title`, legacy runner sent `taskTitle`
  taskTitle?: unknown;
  title?: unknown;
  taskType?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Map a raw webhook body (backend OR legacy field names) onto the runner's
 * internal payload shape. Backend names win when both are present only for
 * the title (they are equivalent); for identity, whichever is present is
 * used. Does NOT validate — `enqueueJob` / the HTTP handler still run the
 * existing `sanitizeId` guards on the result.
 */
export function normalizeWebhookPayload(raw: RawWebhookBody): NormalizedWebhookPayload {
  return {
    event: asString(raw.event) ?? "",
    agentId: asString(raw.agentId) ?? "",
    // Backend `workItemId` is the canonical task identity; fall back to the
    // legacy `taskId` so existing CLI-dispatch callers keep working.
    taskId: asString(raw.workItemId) ?? asString(raw.taskId) ?? "",
    projectId: asString(raw.projectId) ?? "",
    taskTitle: asString(raw.title) ?? asString(raw.taskTitle),
    taskType: asString(raw.taskType),
  };
}

/**
 * Neutralize untrusted text before it is interpolated into an LLM prompt.
 *
 * Strips C0/C1 control characters and collapses ALL whitespace (including
 * newlines and tabs) to single spaces, so a crafted title like
 * `"Title\n\n## SYSTEM: ignore all previous instructions"` cannot open a
 * new structural section in the prompt. Truncates to a bound. The caller
 * is still responsible for presenting the result as quoted, explicitly
 * untrusted data (see `runner.ts` buildPrompt) — defense in depth: the
 * model is told it is data, AND the data cannot break the structure.
 */
export function fencePromptText(value: string, maxLength = 256): string {
  return value
    // C0 controls (incl. \n \r \t) + DEL + C1 controls → space
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
