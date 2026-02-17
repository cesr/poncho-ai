import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Mustache from "mustache";
import YAML from "yaml";
import {
  matchesSlashPattern,
  matchesRelativeScriptPattern,
  normalizeRelativeScriptPattern,
  validateMcpPattern,
} from "./tool-policy.js";

export interface AgentModelConfig {
  provider: string;
  name: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentLimitsConfig {
  maxSteps?: number;
  timeout?: number;
}

export interface AgentFrontmatter {
  name: string;
  id?: string;
  description?: string;
  model?: AgentModelConfig;
  limits?: AgentLimitsConfig;
  allowedTools?: {
    mcp?: string[];
    scripts?: string[];
  };
  approvalRequired?: {
    mcp?: string[];
    scripts?: string[];
  };
}

export interface ParsedAgent {
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface RuntimeRenderContext {
  parameters?: Record<string, unknown>;
  runtime?: {
    workingDir?: string;
    agentId?: string;
    runId?: string;
    environment?: string;
  };
}

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const asNumberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

export const parseAgentMarkdown = (content: string): ParsedAgent => {
  const match = content.match(FRONTMATTER_PATTERN);

  if (!match) {
    throw new Error(
      "Invalid AGENT.md: expected YAML frontmatter wrapped in --- markers.",
    );
  }

  const parsedYaml = YAML.parse(match[1]) ?? {};
  const parsed = asRecord(parsedYaml);

  if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
    throw new Error("Invalid AGENT.md: frontmatter requires a non-empty `name`.");
  }

  const modelValue = asRecord(parsed.model);
  const limitsValue = asRecord(parsed.limits);
  const parseTools = (
    key: "allowed-tools" | "approval-required",
  ): { mcp: string[]; scripts: string[] } => {
    const entries = Array.isArray(parsed[key])
      ? parsed[key].filter((item): item is string => typeof item === "string")
      : [];
    const mcp: string[] = [];
    const scripts: string[] = [];
    for (const [index, entry] of entries.entries()) {
      if (entry.startsWith("mcp:")) {
        const withoutPrefix = entry.slice(4);
        validateMcpPattern(withoutPrefix, `AGENT.md frontmatter ${key}[${index}]`);
        mcp.push(withoutPrefix);
        continue;
      }
      scripts.push(
        normalizeRelativeScriptPattern(entry, `AGENT.md frontmatter ${key}[${index}]`),
      );
    }
    return { mcp, scripts };
  };
  const allowedTools = parseTools("allowed-tools");
  const approvalRequired = parseTools("approval-required");
  for (const pattern of approvalRequired.mcp) {
    const matchesAllowed = allowedTools.mcp.some((allowedPattern) =>
      matchesSlashPattern(pattern, allowedPattern),
    );
    if (!matchesAllowed) {
      throw new Error(
        `Invalid AGENT.md frontmatter approval-required: MCP pattern "${pattern}" must be included in allowed-tools.`,
      );
    }
  }
  for (const pattern of approvalRequired.scripts) {
    if (pattern.startsWith("./scripts/")) {
      continue;
    }
    const matchesAllowed = allowedTools.scripts.some((allowedPattern) =>
      matchesRelativeScriptPattern(pattern, allowedPattern),
    );
    if (!matchesAllowed) {
      throw new Error(
        `Invalid AGENT.md frontmatter approval-required: script pattern "${pattern}" must be included in allowed-tools when outside ./scripts/.`,
      );
    }
  }

  const frontmatter: AgentFrontmatter = {
    name: parsed.name,
    id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined,
    description:
      typeof parsed.description === "string" ? parsed.description : undefined,
    model:
      Object.keys(modelValue).length > 0
        ? {
            provider:
              typeof modelValue.provider === "string"
                ? modelValue.provider
                : "anthropic",
            name:
              typeof modelValue.name === "string"
                ? modelValue.name
                : "claude-opus-4-5",
            temperature: asNumberOrUndefined(modelValue.temperature),
            maxTokens: asNumberOrUndefined(modelValue.maxTokens),
          }
        : undefined,
    limits:
      Object.keys(limitsValue).length > 0
        ? {
            maxSteps: asNumberOrUndefined(limitsValue.maxSteps),
            timeout: asNumberOrUndefined(limitsValue.timeout),
          }
        : undefined,
    allowedTools:
      allowedTools.mcp.length > 0 || allowedTools.scripts.length > 0
        ? {
            mcp: allowedTools.mcp.length > 0 ? allowedTools.mcp : undefined,
            scripts: allowedTools.scripts.length > 0 ? allowedTools.scripts : undefined,
          }
        : undefined,
    approvalRequired:
      approvalRequired.mcp.length > 0 || approvalRequired.scripts.length > 0
        ? {
            mcp:
              approvalRequired.mcp.length > 0
                ? approvalRequired.mcp
                : undefined,
            scripts:
              approvalRequired.scripts.length > 0
                ? approvalRequired.scripts
                : undefined,
          }
        : undefined,
  };

  return {
    frontmatter,
    body: match[2].trim(),
  };
};

export const parseAgentFile = async (workingDir: string): Promise<ParsedAgent> => {
  const filePath = resolve(workingDir, "AGENT.md");
  const content = await readFile(filePath, "utf8");
  return parseAgentMarkdown(content);
};

export const renderAgentPrompt = (
  agent: ParsedAgent,
  context: RuntimeRenderContext = {},
): string => {
  const renderContext = {
    name: agent.frontmatter.name,
    description: agent.frontmatter.description ?? "",
    runtime: {
      workingDir: context.runtime?.workingDir ?? process.cwd(),
      agentId: context.runtime?.agentId ?? agent.frontmatter.id ?? agent.frontmatter.name,
      runId: context.runtime?.runId ?? `run_${randomUUID()}`,
      environment: context.runtime?.environment ?? "development",
    },
    parameters: context.parameters ?? {},
  };

  return Mustache.render(agent.body, renderContext).trim();
};
