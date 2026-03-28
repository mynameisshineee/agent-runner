# BIKLabs Agent Runner — MCP Bidireccional + Durable Queue (Fase 1/2)

Cada agente usa su propio token MCP.
Modos:

- `spawn` (default): runner spawnea runtime directamente.
- `terminal` (BYO): terminales vivas reclaman jobs (`session-client`) y ejecutan en su propio TTY.

## Arquitectura

```
PM asigna a @WriterAgent
  │
  ▼ POST /webhook
Runner (localhost:3939)
  │
  ▼ Enqueue job durable (SQLite)
Worker loop (lease + retry + DLQ)
  │
  ▼ spawna Claude Code con --mcp-config
Claude Code (WriterAgent runtime)
  │
  ▼ MCP con token mcp_wr_*
PM Backend (devapi.biklabs.ai/mcp/sse)
  │
  ▼ PM sabe que es WriterAgent por el token
Ejecuta tarea → actualiza estado → cierra
```

## Setup

### 1. Generar tokens MCP por agente (backend)

Cada agente necesita su propio token MCP en el backend.
El token determina la identidad y permisos del agente.

```bash
# En el backend, crear tokens:
# POST /v1/mcp/tokens { agentId: "writer-agent", permissions: ["read", "write", "docs"] }
# POST /v1/mcp/tokens { agentId: "test-agent", permissions: ["read", "write"] }
# POST /v1/mcp/tokens { agentId: "deploy-agent", permissions: ["read"] }
```

### 2. Configurar env vars

```bash
export WRITER_AGENT_MCP_TOKEN="mcp_wr_xxxxxxxxxxxx"
export TEST_AGENT_MCP_TOKEN="mcp_te_xxxxxxxxxxxx"
export DEPLOY_AGENT_MCP_TOKEN="mcp_de_xxxxxxxxxxxx"
export RUNNER_SECRET="shared-secret-between-pm-and-runner"
export RUNNER_ADMIN_TOKEN="admin-token-for-runs-and-agents-endpoints" # opcional, default=RUNNER_SECRET
export RUN_TIMEOUT_MS="1800000" # opcional (30m)
export RUNNER_SKIP_PERMISSIONS="false" # en prod debe ser false
export RUNNER_DB_PATH="/tmp/biklabs-agent-runs/runner.db" # opcional
export QUEUE_POLL_INTERVAL_MS="1000" # opcional
export LEASE_MS="90000" # opcional
export MAX_ATTEMPTS_DEFAULT="3" # opcional
export MAX_QUEUE_DEPTH_PER_AGENT="20" # opcional
export RUNNER_EXECUTION_MODE="spawn" # spawn|terminal
export SESSION_TTL_MS="30000" # solo terminal mode
```

### 3. Arrancar el runner

```bash
bun run scripts/agent-runner/runner.ts
```

### 4. Probar dispatch manual

```bash
# Dispatch WriterAgent para tarea AIFW-18
bun run scripts/agent-runner/dispatch.ts writer-agent AIFW-18 019d320f-xxxx
```

`dispatch.ts` firma el webhook automáticamente con HMAC (headers `X-BIK-*`).

### 5. Integrar en el PM

```typescript
// src/lib/agent-dispatch.ts
import { createHmac, randomUUID } from "node:crypto";

function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export async function dispatchToAgent(params: {
  agentId: string;
  taskId: string;
  projectId: string;
}) {
  const payload = JSON.stringify({
    event: "task.assigned_to_agent",
    ...params,
  });
  const timestamp = String(Date.now());
  const signature = sign(process.env.RUNNER_SECRET!, timestamp, payload);

  return fetch("http://localhost:3939/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BIK-Timestamp": timestamp,
      "X-BIK-Event-Id": randomUUID(),
      "X-BIK-Signature": `sha256=${signature}`,
    },
    body: payload,
  });
}

// En el handler de asignacion:
if (isAgentAssignee(newAssignee)) {
  await dispatchToAgent({
    agentId: agentIdFromMember(newAssignee),
    taskId: workItem.id,
    projectId: workItem.projectId,
  });
}
```

## Endpoints

| Metodo | Path | Descripcion |
|--------|------|-------------|
| POST | /webhook | Dispatch agente (requiere firma HMAC en headers) |
| GET | /jobs | Jobs durables (requiere `Authorization: Bearer <RUNNER_ADMIN_TOKEN>`) |
| GET | /jobs/{id}/events | Historial de eventos del job (queued → leased → running → ...) |
| POST | /jobs/{id}/cancel | Cancela un job queued/leased/running (admin) |
| POST | /jobs/{id}/retry | Reencola un job failed/timed_out/dead_letter/cancelled (admin) |
| GET | /stats | Agregados de cola/runs por estado (admin) |
| GET | /runs | Runs activos (requiere `Authorization: Bearer <RUNNER_ADMIN_TOKEN>`) |
| GET | /agents | Agentes registrados, sin tokens (requiere `Authorization: Bearer <RUNNER_ADMIN_TOKEN>`) |
| GET | /sessions | Sesiones terminal activas (admin) |
| GET | /health | Health check |
| POST | /agent/session/heartbeat | Heartbeat de terminal agente (`Authorization: Bearer <RUNNER_SECRET>`) |
| POST | /agent/session/claim | Claim de job para esa terminal/agente |
| POST | /agent/session/jobs/{id}/start | Marca job en `running` desde terminal |
| POST | /agent/session/jobs/{id}/complete | Finaliza job desde terminal (success/fail) |

### `/jobs` query params

- `status`: `queued|leased|running|completed|failed|timed_out|cancelled|dead_letter`
- `status`: `queued|waiting_session|leased|running|completed|failed|timed_out|cancelled|dead_letter`
- `agentId`: filtra por agente
- `limit`: 1-500 (default 100)

## Archivos

```
scripts/agent-runner/
  runner.ts      — Servidor webhook + cola durable + runtime adapters
  dispatch.ts    — Cliente para disparar agentes (CLI + importable)
  jobs.ts        — CLI admin (list/cancel/retry de jobs)
  agents.json    — Registro de agentes (incluye `runtimeType`)
  README.md      — Este archivo
```

### CLI de operaciones de cola

```bash
# Listar jobs
RUNNER_ADMIN_TOKEN=... bun run scripts/agent-runner/jobs.ts list

# Filtrar
RUNNER_ADMIN_TOKEN=... bun run scripts/agent-runner/jobs.ts list queued writer-agent

# Stats
RUNNER_ADMIN_TOKEN=... bun run scripts/agent-runner/jobs.ts stats

# Timeline de eventos de un job
RUNNER_ADMIN_TOKEN=... bun run scripts/agent-runner/jobs.ts events <job-id> 200

# Cancelar / reintentar
RUNNER_ADMIN_TOKEN=... bun run scripts/agent-runner/jobs.ts cancel <job-id>
RUNNER_ADMIN_TOKEN=... bun run scripts/agent-runner/jobs.ts retry <job-id>
```

## Runtime adapters (Fase 2)

`agents.json` define `runtimeType` por agente:

- `claude_code` (default)
- `codex`
- `opencode` / `kiro` / `chat` vía **generic CLI adapter** (`runtimeCommand` + `runtimeArgs`)

Ejemplo:

```json
{
  "id": "writer-agent",
  "name": "WriterAgent",
  "runtimeType": "codex",
  "mcpToken": "${WRITER_AGENT_MCP_TOKEN}"
}
```

### Generic CLI adapter (para “todos los famosos”)

Para runtimes sin integración hardcoded, define por agente:

- `runtimeCommand`: binario a ejecutar
- `runtimeArgs`: args con placeholders opcionales
- `runtimeEnv`: env extra con placeholders
- `runtimePromptMode`: `arg` o `stdin`

Placeholders disponibles:

- `{PROMPT}`: prompt final del job
- `{WORKDIR}`: carpeta temporal del run
- `{MCP_URL}`: URL del servidor MCP
- `{MCP_CONFIG}`: ruta al `mcp.json` generado
- `{CLAUDE_MD}`: ruta al `CLAUDE.md` del run

Además, el runner exporta siempre:

- `BIK_PM_MCP_TOKEN`
- `BIK_PM_MCP_URL`

Ejemplo (runtime no hardcoded):

```json
{
  "id": "open-agent",
  "name": "OpenAgent",
  "runtimeType": "opencode",
  "runtimeCommand": "opencode",
  "runtimeArgs": ["run", "--cwd", "{WORKDIR}", "--mcp-config", "{MCP_CONFIG}", "{PROMPT}"],
  "runtimePromptMode": "arg",
  "runtimeEnv": {
    "APP_MODE": "agent"
  },
  "mcpToken": "${OPEN_AGENT_MCP_TOKEN}",
  "role": "Generalista",
  "systemPrompt": "Eres OpenAgent...",
  "permissions": ["read_data"],
  "maxTokensBudget": 50000
}
```

Nota: si el CLI concreto necesita stdin, usar:

```json
"runtimePromptMode": "stdin"
```

### Variables opcionales por runtime

```bash
export CLAUDE_BIN="claude"
export CODEX_BIN="codex"
export CODEX_SANDBOX_MODE="workspace-write"   # read-only|workspace-write|danger-full-access
export CODEX_MCP_SERVER_NAME="bik_pm"
export CODEX_MODEL=""                          # opcional
```

`codex` recibe la URL MCP y el bearer env var via `-c mcp_servers.*` en cada ejecución.
El token del agente se pasa como `BIK_PM_MCP_TOKEN`.

## Terminal-first mode (BYO, sin API Anthropic)

Cuando quieres que el usuario vea ejecución en su terminal:

1. Arranca runner en modo terminal:

```bash
RUNNER_EXECUTION_MODE=terminal \
RUNNER_SECRET=... \
RUNNER_ADMIN_TOKEN=... \
bun run scripts/agent-runner/runner.ts
```

2. Arranca una sesión por agente (en cada terminal):

```bash
AGENT_RUNNER_URL=http://localhost:3939 \
RUNNER_SECRET=... \
AGENT_ID=writer-agent \
AGENT_MCP_TOKEN=... \
bun run scripts/agent-runner/session-client.ts
```

Comportamiento:

- Si hay sesión viva -> `queued` -> `leased` -> `running` en esa terminal.
- Si no hay sesión viva al asignar -> `waiting_session` (estado visual recomendado: amarillo).

## Produccion

Para produccion (sin maquina local):
1. Runner como servicio en ECS/Lambda
2. Claude API (Bedrock) en vez de Claude Code CLI
3. Tokens MCP almacenados en Secrets Manager
4. SQS entre PM y Runner para garantia de entrega
5. CloudWatch para logs de ejecucion de agentes

## Semántica de cola (Fase 1)

- `webhook` encola `agent_job` con `event_id` único (idempotencia)
- Worker hace claim con `lease` y ejecuta
- Si falla/timeout: requeue con backoff (30s, 2m, 10m, 30m)
- Si excede reintentos: `dead_letter`
- En reinicio del runner: jobs `leased/running` se recuperan a `queued`
