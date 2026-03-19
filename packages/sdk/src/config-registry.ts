export type OnboardingScope = "light" | "full";

export type FeatureDomain =
  | "model"
  | "deploy"
  | "storage"
  | "memory"
  | "auth"
  | "telemetry"
  | "mcp"
  | "messaging";

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
    id: "deploy.target",
    domain: "deploy",
    target: "agent",
    path: "deploy.target",
    kind: "select",
    scopes: ["light", "full"],
    label: "Deploy target",
    prompt: "Choose a deploy target (optional)",
    defaultValue: "none",
    options: [
      { value: "none", label: "None (local dev only)" },
      { value: "vercel", label: "Vercel" },
      { value: "docker", label: "Docker" },
      { value: "fly", label: "Fly.io" },
      { value: "lambda", label: "AWS Lambda" },
    ],
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
        envVars: ["PONCHO_DYNAMODB_TABLE"],
      },
    ],
  },
  {
    id: "env.REDIS_URL",
    domain: "storage",
    target: "env",
    path: "REDIS_URL",
    kind: "string",
    scopes: ["full"],
    label: "Redis URL",
    prompt: "Redis connection URL",
    defaultValue: "",
    placeholder: "redis://localhost:6379",
    secret: true,
    dependsOn: { fieldId: "storage.provider", equals: "redis" },
  },
  {
    id: "env.UPSTASH_REDIS_REST_URL",
    domain: "storage",
    target: "env",
    path: "UPSTASH_REDIS_REST_URL",
    kind: "string",
    scopes: ["full"],
    label: "Upstash REST URL",
    prompt: "Upstash Redis REST URL",
    defaultValue: "",
    placeholder: "https://...",
    dependsOn: { fieldId: "storage.provider", equals: "upstash" },
  },
  {
    id: "env.UPSTASH_REDIS_REST_TOKEN",
    domain: "storage",
    target: "env",
    path: "UPSTASH_REDIS_REST_TOKEN",
    kind: "string",
    scopes: ["full"],
    label: "Upstash REST token",
    prompt: "Upstash Redis REST token",
    defaultValue: "",
    secret: true,
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
    defaultValue: "x-poncho-key",
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
    label: "OTLP trace endpoint",
    prompt: "OTLP trace endpoint URL (optional, supports Jaeger/Tempo/Honeycomb/any collector)",
    defaultValue: "",
    dependsOn: { fieldId: "telemetry.enabled", equals: true },
  },
  {
    id: "messaging.platform",
    domain: "messaging",
    target: "agent",
    path: "messaging.platform",
    kind: "select",
    scopes: ["full"],
    label: "Messaging platform",
    prompt: "Connect to a messaging platform? (optional)",
    defaultValue: "none",
    options: [
      { value: "none", label: "None" },
      { value: "slack", label: "Slack" },
      { value: "telegram", label: "Telegram" },
      { value: "resend", label: "Email (Resend)" },
    ],
  },
  {
    id: "env.SLACK_BOT_TOKEN",
    domain: "messaging",
    target: "env",
    path: "SLACK_BOT_TOKEN",
    kind: "string",
    scopes: ["full"],
    label: "Slack Bot Token",
    prompt: "Slack Bot Token (from OAuth & Permissions)",
    defaultValue: "",
    placeholder: "xoxb-...",
    secret: true,
    dependsOn: { fieldId: "messaging.platform", equals: "slack" },
  },
  {
    id: "env.SLACK_SIGNING_SECRET",
    domain: "messaging",
    target: "env",
    path: "SLACK_SIGNING_SECRET",
    kind: "string",
    scopes: ["full"],
    label: "Slack Signing Secret",
    prompt: "Slack Signing Secret (from Basic Information)",
    defaultValue: "",
    secret: true,
    dependsOn: { fieldId: "messaging.platform", equals: "slack" },
  },
  {
    id: "env.TELEGRAM_BOT_TOKEN",
    domain: "messaging",
    target: "env",
    path: "TELEGRAM_BOT_TOKEN",
    kind: "string",
    scopes: ["full"],
    label: "Telegram Bot Token",
    prompt: "Telegram Bot Token (from @BotFather)",
    defaultValue: "",
    placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    secret: true,
    dependsOn: { fieldId: "messaging.platform", equals: "telegram" },
  },
  {
    id: "env.TELEGRAM_WEBHOOK_SECRET",
    domain: "messaging",
    target: "env",
    path: "TELEGRAM_WEBHOOK_SECRET",
    kind: "string",
    scopes: ["full"],
    label: "Telegram Webhook Secret",
    prompt: "Webhook secret token (optional, recommended for security)",
    defaultValue: "",
    placeholder: "my-secret-token",
    secret: true,
    dependsOn: { fieldId: "messaging.platform", equals: "telegram" },
  },
  {
    id: "env.RESEND_API_KEY",
    domain: "messaging",
    target: "env",
    path: "RESEND_API_KEY",
    kind: "string",
    scopes: ["full"],
    label: "Resend API Key",
    prompt: "Resend API Key (from resend.com/api-keys)",
    defaultValue: "",
    placeholder: "re_...",
    secret: true,
    dependsOn: { fieldId: "messaging.platform", equals: "resend" },
  },
  {
    id: "env.RESEND_WEBHOOK_SECRET",
    domain: "messaging",
    target: "env",
    path: "RESEND_WEBHOOK_SECRET",
    kind: "string",
    scopes: ["full"],
    label: "Resend Webhook Secret",
    prompt: "Resend Webhook Signing Secret (from webhook details page)",
    defaultValue: "",
    placeholder: "whsec_...",
    secret: true,
    dependsOn: { fieldId: "messaging.platform", equals: "resend" },
  },
  {
    id: "env.RESEND_FROM",
    domain: "messaging",
    target: "env",
    path: "RESEND_FROM",
    kind: "string",
    scopes: ["full"],
    label: "From Address",
    prompt: "Email address the agent sends from (e.g. Agent <agent@yourdomain.com>)",
    defaultValue: "",
    placeholder: "Agent <agent@yourdomain.com>",
    dependsOn: { fieldId: "messaging.platform", equals: "resend" },
  },
  {
    id: "env.RESEND_REPLY_TO",
    domain: "messaging",
    target: "env",
    path: "RESEND_REPLY_TO",
    kind: "string",
    scopes: ["full"],
    label: "Reply-To Address",
    prompt: "Reply-To address for outgoing emails (optional, defaults to From address)",
    defaultValue: "",
    placeholder: "support@yourdomain.com",
    dependsOn: { fieldId: "messaging.platform", equals: "resend" },
  },
  {
    id: "messaging.resend.mode",
    domain: "messaging",
    target: "agent",
    path: "messaging.resend.mode",
    kind: "select",
    scopes: ["full"],
    label: "Email response mode",
    prompt: "How should the agent respond to emails?",
    defaultValue: "auto-reply",
    options: [
      { value: "auto-reply", label: "Auto-reply (agent response sent as email reply)" },
      { value: "tool", label: "Tool (agent uses send_email tool for full control)" },
    ],
    dependsOn: { fieldId: "messaging.platform", equals: "resend" },
  },
  {
    id: "messaging.resend.allowedRecipients",
    domain: "messaging",
    target: "agent",
    path: "messaging.resend.allowedRecipients",
    kind: "string",
    scopes: ["full"],
    label: "Allowed recipients",
    prompt: "Allowed recipient patterns for send_email tool (comma-separated, e.g. *@mycompany.com). Leave empty for no restrictions.",
    defaultValue: "",
    placeholder: "*@mycompany.com, partner@external.com",
    dependsOn: { fieldId: "messaging.resend.mode", equals: "tool" },
  },
] as const satisfies readonly OnboardingField[];

export const FEATURE_DOMAIN_ORDER: readonly FeatureDomain[] = [
  "model",
  "deploy",
  "storage",
  "memory",
  "auth",
  "telemetry",
  "mcp",
  "messaging",
] as const;

export const fieldsForScope = (scope: OnboardingScope): OnboardingField[] =>
  ONBOARDING_FIELDS.filter((field) =>
    (field.scopes as readonly OnboardingScope[]).includes(scope),
  );
