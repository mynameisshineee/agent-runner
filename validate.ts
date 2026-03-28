#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface AgentConfig {
  id: string;
  name: string;
  role: string;
  mcpToken: string;
  systemPrompt: string;
  permissions: string[];
  maxTokensBudget: number;
  runtimeType?: "claude_code" | "codex" | "opencode" | "kiro" | "chat";
}

interface AgentsFile {
  agents: AgentConfig[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const raw = readFileSync(join(import.meta.dir, "agents.json"), "utf8");
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
  assert(typeof a.systemPrompt === "string" && a.systemPrompt.length > 0, `agents[${idx}].systemPrompt is required`);
  assert(Array.isArray(a.permissions), `agents[${idx}].permissions must be an array`);
  assert(a.permissions.length > 0, `agents[${idx}].permissions cannot be empty`);
  assert(Number.isFinite(a.maxTokensBudget) && a.maxTokensBudget > 0, `agents[${idx}].maxTokensBudget must be > 0`);
}

console.log(`OK: validated ${data.agents.length} agents`);
