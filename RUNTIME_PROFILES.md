# Runtime Profiles — Claude Code / Codex / OpenCode / Kiro

Este runner soporta:

- `claude_code` (hardcoded)
- `codex` (hardcoded)
- `opencode|kiro|chat` via generic CLI adapter (`runtimeCommand`, `runtimeArgs`, `runtimePromptMode`)

## Importante

Para runtimes no hardcoded, los flags exactos dependen de su CLI instalada.
Usa estas plantillas como base y valida con:

```bash
<binary> --help
<binary> --version
```

---

## 1) Claude Code (estable)

```json
{
  "id": "writer-claude",
  "name": "WriterClaude",
  "runtimeType": "claude_code",
  "mcpToken": "${WRITER_AGENT_MCP_TOKEN}",
  "role": "Redaccion tecnica",
  "systemPrompt": "Eres WriterClaude...",
  "permissions": ["read_data", "update_entity"],
  "maxTokensBudget": 100000
}
```

---

## 2) Codex (estable)

```json
{
  "id": "code-codex",
  "name": "CodeCodex",
  "runtimeType": "codex",
  "mcpToken": "${CODE_CODEX_MCP_TOKEN}",
  "role": "Software engineer",
  "systemPrompt": "Eres CodeCodex...",
  "permissions": ["read_data", "update_entity", "create_entity"],
  "maxTokensBudget": 120000
}
```

Variables opcionales:

- `CODEX_BIN`
- `CODEX_SANDBOX_MODE`
- `CODEX_MCP_SERVER_NAME`
- `CODEX_MODEL`

---

## 3) OpenCode (generic adapter)

```json
{
  "id": "open-agent",
  "name": "OpenAgent",
  "runtimeType": "opencode",
  "runtimeCommand": "opencode",
  "runtimeArgs": ["run", "--cwd", "{WORKDIR}", "--mcp-config", "{MCP_CONFIG}", "{PROMPT}"],
  "runtimePromptMode": "arg",
  "runtimeEnv": {
    "BIK_MODE": "agent"
  },
  "mcpToken": "${OPEN_AGENT_MCP_TOKEN}",
  "role": "Generalista",
  "systemPrompt": "Eres OpenAgent...",
  "permissions": ["read_data", "update_entity"],
  "maxTokensBudget": 80000
}
```

Si el CLI necesita prompt por stdin:

```json
"runtimePromptMode": "stdin"
```

---

## 4) Kiro (generic adapter)

```json
{
  "id": "kiro-agent",
  "name": "KiroAgent",
  "runtimeType": "kiro",
  "runtimeCommand": "kiro",
  "runtimeArgs": ["run", "--cwd", "{WORKDIR}", "--mcp", "{MCP_URL}"],
  "runtimePromptMode": "stdin",
  "runtimeEnv": {
    "KIRO_MODE": "agent"
  },
  "mcpToken": "${KIRO_AGENT_MCP_TOKEN}",
  "role": "Generalista",
  "systemPrompt": "Eres KiroAgent...",
  "permissions": ["read_data", "update_entity"],
  "maxTokensBudget": 80000
}
```

Nota: el ejemplo de args/env es plantilla. Ajustar a flags reales de la versión instalada de Kiro.

---

## 5) Chat runtime (Telegram/WhatsApp bridge)

```json
{
  "id": "chat-agent",
  "name": "ChatAgent",
  "runtimeType": "chat",
  "runtimeCommand": "node",
  "runtimeArgs": ["/opt/bik/chat-worker.js", "--workspace", "{WORKDIR}"],
  "runtimePromptMode": "stdin",
  "mcpToken": "${CHAT_AGENT_MCP_TOKEN}",
  "role": "Conversacional",
  "systemPrompt": "Eres ChatAgent...",
  "permissions": ["read_data", "update_entity"],
  "maxTokensBudget": 40000
}
```

---

## Checklist de validación por runtime

1. El binario existe en PATH del host (`which <binary>`).
2. Soporta modo no interactivo (arg o stdin).
3. Puede leer MCP config o `MCP_URL + token` por env.
4. Escribe salida útil en stdout/stderr.
5. Responde bien a `SIGTERM` para cancelación.
6. No filtra secretos en logs.
