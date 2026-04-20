import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateAgentId } from "@poncho-ai/harness";
import {
  AGENT_TEMPLATE,
  ENV_TEMPLATE,
  GITIGNORE_TEMPLATE,
  PACKAGE_TEMPLATE,
  README_TEMPLATE,
  SKILL_TEMPLATE,
  SKILL_TOOL_TEMPLATE,
  TEST_TEMPLATE,
} from "./templates.js";
import {
  ensureFile,
  renderConfigFile,
  scaffoldDeployTarget,
} from "./scaffolding.js";
import { runPnpmInstall } from "./skills.js";
import {
  runInitOnboarding,
  type InitOnboardingOptions,
} from "./init-onboarding.js";
import {
  initializeOnboardingMarker,
} from "./init-feature-context.js";

const gitInit = (cwd: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn("git", ["init"], { cwd, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

export const initProject = async (
  projectName: string,
  options?: {
    workingDir?: string;
    onboarding?: InitOnboardingOptions;
    envExampleOverride?: string;
  },
): Promise<void> => {
  const baseDir = options?.workingDir ?? process.cwd();
  const projectDir = resolve(baseDir, projectName);
  await mkdir(projectDir, { recursive: true });

  const onboardingOptions: InitOnboardingOptions = options?.onboarding ?? {
    yes: true,
    interactive: false,
  };
  const onboarding = await runInitOnboarding(onboardingOptions);
  const agentId = generateAgentId();

  const G = "\x1b[32m";
  const D = "\x1b[2m";
  const B = "\x1b[1m";
  const CY = "\x1b[36m";
  const YW = "\x1b[33m";
  const R = "\x1b[0m";

  process.stdout.write("\n");

  const scaffoldFiles: Array<{ path: string; content: string }> = [
    {
      path: "AGENT.md",
      content: AGENT_TEMPLATE(projectName, agentId, {
        modelProvider: onboarding.agentModel.provider,
        modelName: onboarding.agentModel.name,
      }),
    },
    { path: "poncho.config.js", content: renderConfigFile(onboarding.config) },
    { path: "package.json", content: await PACKAGE_TEMPLATE(projectName, projectDir) },
    { path: "README.md", content: README_TEMPLATE(projectName) },
    { path: ".env.example", content: options?.envExampleOverride ?? onboarding.envExample ?? ENV_TEMPLATE },
    { path: ".gitignore", content: GITIGNORE_TEMPLATE },
    { path: "tests/basic.yaml", content: TEST_TEMPLATE },
    { path: "skills/starter/SKILL.md", content: SKILL_TEMPLATE },
    { path: "skills/starter/scripts/starter-echo.ts", content: SKILL_TOOL_TEMPLATE },
  ];
  if (onboarding.envFile) {
    scaffoldFiles.push({ path: ".env", content: onboarding.envFile });
  }

  for (const file of scaffoldFiles) {
    await ensureFile(resolve(projectDir, file.path), file.content);
    process.stdout.write(`  ${D}+${R} ${D}${file.path}${R}\n`);
  }

  if (onboarding.deployTarget !== "none") {
    const deployFiles = await scaffoldDeployTarget(projectDir, onboarding.deployTarget);
    for (const filePath of deployFiles) {
      process.stdout.write(`  ${D}+${R} ${D}${filePath}${R}\n`);
    }
  }

  await initializeOnboardingMarker(projectDir, {
    allowIntro: !(onboardingOptions.yes ?? false),
  });

  process.stdout.write("\n");

  // Install dependencies so subsequent commands (e.g. `poncho add`) succeed.
  try {
    await runPnpmInstall(projectDir);
    process.stdout.write(`  ${G}✓${R} ${D}Installed dependencies${R}\n`);
  } catch {
    process.stdout.write(
      `  ${YW}!${R} Could not install dependencies — run ${D}pnpm install${R} manually\n`,
    );
  }

  const gitOk = await gitInit(projectDir);
  if (gitOk) {
    process.stdout.write(`  ${G}✓${R} ${D}Initialized git${R}\n`);
  }

  process.stdout.write(`  ${G}✓${R} ${B}${projectName}${R} is ready\n`);
  process.stdout.write("\n");
  process.stdout.write(`  ${B}Get started${R}\n`);
  process.stdout.write("\n");
  process.stdout.write(`    ${D}$${R} cd ${projectName}\n`);
  process.stdout.write("\n");
  process.stdout.write(`    ${CY}Web UI${R}          ${D}$${R} poncho dev\n`);
  process.stdout.write(`    ${CY}CLI interactive${R}  ${D}$${R} poncho run --interactive\n`);
  process.stdout.write("\n");
  if (onboarding.envNeedsUserInput) {
    process.stdout.write(
      `  ${YW}!${R} Make sure you add your keys to the ${B}.env${R} file.\n`,
    );
  }
  process.stdout.write(`  ${D}The agent will introduce itself on your first session.${R}\n`);
  process.stdout.write("\n");
};

export const updateAgentGuidance = async (workingDir: string): Promise<boolean> => {
  const agentPath = resolve(workingDir, "AGENT.md");
  const content = await readFile(agentPath, "utf8");
  const guidanceSectionPattern =
    /\n## Configuration Assistant Context[\s\S]*?(?=\n## |\n# |$)|\n## Skill Authoring Guidance[\s\S]*?(?=\n## |\n# |$)/g;
  const normalized = content.replace(/\s+$/g, "");
  const updated = normalized.replace(guidanceSectionPattern, "").replace(/\n{3,}/g, "\n\n");
  if (updated === normalized) {
    process.stdout.write("AGENT.md does not contain deprecated embedded local guidance.\n");
    return false;
  }
  await writeFile(agentPath, `${updated}\n`, "utf8");
  process.stdout.write("Removed deprecated embedded local guidance from AGENT.md.\n");
  return true;
};
