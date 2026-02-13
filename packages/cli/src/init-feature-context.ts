import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentlConfig } from "@agentl/harness";
import {
  FEATURE_DOMAIN_ORDER,
  ONBOARDING_FIELDS,
  type FeatureDomain,
  type OnboardingField,
} from "@agentl/sdk";

type FeatureSummaryItem = {
  title: string;
  details: string[];
};

type IntroInput = {
  agentName: string;
  provider: string;
  model: string;
  config: AgentlConfig | undefined;
};

type OnboardingMarkerState = {
  introduced: boolean;
  allowIntro: boolean;
  onboardingVersion: number;
  createdAt: number;
  introducedAt?: number;
};

const ONBOARDING_VERSION = 1;
const ONBOARDING_MARKER_RELATIVE_PATH = ".agentl/state/onboarding.json";

const FEATURE_DOMAIN_LABELS: Record<FeatureDomain, string> = {
  model: "Model",
  storage: "Storage",
  memory: "Memory",
  auth: "Auth",
  telemetry: "Telemetry",
  mcp: "MCP",
};

const summarizeConfig = (config: AgentlConfig | undefined): string[] => {
  const provider = config?.storage?.provider ?? config?.state?.provider ?? "local";
  const memoryEnabled = config?.storage?.memory?.enabled ?? config?.memory?.enabled ?? false;
  const authRequired = config?.auth?.required ?? false;
  const telemetryEnabled = config?.telemetry?.enabled ?? true;
  return [
    `storage: ${provider}`,
    `memory tools: ${memoryEnabled ? "enabled" : "disabled"}`,
    `auth: ${authRequired ? "required" : "not required"}`,
    `telemetry: ${telemetryEnabled ? "enabled" : "disabled"}`,
  ];
};

const formatDependsOn = (
  dependsOn: { fieldId: string; equals?: string | number | boolean; oneOf?: Array<string | number | boolean> } | undefined,
): string | undefined => {
  if (!dependsOn) {
    return undefined;
  }
  if (typeof dependsOn.equals !== "undefined") {
    return `when ${dependsOn.fieldId}=${String(dependsOn.equals)}`;
  }
  if (dependsOn.oneOf && dependsOn.oneOf.length > 0) {
    return `when ${dependsOn.fieldId} in [${dependsOn.oneOf.join(", ")}]`;
  }
  return undefined;
};

const collectFeatureSummary = (): Record<FeatureDomain, FeatureSummaryItem[]> => {
  const grouped: Record<FeatureDomain, FeatureSummaryItem[]> = {
    model: [],
    storage: [],
    memory: [],
    auth: [],
    telemetry: [],
    mcp: [],
  };

  const fields = ONBOARDING_FIELDS as readonly OnboardingField[];
  for (const field of fields) {
    const existing = grouped[field.domain].find((item) => item.title === field.label);
    const details: string[] = [`path: ${field.path}`];
    if (typeof field.defaultValue !== "undefined" && String(field.defaultValue).length > 0) {
      details.push(`default: ${String(field.defaultValue)}`);
    }
    if (field.options && field.options.length > 0) {
      const optionValues = field.options.map((option) => option.value).join(", ");
      details.push(`options: ${optionValues}`);
      const optionEnvVars = new Set<string>();
      for (const option of field.options) {
        for (const envVar of option.envVars ?? []) {
          optionEnvVars.add(envVar);
        }
      }
      if (optionEnvVars.size > 0) {
        details.push(`option env vars: ${Array.from(optionEnvVars).join(", ")}`);
      }
    }
    if (field.envVars && field.envVars.length > 0) {
      details.push(`env vars: ${field.envVars.join(", ")}`);
    }
    const condition = formatDependsOn(field.dependsOn);
    if (condition) {
      details.push(condition);
    }

    if (existing) {
      for (const detail of details) {
        if (!existing.details.includes(detail)) {
          existing.details.push(detail);
        }
      }
      continue;
    }
    grouped[field.domain].push({
      title: field.label,
      details,
    });
  }
  grouped.mcp.push({
    title: "MCP integrations",
    details: ["path: mcp[] (add/remove via CLI or chat-driven config edits)"],
  });
  return grouped;
};

export const buildOnboardingFeatureGuidance = (): string => {
  const grouped = collectFeatureSummary();
  const lines: string[] = [
    "## Configuration Assistant Context",
    "",
    "You can help users configure this project by editing `agentl.config.js` when write tools are enabled.",
    "",
    "When users ask for config changes:",
    "- Keep config-edit guidance available, but only provide onboarding overview proactively on first run.",
    "- First summarize intended edits and affected keys.",
    "- Apply minimal edits only to requested keys.",
    "- Preserve unrelated config keys and custom code.",
    "- Confirm what changed and what environment variables are required.",
    "",
    "Feature catalog:",
  ];
  for (const domain of FEATURE_DOMAIN_ORDER) {
    const items = grouped[domain];
    if (items.length === 0) {
      continue;
    }
    lines.push(`- ${FEATURE_DOMAIN_LABELS[domain]}:`);
    for (const item of items) {
      lines.push(`  - ${item.title} (${item.details.join(", ")})`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const getOnboardingMarkerPath = (workingDir: string): string =>
  resolve(workingDir, ONBOARDING_MARKER_RELATIVE_PATH);

const readMarker = async (
  workingDir: string,
): Promise<OnboardingMarkerState | undefined> => {
  const markerPath = getOnboardingMarkerPath(workingDir);
  try {
    await access(markerPath);
  } catch {
    return undefined;
  }
  try {
    const raw = await readFile(markerPath, "utf8");
    return JSON.parse(raw) as OnboardingMarkerState;
  } catch {
    return undefined;
  }
};

const writeMarker = async (
  workingDir: string,
  state: OnboardingMarkerState,
): Promise<void> => {
  const markerPath = getOnboardingMarkerPath(workingDir);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(state, null, 2), "utf8");
};

export const initializeOnboardingMarker = async (
  workingDir: string,
  options?: { allowIntro?: boolean },
): Promise<void> => {
  const current = await readMarker(workingDir);
  if (current) {
    return;
  }
  const allowIntro = options?.allowIntro ?? true;
  await writeMarker(workingDir, {
    introduced: allowIntro ? false : true,
    allowIntro,
    onboardingVersion: ONBOARDING_VERSION,
    createdAt: Date.now(),
  });
};

export const consumeFirstRunIntro = async (
  workingDir: string,
  input: IntroInput,
): Promise<string | undefined> => {
  const marker = await readMarker(workingDir);
  if (marker?.allowIntro === false) {
    return undefined;
  }
  const shouldShow = !marker || marker.introduced === false;
  if (!shouldShow) {
    return undefined;
  }

  await writeMarker(workingDir, {
    introduced: true,
    allowIntro: true,
    onboardingVersion: ONBOARDING_VERSION,
    createdAt: marker?.createdAt ?? Date.now(),
    introducedAt: Date.now(),
  });

  const summary = summarizeConfig(input.config);
  const featureGroups = [
    "model/provider",
    "storage and memory",
    "auth/security",
    "telemetry",
    "MCP integrations",
  ].join(", ");

  return [
    `Hi! I'm **${input.agentName}**. I can help configure this agent directly by chat.\n`,
    `**Current config**`,
    `  Model: ${input.provider}/${input.model}`,
    `  ${summary.join(" · ")}`,
    "",
    `**Configurable areas**: ${featureGroups}\n`,
    "Try asking me:",
    `  · "Switch storage to Upstash"`,
    `  · "Enable auth with bearer token validation"`,
    `  · "Turn on telemetry and set OTLP endpoint"\n`,
    "_I'll summarize changes before editing anything._",
  ].join("\n");
};
