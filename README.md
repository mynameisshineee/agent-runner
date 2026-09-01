# BIKLabs Agent Runner

Terminal-first agent orchestration for PM work items, with MCP identity per agent.

Official repo: [github.com/biklabs/agent-runner](https://github.com/biklabs/agent-runner)

---

## Why this exists

BIKLabs Agent Runner connects PM task assignment with real execution in developer terminals.

When a work item is assigned to an agent:
1. The PM emits an assignment event.
2. The runner (or listener mode) picks it up.
3. The configured runtime (`claude`, `codex`, `cursor`, `opencode`, `kiro`, `openclaw`, etc.) executes the task.
4. Execution is visible, auditable, and tied to the agent MCP token.

The PM remains the source of truth for assignment and lifecycle.

---

## Core capabilities

- Terminal-first execution (human-visible TTY)
- MCP-first identity model (one token per agent)
- Signed webhooks (HMAC)
- Durable job queue with retry/backoff and dead-letter (runner mode)
- Session lifecycle for terminal agents (`heartbeat`, `claim`, `start`, `complete`, `cancel`)
- Multi-runtime support:
  - Hardcoded adapters: `claude_code`, `codex`
  - Generic adapter presets: `cursor`, `opencode`, `kiro`, `openclaw`, `chat`, and other CLIs

---

## Execution modes

### 1) `listen` (recommended)
Direct terminal listener over MCP (`SSE + polling fallback`).

- Best for BYO runtime and “I want to see what my agent is doing”.
- Minimal local infrastructure.

### 2) `spawn` (runner default)
Runner receives webhooks and spawns runtimes directly.

- Useful for centralized infra or controlled environments.

### 3) `terminal` (runner + session clients)
Runner manages durable queue; local terminal sessions claim and execute jobs.

- Best when you want both queue guarantees and live terminal visibility.

---

## Quick start

If you cloned `biklabs/agent-runner`, run commands from that repo root.
If you are in the monorepo, prepend `scripts/agent-runner/` to file paths.

## A. Listener-only flow (recommended)

```bash
# 1) local setup wizard
bun run bik-agent.ts init

# 2) validate setup
bun run bik-agent.ts doctor

# 3) start listening from terminal
bun run bik-agent.ts listen

# 4) optional: quick status
bun run bik-agent.ts status

# 5) print canonical runtime presets (JSON)
bun run bik-agent.ts presets

# 6) run compatibility smoke matrix
bun run bik-agent.ts matrix
```

Required env for listener:

```bash
export BIK_AGENT_ID="writer-agent"
export BIK_AGENT_TOKEN="mcp_wr_..."
export BIK_MCP_URL="https://devapi.biklabs.ai/v1/mcp"
export BIK_RUNTIME_TYPE="claude_code"   # claude_code|codex|cursor|opencode|kiro|openclaw|chat
export BIK_LISTEN_MODE="auto"           # auto|sse|poll
export BIK_WORK_DIR="$PWD"
```

Optional control-plane env (recommended for robust lifecycle):

```bash
export AGENT_RUNNER_URL="http://localhost:3939"
export BIK_AGENT_TOKEN="runner_writer_..." # per-agent runner credential
export BIK_HEARTBEAT_INTERVAL_MS="10000"
export BIK_CLAIM_INTERVAL_MS="2000"
export BIK_CONTROL_CANCEL_POLL_MS="1500"
```

## B. Runner flow (queue + admin endpoints)

```bash
export WRITER_AGENT_MCP_TOKEN="mcp_wr_xxx"
export TEST_AGENT_MCP_TOKEN="mcp_te_xxx"
export DEPLOY_AGENT_MCP_TOKEN="mcp_de_xxx"
export WRITER_AGENT_RUNNER_TOKEN="runner_wr_xxx"
export TEST_AGENT_RUNNER_TOKEN="runner_te_xxx"
export DEPLOY_AGENT_RUNNER_TOKEN="runner_de_xxx"
export RUNNER_SECRET="shared-secret"
export RUNNER_ADMIN_TOKEN="admin-token"

bun run runner.ts
```

Dispatch a test assignment:

```bash
bun run dispatch.ts writer-agent TASK-123 proj-abc
```

Inspect queue:

```bash
RUNNER_ADMIN_TOKEN=... bun run jobs.ts stats
RUNNER_ADMIN_TOKEN=... bun run jobs.ts list
RUNNER_ADMIN_TOKEN=... bun run jobs.ts events <job-id> 200
```

---

## Runtime adapters

`agents.json` supports per-agent runtime config.

### Built-in adapters
- `claude_code`
- `codex`

### Generic adapter (all other CLIs)
Use these fields per agent:
- `runtimeCommand`
- `runtimeArgs`
- `runtimeEnv`
- `runtimePromptMode` (`arg` or `stdin`)

Placeholders available:
- `{PROMPT}`
- `{WORKDIR}`
- `{MCP_URL}`
- `{MCP_CONFIG}`
- `{CLAUDE_MD}`

Always injected:
- `BIK_PM_MCP_TOKEN`
- `BIK_PM_MCP_URL`

If `runtimeCommand` is missing, defaults are used:
- `cursor` -> `${CURSOR_BIN:-cursor-agent}`
- `opencode` -> `opencode`
- `kiro` -> `kiro`
- `openclaw` -> `openclaw`
- `chat` -> `chat-runtime`

If `runtimeArgs` is missing, default is `[{PROMPT}]`.

Example (`openclaw`):

```json
{
  "id": "openclaw-agent",
  "name": "OpenClawAgent",
  "runtimeType": "openclaw",
  "runtimeCommand": "openclaw",
  "runtimeArgs": ["run", "--cwd", "{WORKDIR}", "--mcp-config", "{MCP_CONFIG}"],
  "runtimePromptMode": "stdin",
  "runtimeEnv": {
    "OPENCLAW_MODE": "agent"
  },
  "mcpToken": "${OPENCLAW_AGENT_MCP_TOKEN}",
  "role": "Generalist",
  "systemPrompt": "You are OpenClawAgent...",
  "permissions": ["read_data", "update_entity"],
  "maxTokensBudget": 80000
}
```

Optional runtime env:

```bash
export CLAUDE_BIN="claude"
export CODEX_BIN="codex"
export CURSOR_BIN="cursor-agent"
export CODEX_SANDBOX_MODE="workspace-write"  # read-only|workspace-write|danger-full-access
export CODEX_MCP_SERVER_NAME="bik_pm"
export CODEX_MODEL=""

# global fallback for generic adapter
export AGENT_RUNTIME_COMMAND=""
export AGENT_RUNTIME_ARGS=""
export AGENT_RUNTIME_ARGS_JSON='[]'           # preferred over AGENT_RUNTIME_ARGS
export AGENT_RUNTIME_PROMPT_MODE="arg"       # arg|stdin
```

### Compatibility smoke matrix

Run local runtime probes:

```bash
bun run smoke-matrix.ts
```

Strict mode (CI):

```bash
SMOKE_STRICT=1 bun run smoke-matrix.ts
```

Filter runtimes:

```bash
SMOKE_RUNTIME_TYPES="claude_code,codex,cursor,openclaw" bun run smoke-matrix.ts
```

---

## HTTP API (runner)

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhook` | Enqueue signed assignment event |
| GET | `/jobs` | List durable jobs (admin) |
| GET | `/jobs/{id}/events` | Job timeline (admin) |
| POST | `/jobs/{id}/cancel` | Cancel queued/leased/running job (admin) |
| POST | `/jobs/{id}/retry` | Retry failed/timed_out/dead_letter/cancelled job (admin) |
| GET | `/stats` | Queue/run aggregates (admin) |
| GET | `/runs` | Active runs (admin) |
| GET | `/agents` | Registered agents without tokens (admin) |
| GET | `/sessions` | Active terminal sessions (admin) |
| GET | `/health` | Health check |
| POST | `/agent/session/heartbeat` | Terminal session heartbeat |
| POST | `/agent/session/claim` | Claim next job for session agent |
| POST | `/agent/session/jobs/{id}/start` | Mark job running from terminal |
| POST | `/agent/session/jobs/{id}/complete` | Mark terminal completion |
| POST | `/agent/session/jobs/{id}/control` | Send control signal (e.g., cooperative cancel) |

`/jobs` filters:
- `status`: `queued|waiting_session|leased|running|completed|failed|timed_out|cancelled|dead_letter`
- `agentId`
- `limit` (1-500, default 100)

---

## Security notes

- Keep webhook, admin, per-agent runner, and MCP credentials in a secret manager.
- Terminal session identity is derived from each agent's runner credential. `agentId` in JSON is only an assertion; a mismatch is rejected.
- Prefer distinct `*_AGENT_RUNNER_TOKEN` values. Falling back to the MCP token exists for migration only.
- Keep `AGENT_SESSION_AUTH_MODE=agent-token` (the default). `shared-secret` is an explicit legacy compatibility mode, not a production setting.
- Use `RUNNER_ADMIN_TOKEN` different from `RUNNER_SECRET` in production.
- Keep `RUNNER_SKIP_PERMISSIONS=false` in production.
- Restrict network exposure of runner/admin endpoints.

Terminal claims enforce one active job per agent in SQLite. Every claim receives a monotonically increasing `leaseGeneration`; `start`, `complete`, `control`, and active-job heartbeats must present the same owner session and generation before the lease expires. Expiry or restart requeues the job and increments the generation, fencing the old worker.

---

## Operational model (recommended for production)

1. PM backend as single source of truth for jobs/runs/retries/audit.
2. Local CLI (`listen`) for BYO runtime execution in user terminals.
3. Use runner queue mainly for controlled infra or debug-heavy environments.

---

## Repo files

- `bik-agent.ts` — unified CLI (`init|doctor|status|listen`)
- `runner.ts` — webhook server + durable queue + runtime orchestration
- `listen.ts` — MCP-first terminal listener
- `session-client.ts` — queue-backed terminal worker
- `dispatch.ts` — signed assignment dispatcher
- `jobs.ts` — queue admin CLI
- `mcp-runtime.ts` — runtime/MCP shared helpers
- `validate.ts` — static config validator
- `runtime-presets.ts` — canonical runtime presets (commands/args/env checks)
- `smoke-matrix.ts` — compatibility smoke tests (binary/version/probe)
- `COMPATIBILITY_MATRIX.md` — published support matrix by runtime
- `RUNTIME_PROFILES.md` — runtime config templates
- `QUALITY_GATES.md` — release checklist

---

## Español (resumen rápido)

- **Objetivo:** asignas una tarea en PM y un agente la ejecuta en terminal con su token MCP.
- **Modo recomendado:** `listen` (terminal viva + ejecución visible).
- **Modo robusto con cola:** `runner` + `terminal sessions` (`session-client`).
- **Runtimes soportados:** `claude_code`, `codex`, `cursor`, y adaptador genérico para `opencode`, `kiro`, `openclaw`, `chat`.
- **Seguridad:** webhook firmado, tokens por agente, endpoints admin protegidos.

Si necesitas el setup completo en castellano paso a paso, usa esta misma guía y los comandos tal cual.
