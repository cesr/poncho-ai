export type OnboardingScope = "light" | "full";

export type FeatureDomain =
  | "model"
  | "storage"
  | "memory"
  | "auth"
  | "telemetry"
  | "mcp";

export type OnboardingFieldTarget = "agent" | "config" | "env";

export type OnboardingFieldKind = "select" | "boolean" | "string" | "number";

export type OnboardingFieldCondition = {
  fieldId: string;
  equals?: string | number | boolean;
  oneOf?: Array<string | number | boolean>;
};

export type OnboardingOption = {
  value: string;
  label: string;
  envVars?: string[];
  description?: string;
};

export type OnboardingField = {
  id: string;
  domain: FeatureDomain;
  target: OnboardingFieldTarget;
  path: string;
  kind: OnboardingFieldKind;
  scopes: OnboardingScope[];
  label: string;
  prompt: string;
  defaultValue: string | number | boolean;
  options?: OnboardingOption[];
  envVars?: string[];
  placeholder?: string;
  secret?: boolean;
  dependsOn?: OnboardingFieldCondition;
};

export const ONBOARDING_FIELDS = [
  {
    id: "model.provider",
    domain: "model",
    target: "agent",
    path: "model.provider",
    kind: "select",
    scopes: ["light", "full"],
    label: "Model provider",
    prompt: "Choose a model provider",
    defaultValue: "anthropic",
    options: [
      { value: "anthropic", label: "Anthropic", envVars: ["ANTHROPIC_API_KEY"] },
      { value: "openai", label: "OpenAI", envVars: ["OPENAI_API_KEY"] },
    ],
  },
  {
    id: "env.ANTHROPIC_API_KEY",
    domain: "model",
    target: "env",
    path: "ANTHROPIC_API_KEY",
    kind: "string",
    scopes: ["light", "full"],
    label: "Anthropic API key",
    prompt: "Anthropic API key",
    defaultValue: "",
    placeholder: "sk-ant-...",
    secret: true,
    dependsOn: { fieldId: "model.provider", equals: "anthropic" },
  },
  {
    id: "env.OPENAI_API_KEY",
    domain: "model",
    target: "env",
    path: "OPENAI_API_KEY",
    kind: "string",
    scopes: ["light", "full"],
    label: "OpenAI API key",
    prompt: "OpenAI API key",
    defaultValue: "",
    placeholder: "sk-...",
    secret: true,
    dependsOn: { fieldId: "model.provider", equals: "openai" },
  },
  {
    id: "storage.provider",
    domain: "storage",
    target: "config",
    path: "storage.provider",
    kind: "select",
    scopes: ["light", "full"],
    label: "Storage provider",
    prompt: "Choose storage provider for conversations and memory",
    defaultValue: "local",
    options: [
      { value: "memory", label: "In-memory only" },
      { value: "local", label: "Local file storage" },
      { value: "redis", label: "Redis", envVars: ["REDIS_URL"] },
      {
        value: "upstash",
        label: "Upstash REST",
        envVars: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
      },
      {
        value: "dynamodb",
        label: "DynamoDB",
        envVars: ["AGENTL_DYNAMODB_TABLE"],
      },
    ],
  },
  {
    id: "storage.url",
    domain: "storage",
    target: "config",
    path: "storage.url",
    kind: "string",
    scopes: ["full"],
    label: "Storage URL",
    prompt: "Storage URL",
    defaultValue: "",
    dependsOn: { fieldId: "storage.provider", oneOf: ["redis", "upstash"] },
  },
  {
    id: "storage.token",
    domain: "storage",
    target: "config",
    path: "storage.token",
    kind: "string",
    scopes: ["full"],
    label: "Storage token",
    prompt: "Storage token",
    defaultValue: "",
    dependsOn: { fieldId: "storage.provider", equals: "upstash" },
  },
  {
    id: "storage.table",
    domain: "storage",
    target: "config",
    path: "storage.table",
    kind: "string",
    scopes: ["full"],
    label: "DynamoDB table",
    prompt: "DynamoDB table name",
    defaultValue: "",
    dependsOn: { fieldId: "storage.provider", equals: "dynamodb" },
  },
  {
    id: "storage.region",
    domain: "storage",
    target: "config",
    path: "storage.region",
    kind: "string",
    scopes: ["full"],
    label: "DynamoDB region",
    prompt: "DynamoDB region (optional)",
    defaultValue: "",
    dependsOn: { fieldId: "storage.provider", equals: "dynamodb" },
  },
  {
    id: "storage.memory.enabled",
    domain: "memory",
    target: "config",
    path: "storage.memory.enabled",
    kind: "boolean",
    scopes: ["light", "full"],
    label: "Enable memory tools",
    prompt: "Enable memory tools (memory_get, memory_update, conversation_recall)?",
    defaultValue: true,
  },
  {
    id: "storage.memory.maxRecallConversations",
    domain: "memory",
    target: "config",
    path: "storage.memory.maxRecallConversations",
    kind: "number",
    scopes: ["full"],
    label: "Max recall conversations",
    prompt: "Max conversations scanned by conversation_recall",
    defaultValue: 20,
    dependsOn: { fieldId: "storage.memory.enabled", equals: true },
  },
  {
    id: "auth.required",
    domain: "auth",
    target: "config",
    path: "auth.required",
    kind: "boolean",
    scopes: ["light", "full"],
    label: "Require auth",
    prompt: "Require auth for API requests?",
    defaultValue: false,
  },
  {
    id: "auth.type",
    domain: "auth",
    target: "config",
    path: "auth.type",
    kind: "select",
    scopes: ["full"],
    label: "Auth type",
    prompt: "Auth type",
    defaultValue: "bearer",
    options: [
      { value: "bearer", label: "Bearer token" },
      { value: "header", label: "Custom header" },
      { value: "custom", label: "Custom validate() function" },
    ],
    dependsOn: { fieldId: "auth.required", equals: true },
  },
  {
    id: "auth.headerName",
    domain: "auth",
    target: "config",
    path: "auth.headerName",
    kind: "string",
    scopes: ["full"],
    label: "Header name",
    prompt: "Header name (for auth type=header)",
    defaultValue: "x-agentl-key",
    dependsOn: { fieldId: "auth.type", equals: "header" },
  },
  {
    id: "telemetry.enabled",
    domain: "telemetry",
    target: "config",
    path: "telemetry.enabled",
    kind: "boolean",
    scopes: ["light", "full"],
    label: "Enable telemetry",
    prompt: "Enable telemetry?",
    defaultValue: true,
  },
  {
    id: "telemetry.otlp",
    domain: "telemetry",
    target: "config",
    path: "telemetry.otlp",
    kind: "string",
    scopes: ["full"],
    label: "OTLP endpoint",
    prompt: "OTLP endpoint (optional)",
    defaultValue: "",
    dependsOn: { fieldId: "telemetry.enabled", equals: true },
  },
] as const satisfies readonly OnboardingField[];

export const FEATURE_DOMAIN_ORDER: readonly FeatureDomain[] = [
  "model",
  "storage",
  "memory",
  "auth",
  "telemetry",
  "mcp",
] as const;

export const fieldsForScope = (scope: OnboardingScope): OnboardingField[] =>
  ONBOARDING_FIELDS.filter((field) =>
    (field.scopes as readonly OnboardingScope[]).includes(scope),
  );
