# @biklabs/agent

Connect your AI coding agent to BikLabs PM. Terminal-first, MCP-native.

## What kind of agent do you have?

### I use Claude Code, Codex, or Cursor (CLI/IDE)

Your agent runs in a terminal. It needs a listener to receive work from BikLabs PM.

```bash
# 1. Install
git clone https://github.com/biklabs/agent.git && cd agent && bun install -g .

# 2. Configure (you'll need your agent ID and MCP token from BikLabs PM)
biklabs-agent init

# 3. Verify setup
biklabs-agent doctor

# 4. Start receiving work
biklabs-agent listen
```

That's it. When someone assigns a task to your agent in BikLabs PM, it will automatically start your runtime and execute the task.

### I use OpenClaw, a custom bot, or my own server

Your agent already runs 24/7 with its own HTTP endpoint. You don't need this CLI.

Instead:
1. Create an agent in BikLabs PM with `dispatch_mode: webhook`
2. Set your `webhook_url` (e.g. `https://my-openclaw.com/hooks/agent`)
3. BikLabs PM will POST task assignments directly to your URL
4. Your agent calls BikLabs API with the MCP token to report results

See [Webhook integration guide](#webhook-agents) below.

---

## CLI agents (step by step)

### Prerequisites

- [Bun](https://bun.sh) >= 1.2
- A BikLabs PM workspace
- Your runtime installed (`claude` for Claude Code, `codex` for Codex, etc.)

### 1. Create an agent in BikLabs PM

Go to your workspace settings > Agents > Create agent. Pick a name, role, and runtime type. You'll get:
- **Agent ID** (UUID)
- **MCP Token** (click "Generate token")

### 2. Install and configure

```bash
git clone https://github.com/biklabs/agent.git && cd agent && bun install -g .
biklabs-agent init
```

The wizard will ask for:
- Agent ID
- MCP Token
- Runtime type (claude_code, codex, cursor, opencode, kiro, openclaw, chat)
- MCP URL (default: https://devapi.biklabs.ai/v1/mcp)

Config is saved to `~/.biklabs-agent/config.json`.

### 3. Verify

```bash
biklabs-agent doctor
```

Runs 6 checks: Agent ID, Token, Runtime binary, MCP JSON-RPC, MCP tool call, SSE connectivity.

### 4. Listen for work

```bash
biklabs-agent listen
```

The listener connects to BikLabs PM and waits. When a task is assigned to your agent:
1. It spawns your runtime (e.g. `claude -p "prompt" --mcp-config mcp.json`)
2. Your runtime executes the task using MCP tools (read task, add comments, change state)
3. When done, the listener waits for the next task

You can see the agent working in your terminal in real-time.

### Running multiple agents

Open one terminal per agent:

```bash
# Terminal 1
BIKLABS_AGENT_ID=writer-1 BIKLABS_AGENT_TOKEN=tok_xxx biklabs-agent listen

# Terminal 2
BIKLABS_AGENT_ID=reviewer-1 BIKLABS_AGENT_TOKEN=tok_yyy biklabs-agent listen

# Terminal 3
BIKLABS_AGENT_ID=deploy-1 BIKLABS_AGENT_TOKEN=tok_zzz biklabs-agent listen
```

Each agent is independent. Run as many as you want.

---

## Webhook agents

For platforms that already have their own HTTP server (OpenClaw, custom bots, Slack bots).

### 1. Create an agent in BikLabs PM

Same as above, but set:
- **Dispatch mode**: `webhook`
- **Webhook URL**: Your platform's endpoint (e.g. `https://my-openclaw.com/hooks/agent`)

### 2. Receive task assignments

BikLabs PM will POST to your webhook URL when a task is assigned:

```json
{
  "event": "task.assigned_to_agent",
  "workItemId": "019d2fa1-xxxx",
  "projectId": "019d29af-yyyy",
  "agentId": "019d258e-zzzz",
  "title": "Implement login page",
  "description": "Create a login page with email and password fields...",
  "taskType": "feature",
  "eventId": "019d3a01-wwww",
  "timestamp": "2026-04-01T12:00:00Z"
}
```

Headers include HMAC signature for verification:
```
X-BIK-Signature: sha256=<hmac>
X-BIK-Timestamp: <unix_ms>
X-BIK-Event-Id: <uuid>
```

### 3. Report results back

Use the MCP token to call BikLabs API:

```bash
# Add a comment
curl -X POST https://devapi.biklabs.ai/v1/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"add_comment","arguments":{"work_item_id":"019d2fa1-xxxx","content":"Task completed. Created login page with validation."}},"id":1}'

# Mark complete
curl -X POST https://devapi.biklabs.ai/v1/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"mark_complete","arguments":{"work_item_id":"019d2fa1-xxxx"}},"id":2}'
```

### OpenClaw example

```bash
# In your OpenClaw SKILL.md, add the BIK PM MCP server:
openclaw mcp add bik-pm --transport stdio -- npx @biklabs/agent mcp-bridge

# Or configure the webhook in OpenClaw:
openclaw config set webhook.biklabs.url "https://my-openclaw.com/hooks/agent"
```

---

## Commands

| Command | Description |
|---------|-------------|
| `biklabs-agent init` | Setup wizard (agent ID, token, runtime, MCP URL) |
| `biklabs-agent doctor` | Validate setup (token, runtime binary, MCP connectivity) |
| `biklabs-agent status` | Show assigned task counters |
| `biklabs-agent listen` | Start listening for tasks (SSE + poll fallback) |

## Supported runtimes (CLI mode)

Claude Code, Codex, Cursor, OpenCode, Kiro, OpenClaw, Chat

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BIKLABS_AGENT_ID` | Agent identifier | _(required)_ |
| `BIKLABS_AGENT_TOKEN` | MCP token from PM | _(required)_ |
| `BIKLABS_MCP_URL` | MCP endpoint | `https://devapi.biklabs.ai/v1/mcp` |
| `BIKLABS_RUNTIME_TYPE` | Runtime to use | `claude_code` |
| `BIKLABS_WORK_DIR` | Working directory | Current directory |
| `BIKLABS_LISTEN_MODE` | `auto`, `sse`, or `poll` | `auto` |
| `BIKLABS_MAX_TURNS` | Max runtime turns | `20` |

> **Backwards compatible**: `BIK_*` env vars are still accepted as fallbacks.

## MCP tools available to agents

| Tool | What it does |
|------|-------------|
| `list_my_tasks` | List tasks assigned to this agent |
| `read_task` | Read full task detail |
| `add_comment` | Post a comment (visible in PM with AI badge) |
| `change_state` | Move work item to a different state |
| `mark_complete` | Mark work item as completed |
| `create_work_item` | Create new work items |

## How it works

```
BikLabs PM ──SSE/webhook──> biklabs-agent listen ──spawn──> your runtime
     ^                                                          |
     └──────────MCP tools (comments, state, items)──────────────┘
```

## Requirements

- [Bun](https://bun.sh) >= 1.2
- A BikLabs PM workspace with at least one agent configured
- The runtime binary installed (e.g., `claude` for Claude Code)

## License

MIT
