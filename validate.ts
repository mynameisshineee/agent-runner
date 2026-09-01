#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface AgentConfig {
  id: string;
  name: string;
  role: string;
  mcpToken: string;
  runnerToken?: string;
  systemPrompt: string;
  permissions: string[];
  maxTokensBudget: number;
  runtimeType?: "claude_code" | "codex" | "cursor" | "opencode" | "kiro" | "openclaw" | "chat";
  runtimeCommand?: string;
  runtimeArgs?: string[];
  runtimeEnv?: Record<string, string>;
  runtimePromptMode?: "arg" | "stdin";
}

interface AgentsFile {
  agents: AgentConfig[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(THIS_DIR, "agents.json"), "utf8");
const data = JSON.parse(raw) as AgentsFile;

assert(Array.isArray(data.agents), "agents.json: 'agents' must be an array");
assert(data.agents.length > 0, "agents.json: must contain at least one agent");

const ids = new Set<string>();
for (const [idx, a] of data.agents.entries()) {
  assert(typeof a.id === "string" && a.id.length > 0, `agents[${idx}].id is required`);
  assert(/^[a-zA-Z0-9._:-]{1,128}$/.test(a.id), `agents[${idx}].id has invalid format`);
  assert(!ids.has(a.id), `duplicate agent id: ${a.id}`);
  ids.add(a.id);

  assert(typeof a.name === "string" && a.name.length > 0, `agents[${idx}].name is required`);
  assert(typeof a.role === "string" && a.role.length > 0, `agents[${idx}].role is required`);
  assert(typeof a.mcpToken === "string" && a.mcpToken.length > 0, `agents[${idx}].mcpToken is required`);
  if (typeof a.runnerToken !== "undefined") {
    assert(typeof a.runnerToken === "string" && a.runnerToken.length > 0, `agents[${idx}].runnerToken invalid`);
  }
  assert(typeof a.systemPrompt === "string" && a.systemPrompt.length > 0, `agents[${idx}].systemPrompt is required`);
  assert(Array.isArray(a.permissions), `agents[${idx}].permissions must be an array`);
  assert(a.permissions.length > 0, `agents[${idx}].permissions cannot be empty`);
  assert(Number.isFinite(a.maxTokensBudget) && a.maxTokensBudget > 0, `agents[${idx}].maxTokensBudget must be > 0`);

  if (typeof a.runtimeType !== "undefined") {
    assert(
      ["claude_code", "codex", "cursor", "opencode", "kiro", "openclaw", "chat"].includes(a.runtimeType),
      `agents[${idx}].runtimeType invalid`,
    );
  }
  if (typeof a.runtimeCommand !== "undefined") {
    assert(typeof a.runtimeCommand === "string" && a.runtimeCommand.length > 0, `agents[${idx}].runtimeCommand invalid`);
  }
  if (typeof a.runtimeArgs !== "undefined") {
    assert(Array.isArray(a.runtimeArgs), `agents[${idx}].runtimeArgs must be string[]`);
    assert(a.runtimeArgs.every((x) => typeof x === "string"), `agents[${idx}].runtimeArgs must be string[]`);
  }
  if (typeof a.runtimeEnv !== "undefined") {
    assert(typeof a.runtimeEnv === "object" && a.runtimeEnv !== null, `agents[${idx}].runtimeEnv must be object`);
    assert(
      Object.values(a.runtimeEnv).every((x) => typeof x === "string"),
      `agents[${idx}].runtimeEnv values must be strings`,
    );
  }
  if (typeof a.runtimePromptMode !== "undefined") {
    assert(
      a.runtimePromptMode === "arg" || a.runtimePromptMode === "stdin",
      `agents[${idx}].runtimePromptMode must be arg|stdin`,
    );
  }
}

console.log(`OK: validated ${data.agents.length} agents`);
