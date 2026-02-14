import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { PonchoConfig } from "@poncho-ai/harness";

type IntroInput = {
  agentName: string;
  provider: string;
  model: string;
  config: PonchoConfig | undefined;
};

type OnboardingMarkerState = {
  introduced: boolean;
  allowIntro: boolean;
  onboardingVersion: number;
  createdAt: number;
  introducedAt?: number;
};

const ONBOARDING_VERSION = 1;

const getStateDirectory = (): string => {
  const cwd = process.cwd();
  const home = homedir();
  const isServerless =
    process.env.VERCEL === "1" ||
    process.env.VERCEL_ENV !== undefined ||
    process.env.VERCEL_URL !== undefined ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
    process.env.AWS_EXECUTION_ENV?.includes("AWS_Lambda") === true ||
    process.env.LAMBDA_TASK_ROOT !== undefined ||
    process.env.NOW_REGION !== undefined ||
    cwd.startsWith("/var/task") ||
    home.startsWith("/var/task") ||
    process.env.SERVERLESS === "1";
  if (isServerless) {
    return "/tmp/.poncho/state";
  }
  return resolve(homedir(), ".poncho", "state");
};

const summarizeConfig = (config: PonchoConfig | undefined): string[] => {
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

const getOnboardingMarkerPath = (workingDir: string): string =>
  resolve(
    getStateDirectory(),
    `${basename(workingDir).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project"}-${createHash("sha256")
      .update(workingDir)
      .digest("hex")
      .slice(0, 12)}-onboarding.json`,
  );

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
  const runtimeEnv = (process.env.PONCHO_ENV ?? process.env.NODE_ENV ?? "").toLowerCase();
  if (runtimeEnv === "production") {
    return undefined;
  }

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
  return [
    `Hi! I'm **${input.agentName}**. I can configure myself directly by chat.\n`,
    `**Current config**`,
    `  Model: ${input.provider}/${input.model}`,
    `  \`\`\`${summary.join(" · ")}\`\`\``,
    "",
    "Feel free to ask me anything when you're ready. I can help you:",
    "",
    "- **Build skills**: Create custom tools and capabilities for this agent",
    "- **Configure the model**: Switch providers (OpenAI, Anthropic, etc.) or models",
    "- **Set up storage**: Use local files, Upstash, or other backends",
    "- **Enable auth**: Add bearer tokens or custom authentication",
    "- **Turn on telemetry**: Track usage with OpenTelemetry/OTLP",
    "- **Add MCP servers**: Connect external tool servers",
    "",
    "Just let me know what you'd like to work on!\n",
  ].join("\n");
};
