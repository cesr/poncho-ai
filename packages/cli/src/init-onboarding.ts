import { stdin, stdout } from "node:process";
import { input, password, select } from "@inquirer/prompts";
import type { AgentlConfig } from "@agentl/harness";
import {
  ONBOARDING_FIELDS,
  fieldsForScope,
  type OnboardingField,
  type OnboardingScope,
} from "@agentl/sdk";

// ANSI style helpers
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
} as const;

const cyan = (s: string): string => `${C.cyan}${s}${C.reset}`;
const dim = (s: string): string => `${C.dim}${s}${C.reset}`;
const bold = (s: string): string => `${C.bold}${s}${C.reset}`;
const INPUT_CARET = "»";

type OnboardingAnswers = Record<string, string | number | boolean>;

export type InitOnboardingOptions = {
  mode: OnboardingScope;
  yes?: boolean;
  interactive?: boolean;
};

export type InitOnboardingResult = {
  answers: OnboardingAnswers;
  config: AgentlConfig;
  envExample: string;
  envFile: string;
  envNeedsUserInput: boolean;
  agentModel: {
    provider: "anthropic" | "openai";
    name: string;
  };
};

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

type Join<K extends string, P extends string> = `${K}.${P}`;
type DotPath<T> = T extends Primitive
  ? never
  : {
      [K in keyof T & string]: NonNullable<T[K]> extends Primitive
        ? K
        : K | Join<K, DotPath<NonNullable<T[K]>>>;
    }[keyof T & string];

type AgentlConfigPath = DotPath<AgentlConfig>;
type RegistryConfigPath = Extract<
  (typeof ONBOARDING_FIELDS)[number],
  { target: "config" }
>["path"];
type RegistryConfigPathContract = RegistryConfigPath extends AgentlConfigPath
  ? true
  : never;
const REGISTRY_CONFIG_PATH_CONTRACT: RegistryConfigPathContract = true;
void REGISTRY_CONFIG_PATH_CONTRACT;

const shouldAskField = (
  field: OnboardingField,
  answers: OnboardingAnswers,
): boolean => {
  if (!field.dependsOn) {
    return true;
  }
  const value = answers[field.dependsOn.fieldId];
  if (typeof field.dependsOn.equals !== "undefined") {
    return value === field.dependsOn.equals;
  }
  if (field.dependsOn.oneOf) {
    return field.dependsOn.oneOf.includes(value as string | number | boolean);
  }
  return true;
};

const parsePromptValue = (
  field: OnboardingField,
  answer: string,
): string | number | boolean => {
  if (field.kind === "boolean") {
    const normalized = answer.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes" || normalized === "true") {
      return true;
    }
    if (normalized === "n" || normalized === "no" || normalized === "false") {
      return false;
    }
    return Boolean(field.defaultValue);
  }
  if (field.kind === "number") {
    const parsed = Number.parseInt(answer.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    return Number(field.defaultValue);
  }
  if (field.kind === "select") {
    const trimmed = answer.trim();
    if (field.options && field.options.some((option) => option.value === trimmed)) {
      return trimmed;
    }
    const asNumber = Number.parseInt(trimmed, 10);
    if (
      Number.isFinite(asNumber) &&
      field.options &&
      asNumber >= 1 &&
      asNumber <= field.options.length
    ) {
      return field.options[asNumber - 1]?.value ?? String(field.defaultValue);
    }
    return String(field.defaultValue);
  }
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return String(field.defaultValue);
  }
  return trimmed;
};

const askSecret = async (
  field: OnboardingField,
): Promise<string | undefined> => {
  if (!stdin.isTTY) {
    return undefined;
  }

  const hint = field.placeholder ? dim(` (${field.placeholder})`) : "";
  const message = `${field.prompt}${hint}`;
  const value = await password(
    {
      message,
      // true invisible input while typing/pasting
      mask: false,
      theme: {
        prefix: {
          idle: dim(INPUT_CARET),
          done: dim("✓"),
        },
        style: {
          help: () => "",
        },
      },
    },
    { input: stdin, output: stdout },
  );
  return value ?? "";
};

const askSelectWithArrowKeys = async (
  field: OnboardingField,
): Promise<string | undefined> => {
  if (!field.options || field.options.length === 0) {
    return undefined;
  }
  if (!stdin.isTTY) {
    return undefined;
  }

  const selected = await select(
    {
      message: field.prompt,
      choices: field.options.map((option) => ({
        name: option.label,
        value: option.value,
      })),
      default: String(field.defaultValue),
      theme: {
        prefix: {
          idle: dim(INPUT_CARET),
          done: dim("✓"),
        },
      },
    },
    { input: stdin, output: stdout },
  );
  return selected;
};

const askBooleanWithArrowKeys = async (
  field: OnboardingField,
): Promise<string | undefined> => {
  if (!stdin.isTTY) {
    return undefined;
  }

  const selected = await select(
    {
      message: field.prompt,
      choices: [
        { name: "Yes", value: "true" },
        { name: "No", value: "false" },
      ],
      default: field.defaultValue ? "true" : "false",
      theme: {
        prefix: {
          idle: dim(INPUT_CARET),
          done: dim("✓"),
        },
      },
    },
    { input: stdin, output: stdout },
  );
  return selected;
};

const askTextInput = async (field: OnboardingField): Promise<string | undefined> => {
  if (!stdin.isTTY) {
    return undefined;
  }
  const answer = await input(
    {
      message: field.prompt,
      default: String(field.defaultValue ?? ""),
      theme: {
        prefix: {
          idle: dim(INPUT_CARET),
          done: dim("✓"),
        },
      },
    },
    { input: stdin, output: stdout },
  );
  return answer;
};

const buildDefaultAnswers = (mode: OnboardingScope): OnboardingAnswers => {
  const answers: OnboardingAnswers = {};
  for (const field of fieldsForScope(mode)) {
    answers[field.id] = field.defaultValue;
  }
  return answers;
};

const askOnboardingQuestions = async (
  mode: OnboardingScope,
  options: InitOnboardingOptions,
): Promise<OnboardingAnswers> => {
  const answers = buildDefaultAnswers(mode);
  const interactive =
    options.yes === true
      ? false
      : options.interactive ?? (stdin.isTTY === true && stdout.isTTY === true);
  if (!interactive) {
    return answers;
  }

  stdout.write("\n");
  stdout.write(`  ${bold("AgentL")} ${dim(`· ${mode === "full" ? "full" : "quick"} setup`)}\n`);
  stdout.write("\n");
  const fields = fieldsForScope(mode);
  for (const field of fields) {
    if (!shouldAskField(field, answers)) {
      continue;
    }
    stdout.write("\n");
    let value: string | undefined;
    if (field.secret) {
      value = await askSecret(field);
    } else if (field.kind === "select") {
      value = await askSelectWithArrowKeys(field);
    } else if (field.kind === "boolean") {
      value = await askBooleanWithArrowKeys(field);
    } else {
      value = await askTextInput(field);
    }
    if (!value || value.trim().length === 0) {
      continue;
    }
    answers[field.id] = parsePromptValue(field, value);
  }
  return answers;
};

const getProviderModelName = (provider: string): string =>
  provider === "openai" ? "gpt-4.1" : "claude-opus-4-5";

const maybeSet = (
  target: object,
  key: string,
  value: unknown,
): void => {
  if (typeof value === "string" && value.trim().length === 0) {
    return;
  }
  if (typeof value === "undefined") {
    return;
  }
  (target as Record<string, unknown>)[key] = value;
};

export const buildConfigFromOnboardingAnswers = (
  answers: OnboardingAnswers,
): AgentlConfig => {
  const storageProvider = String(answers["storage.provider"] ?? "local");
  const memoryEnabled = Boolean(answers["storage.memory.enabled"] ?? true);
  const maxRecallConversations = Number(
    answers["storage.memory.maxRecallConversations"] ?? 20,
  );

  const storage: NonNullable<AgentlConfig["storage"]> = {
    provider: storageProvider as NonNullable<AgentlConfig["storage"]>["provider"],
    memory: {
      enabled: memoryEnabled,
      maxRecallConversations,
    },
  };
  maybeSet(storage, "url", answers["storage.url"]);
  maybeSet(storage, "token", answers["storage.token"]);
  maybeSet(storage, "table", answers["storage.table"]);
  maybeSet(storage, "region", answers["storage.region"]);

  const authRequired = Boolean(answers["auth.required"] ?? false);
  const authType =
    (answers["auth.type"] as "bearer" | "header" | "custom" | undefined) ?? "bearer";

  const auth: NonNullable<AgentlConfig["auth"]> = {
    required: authRequired,
    type: authType,
  };
  if (authType === "header") {
    maybeSet(auth, "headerName", answers["auth.headerName"]);
  }

  const telemetryEnabled = Boolean(answers["telemetry.enabled"] ?? true);
  const telemetry: NonNullable<AgentlConfig["telemetry"]> = {
    enabled: telemetryEnabled,
  };
  maybeSet(telemetry, "otlp", answers["telemetry.otlp"]);

  return {
    mcp: [],
    auth,
    storage,
    telemetry,
  };
};

export const isDefaultOnboardingConfig = (
  config: AgentlConfig | undefined,
): boolean => {
  if (!config) {
    return true;
  }
  const topLevelKeys = Object.keys(config);
  const allowedTopLevel = new Set(["mcp", "auth", "storage", "telemetry"]);
  if (topLevelKeys.some((key) => !allowedTopLevel.has(key))) {
    return false;
  }
  if ((config.mcp ?? []).length > 0) {
    return false;
  }
  const authRequired = config.auth?.required ?? false;
  const authType = config.auth?.type ?? "bearer";
  if (authRequired || authType !== "bearer" || typeof config.auth?.headerName !== "undefined") {
    return false;
  }
  const provider = config.storage?.provider ?? "local";
  if (provider !== "local") {
    return false;
  }
  if (
    typeof config.storage?.url !== "undefined" ||
    typeof config.storage?.token !== "undefined" ||
    typeof config.storage?.table !== "undefined" ||
    typeof config.storage?.region !== "undefined"
  ) {
    return false;
  }
  const memoryEnabled = config.storage?.memory?.enabled ?? true;
  const maxRecallConversations = config.storage?.memory?.maxRecallConversations ?? 20;
  if (!memoryEnabled || maxRecallConversations !== 20) {
    return false;
  }
  const telemetryEnabled = config.telemetry?.enabled ?? true;
  const telemetryHasExtra =
    typeof config.telemetry?.otlp !== "undefined" ||
    typeof config.telemetry?.latitude !== "undefined" ||
    typeof config.telemetry?.handler !== "undefined";
  if (!telemetryEnabled || telemetryHasExtra) {
    return false;
  }
  return true;
};

const collectEnvVars = (answers: OnboardingAnswers): string[] => {
  const envVars = new Set<string>();
  const provider = String(answers["model.provider"] ?? "anthropic");
  if (provider === "openai") {
    envVars.add("OPENAI_API_KEY=sk-...");
  } else {
    envVars.add("ANTHROPIC_API_KEY=sk-ant-...");
  }
  const storageProvider = String(answers["storage.provider"] ?? "local");
  if (storageProvider === "redis") {
    envVars.add("REDIS_URL=redis://localhost:6379");
  }
  if (storageProvider === "upstash") {
    envVars.add("UPSTASH_REDIS_REST_URL=https://...");
    envVars.add("UPSTASH_REDIS_REST_TOKEN=...");
  }
  if (storageProvider === "dynamodb") {
    envVars.add("AGENTL_DYNAMODB_TABLE=agentl-conversations");
    envVars.add("AWS_REGION=us-east-1");
  }
  const authRequired = Boolean(answers["auth.required"] ?? false);
  if (authRequired) {
    envVars.add("AGENTL_AUTH_TOKEN=...");
  }
  return Array.from(envVars);
};

const collectEnvFileLines = (answers: OnboardingAnswers): string[] => {
  const lines: string[] = [
    "# AgentL environment configuration",
    "# Fill in empty values before running `agentl dev` or `agentl run --interactive`.",
    "# Tip: keep secrets in `.env` only (never commit them).",
    "",
  ];

  const modelProvider = String(answers["model.provider"] ?? "anthropic");
  const modelEnvKey =
    modelProvider === "openai" ? "env.OPENAI_API_KEY" : "env.ANTHROPIC_API_KEY";
  const modelEnvVar =
    modelProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const modelEnvValue = String(answers[modelEnvKey] ?? "");
  lines.push("# Model");
  if (modelEnvValue.length === 0) {
    lines.push(
      modelProvider === "openai"
        ? "# OpenAI: create an API key at https://platform.openai.com/api-keys"
        : "# Anthropic: create an API key at https://console.anthropic.com/settings/keys",
    );
  }
  lines.push(`${modelEnvVar}=${modelEnvValue}`);
  lines.push("");

  const authRequired = Boolean(answers["auth.required"] ?? false);
  const authType =
    (answers["auth.type"] as "bearer" | "header" | "custom" | undefined) ?? "bearer";
  const authHeaderName = String(answers["auth.headerName"] ?? "x-agentl-key");
  if (authRequired) {
    lines.push("# Auth (API request authentication)");
    if (authType === "bearer") {
      lines.push("# Requests should include: Authorization: Bearer <token>");
    } else if (authType === "header") {
      lines.push(`# Requests should include: ${authHeaderName}: <token>`);
    } else {
      lines.push("# Custom auth mode: read this token in your auth.validate function.");
    }
    lines.push("AGENTL_AUTH_TOKEN=");
    lines.push("");
  }

  const storageProvider = String(answers["storage.provider"] ?? "local");
  if (storageProvider === "redis") {
    lines.push("# Storage (Redis)");
    lines.push("# Run local Redis: docker run -p 6379:6379 redis:7");
    lines.push("# Or use a managed Redis URL from your cloud provider.");
    lines.push("REDIS_URL=");
    lines.push("");
  } else if (storageProvider === "upstash") {
    lines.push("# Storage (Upstash)");
    lines.push("# Create a Redis database at https://console.upstash.com/");
    lines.push("# Copy REST URL + REST TOKEN from the Upstash dashboard.");
    lines.push("UPSTASH_REDIS_REST_URL=");
    lines.push("UPSTASH_REDIS_REST_TOKEN=");
    lines.push("");
  } else if (storageProvider === "dynamodb") {
    lines.push("# Storage (DynamoDB)");
    lines.push("# Create a DynamoDB table for AgentL conversation/state storage.");
    lines.push("# Ensure AWS credentials are configured (AWS_PROFILE or access keys).");
    lines.push("AGENTL_DYNAMODB_TABLE=");
    lines.push("AWS_REGION=");
    lines.push("");
  } else if (storageProvider === "local" || storageProvider === "memory") {
    lines.push(
      storageProvider === "local"
        ? "# Storage (Local file): no extra env vars required."
        : "# Storage (In-memory): no extra env vars required, data resets on restart.",
    );
    lines.push("");
  }

  const telemetryEnabled = Boolean(answers["telemetry.enabled"] ?? true);
  if (telemetryEnabled) {
    lines.push("# Telemetry (optional)");
    lines.push("# Latitude telemetry setup: https://docs.latitude.so/");
    lines.push("# If not using Latitude yet, you can leave these empty.");
    lines.push("LATITUDE_API_KEY=");
    lines.push("LATITUDE_PROJECT_ID=");
    lines.push("LATITUDE_PATH=");
    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

export const runInitOnboarding = async (
  options: InitOnboardingOptions,
): Promise<InitOnboardingResult> => {
  const answers = await askOnboardingQuestions(options.mode, options);
  const provider = String(answers["model.provider"] ?? "anthropic");
  const config = buildConfigFromOnboardingAnswers(answers);
  const envExampleLines = collectEnvVars(answers);
  const envFileLines = collectEnvFileLines(answers);
  const envNeedsUserInput = envFileLines.some(
    (line) =>
      line.includes("=") &&
      !line.startsWith("#") &&
      line.endsWith("="),
  );

  return {
    answers,
    config,
    envExample: `${envExampleLines.join("\n")}\n`,
    envFile: envFileLines.length > 0 ? `${envFileLines.join("\n")}\n` : "",
    envNeedsUserInput,
    agentModel: {
      provider: provider === "openai" ? "openai" : "anthropic",
      name: getProviderModelName(provider),
    },
  };
};
