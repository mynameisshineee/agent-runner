# BIKLabs Agent Runner — Quality Gates (Release Standard)

**Version**: v1.1  
**Date**: 2026-03-28  
**Scope**: `scripts/agent-runner/*`

---

## 1) Non-Negotiable Gates

1. **Security gate**
- Webhook must require signed headers (`X-BIK-Timestamp`, `X-BIK-Event-Id`, `X-BIK-Signature`).
- Signature must bind **timestamp + eventId + body**.
- Secrets are never accepted in JSON body.
- Admin auth must use bearer token and constant-time comparison.
- Session identity must be derived from a unique per-agent runner token; a body `agentId` mismatch is `403`.

2. **Durability gate**
- Assignment accepted only after durable insert into `agent_jobs`.
- Worker restarts must recover `leased/running` jobs and increment their lease generation.
- Stale terminal `leased/running` jobs must be automatically recovered and old generations fenced.

3. **Correctness gate**
- Terminal job transitions are conditional (`leased -> running`, `running -> completed`) on agent, owner session, generation, and an unexpired lease.
- A partial unique index must enforce at most one `leased|running` job per agent.
- Duplicate active execution for same `run_key` (`agentId:taskId`) is rejected.
- Idempotency by `event_id` is enforced.

4. **Operational gate**
- `/health`, `/stats`, `/jobs`, `/jobs/:id/events` must provide enough information to debug incidents without attaching a debugger.
- Cancel and retry endpoints must be available under admin auth.

5. **Terminal-first gate**
- In `RUNNER_EXECUTION_MODE=terminal`, offline agent must produce `waiting_session`.
- Session heartbeat requeues waiting work when agent comes online.
- An active-job heartbeat renews only the matching owner/generation and never revives an expired lease.
- Session client must execute in visible TTY and report start/complete explicitly.

---

## 2) API Contract Checks

## `/webhook` (POST)
- Reject missing signature headers (`401`).
- Reject invalid signature (`401`).
- Reject stale timestamp (`401`).
- Reject payload too large (`413`), default cap `64 KiB`.
- Accept valid signed request (`202`).

## `/agent/session/*`
- Must require a per-agent runner credential in the default mode.
- Must validate `sessionId` and `agentId` format.
- `claim` only enabled in terminal mode.
- `start` requires job in `leased`.
- successful `complete` requires job in `running`.
- `start`, `complete`, and `control` require the current `leaseGeneration` and owner session.

---

## 3) Security Checklist

- [ ] `RUNNER_SECRET` set and rotated.
- [ ] `RUNNER_ADMIN_TOKEN` separate from `RUNNER_SECRET` in production.
- [ ] Per-agent runner tokens are unique, non-empty, rotated, and separate from MCP tokens.
- [ ] `AGENT_SESSION_AUTH_MODE=agent-token`.
- [ ] `RUNNER_SKIP_PERMISSIONS=false` in production.
- [ ] Log scrubber policy ensures no MCP token appears in logs.
- [ ] Runtime hosts run with least privilege filesystem/network.

---

## 4) Reliability Checklist

- [ ] Queue depth alarm per agent.
- [ ] Dead-letter alarm (absolute + percentage).
- [ ] p95 start latency alarm.
- [ ] p95 run duration alarm.
- [ ] Retry storm alarm.

---

## 5) SLO Baseline

- **Durable enqueue success**: 99.9%
- **Assignment->running p95**: < 30s (online agents)
- **Dead-letter ratio**: < 2% weekly
- **Control-plane API availability**: 99.9%

---

## 6) Release Go/No-Go

Release is **GO** only if:
- Typecheck passes.
- Security gate + durability gate pass in smoke environment.
- One full terminal-mode flow is validated end-to-end with event timeline.
- The black-box fencing test passes identity spoof, 20-way claim race, WIP=1, expiry, heartbeat, and restart arms.
- CTO signoff on queue backend and token rotation policy.
