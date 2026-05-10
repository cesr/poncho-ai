// ---------------------------------------------------------------------------
// Canonical default agent definition.
//
// This is the same agent.md a fresh `poncho init` produces. The CLI's
// AGENT_TEMPLATE in `packages/cli/src/templates.ts` delegates to this helper
// so there is exactly one source of truth, and SDK consumers (PonchOS, custom
// servers, etc.) can pass the same default to `new AgentHarness({ agentDefinition: ... })`
// without hand-copying the template.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

export interface DefaultAgentDefinitionOptions {
  /** Display name for the agent. Default: "agent". */
  name?: string;
  /**
   * Stable identifier embedded in the frontmatter. Default: a fresh
   * `agent_<32hex>`. Note: when an injected `StorageEngine` is also passed
   * to `AgentHarness`, the engine's `agentId` overrides this at runtime, so
   * SDK consumers can leave it default.
   */
  id?: string;
  /** Frontmatter description. Default: "A helpful Poncho assistant". */
  description?: string;
  /** Model provider. Default: "anthropic". */
  modelProvider?: "anthropic" | "openai" | "openai-codex";
  /** Model name. Default: "claude-opus-4-5". */
  modelName?: string;
  /** Sampling temperature. Default: 0.2. */
  temperature?: number;
  /** Max tool-call steps per run. Default: 20. */
  maxSteps?: number;
  /** Hard timeout in seconds. Default: 300. */
  timeout?: number;
}

export const DEFAULT_AGENT_NAME = "agent";
export const DEFAULT_AGENT_DESCRIPTION = "A helpful Poncho assistant";
export const DEFAULT_MODEL_PROVIDER = "anthropic" as const;
export const DEFAULT_MODEL_NAME = "claude-opus-4-5";
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_TIMEOUT = 300;

/**
 * Returns the canonical default agent definition as a markdown string,
 * ready to pass to `new AgentHarness({ agentDefinition })`. This is the
 * exact same template `poncho init` writes to `AGENT.md`.
 */
export const defaultAgentDefinition = (
  opts: DefaultAgentDefinitionOptions = {},
): string => {
  const name = opts.name ?? DEFAULT_AGENT_NAME;
  const id = opts.id ?? `agent_${randomBytes(16).toString("hex")}`;
  const description = opts.description ?? DEFAULT_AGENT_DESCRIPTION;
  const modelProvider = opts.modelProvider ?? DEFAULT_MODEL_PROVIDER;
  const modelName = opts.modelName ?? DEFAULT_MODEL_NAME;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

  return `---
name: ${name}
id: ${id}
description: ${description}
model:
  provider: ${modelProvider}
  name: ${modelName}
  temperature: ${temperature}
limits:
  maxSteps: ${maxSteps}
  timeout: ${timeout}
---

# {{name}}

You are **{{name}}**, a helpful assistant built with Poncho.

Working directory: {{runtime.workingDir}}
Environment: {{runtime.environment}}

## Task Guidance

- Use tools when needed
- Explain your reasoning clearly
- Ask clarifying questions when requirements are ambiguous
- Never claim a file/tool change unless the corresponding tool call actually succeeded
`;
};
