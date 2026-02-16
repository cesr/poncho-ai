export type RuntimeEnvironment = "development" | "staging" | "production";

export type ToolPolicyMode = "all" | "allowlist" | "denylist";

export interface ToolPatternPolicy {
  mode?: ToolPolicyMode;
  include?: string[];
  exclude?: string[];
  byEnvironment?: {
    development?: Omit<ToolPatternPolicy, "byEnvironment">;
    staging?: Omit<ToolPatternPolicy, "byEnvironment">;
    production?: Omit<ToolPatternPolicy, "byEnvironment">;
  };
}

const MCP_PATTERN = /^[^/*\s]+\/(\*|[^/*\s]+)$/;
const MCP_TOOL_PATTERN = /^(\*|[^/*\s]+)$/;
const SCRIPT_PATTERN = /^[^/*\s]+\/(\*|[^*\s]+)$/;

export const validateMcpPattern = (pattern: string, path: string): void => {
  if (!MCP_PATTERN.test(pattern)) {
    throw new Error(
      `Invalid MCP tool pattern at ${path}: "${pattern}". Expected "server/tool" or "server/*".`,
    );
  }
};

export const validateMcpToolPattern = (pattern: string, path: string): void => {
  if (!MCP_TOOL_PATTERN.test(pattern)) {
    throw new Error(
      `Invalid MCP tool pattern at ${path}: "${pattern}". Expected "tool" or "*".`,
    );
  }
};

export const validateScriptPattern = (pattern: string, path: string): void => {
  if (!SCRIPT_PATTERN.test(pattern)) {
    throw new Error(
      `Invalid script pattern at ${path}: "${pattern}". Expected "skill/script-path" or "skill/*".`,
    );
  }
};

export const normalizeRelativeScriptPattern = (
  value: string,
  path: string,
): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid script pattern at ${path}: value cannot be empty.`);
  }
  const withoutDotPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const normalized = withoutDotPrefix.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(
      `Invalid script pattern at ${path}: "${value}". Expected a relative path.`,
    );
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(
      `Invalid script pattern at ${path}: "${value}". Expected a normalized relative path.`,
    );
  }
  return `./${segments.join("/")}`;
};

export const isSiblingScriptsPattern = (pattern: string): boolean =>
  pattern === "./scripts" || pattern.startsWith("./scripts/");

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const matchesRelativeScriptPattern = (value: string, pattern: string): boolean => {
  const normalizedValue = normalizeRelativeScriptPattern(value, "value");
  const normalizedPattern = normalizeRelativeScriptPattern(pattern, "pattern");
  const regex = new RegExp(
    `^${escapeRegex(normalizedPattern).replaceAll("\\*", ".*")}$`,
  );
  return regex.test(normalizedValue);
};

const splitPattern = (pattern: string): [string, string] => {
  const slash = pattern.indexOf("/");
  if (slash < 0) {
    return [pattern, ""];
  }
  return [pattern.slice(0, slash), pattern.slice(slash + 1)];
};

export const matchesSlashPattern = (value: string, pattern: string): boolean => {
  const [targetScope, targetName] = splitPattern(value);
  const [patternScope, patternName] = splitPattern(pattern);
  if (targetScope !== patternScope) {
    return false;
  }
  if (patternName === "*") {
    return true;
  }
  return targetName === patternName;
};

export const mergePolicyForEnvironment = (
  policy: ToolPatternPolicy | undefined,
  environment: RuntimeEnvironment,
): Omit<ToolPatternPolicy, "byEnvironment"> => {
  const base: Omit<ToolPatternPolicy, "byEnvironment"> = {
    mode: policy?.mode,
    include: [...(policy?.include ?? [])],
    exclude: [...(policy?.exclude ?? [])],
  };
  const env = policy?.byEnvironment?.[environment];
  if (!env) {
    return base;
  }
  return {
    mode: env.mode ?? base.mode,
    include: env.include ? [...env.include] : base.include,
    exclude: env.exclude ? [...env.exclude] : base.exclude,
  };
};

export const applyToolPolicy = (
  values: string[],
  policy: Omit<ToolPatternPolicy, "byEnvironment"> | undefined,
): { allowed: string[]; filteredOut: string[] } => {
  const mode = policy?.mode ?? "all";
  const include = policy?.include ?? [];
  const exclude = policy?.exclude ?? [];
  const allowed: string[] = [];
  const filteredOut: string[] = [];

  for (const value of values) {
    const inInclude = include.some((pattern) => matchesSlashPattern(value, pattern));
    const inExclude = exclude.some((pattern) => matchesSlashPattern(value, pattern));
    let keep = true;
    if (mode === "allowlist") {
      keep = inInclude;
    } else if (mode === "denylist") {
      keep = !inExclude;
    }
    if (mode === "all" && exclude.length > 0) {
      keep = !inExclude;
    }
    if (keep) {
      allowed.push(value);
    } else {
      filteredOut.push(value);
    }
  }
  return { allowed, filteredOut };
};
