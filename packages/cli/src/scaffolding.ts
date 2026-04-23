import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAgentMarkdown,
  loadPonchoConfig,
  type CronJobConfig,
  type PonchoConfig,
} from "@poncho-ai/harness";
import type { DeployTarget } from "./init-onboarding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(__dirname, "..");

export const ensureFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
};

type DeployScaffoldTarget = Exclude<DeployTarget, "none">;

export const normalizeDeployTarget = (target: string): DeployScaffoldTarget => {
  const normalized = target.toLowerCase();
  if (
    normalized === "vercel" ||
    normalized === "docker" ||
    normalized === "lambda" ||
    normalized === "fly"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported build target: ${target}`);
};

export const readCliVersion = async (): Promise<string> => {
  const fallback = "0.1.0";
  try {
    const packageJsonPath = resolve(packageRoot, "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // Use fallback when package metadata cannot be read.
  }
  return fallback;
};

export const readCliDependencyVersion = async (
  dependencyName: string,
  fallback: string,
): Promise<string> => {
  try {
    const packageJsonPath = resolve(packageRoot, "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { dependencies?: Record<string, unknown> };
    const value = parsed.dependencies?.[dependencyName];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  } catch {
    // Use fallback when package metadata cannot be read.
  }
  return fallback;
};

export const writeScaffoldFile = async (
  filePath: string,
  content: string,
  options: { force?: boolean; writtenPaths: string[]; baseDir: string },
): Promise<void> => {
  if (!options.force) {
    try {
      await access(filePath);
      throw new Error(
        `Refusing to overwrite existing file: ${relative(options.baseDir, filePath)}. Re-run with --force to overwrite.`,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Refusing to overwrite")) {
        // File does not exist, safe to continue.
      } else {
        throw error;
      }
    }
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  options.writtenPaths.push(relative(options.baseDir, filePath));
};

export const UPLOAD_PROVIDER_DEPS: Record<string, Array<{ name: string; fallback: string }>> = {
  "vercel-blob": [{ name: "@vercel/blob", fallback: "^2.3.0" }],
  s3: [
    { name: "@aws-sdk/client-s3", fallback: "^3.700.0" },
    { name: "@aws-sdk/s3-request-presigner", fallback: "^3.700.0" },
  ],
};

export const ensureRuntimeCliDependency = async (
  projectDir: string,
  cliVersion: string,
  config?: PonchoConfig,
  target?: string,
): Promise<{ paths: string[]; addedDeps: string[] }> => {
  const packageJsonPath = resolve(projectDir, "package.json");
  const content = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...(parsed.dependencies ?? {}) };
  const isLocalOnlySpecifier = (value: string | undefined): boolean =>
    typeof value === "string" &&
    (value.startsWith("link:") || value.startsWith("workspace:") || value.startsWith("file:"));

  // Deployment projects should not depend on local monorepo paths.
  if (isLocalOnlySpecifier(dependencies["@poncho-ai/harness"])) {
    delete dependencies["@poncho-ai/harness"];
  }
  if (isLocalOnlySpecifier(dependencies["@poncho-ai/sdk"])) {
    delete dependencies["@poncho-ai/sdk"];
  }
  dependencies.marked = await readCliDependencyVersion("marked", "^17.0.2");
  dependencies["@poncho-ai/cli"] = `^${cliVersion}`;

  const addedDeps: string[] = [];
  const uploadsProvider = config?.uploads?.provider;
  if (uploadsProvider && UPLOAD_PROVIDER_DEPS[uploadsProvider]) {
    for (const dep of UPLOAD_PROVIDER_DEPS[uploadsProvider]) {
      if (!dependencies[dep.name]) {
        dependencies[dep.name] = dep.fallback;
        addedDeps.push(dep.name);
      }
    }
  }

  if (target === "vercel" && !dependencies["@vercel/functions"]) {
    dependencies["@vercel/functions"] = "^1.0.0";
    addedDeps.push("@vercel/functions");
  }

  parsed.dependencies = dependencies;
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { paths: [relative(projectDir, packageJsonPath)], addedDeps };
};

export const checkVercelCronDrift = async (projectDir: string): Promise<void> => {
  const vercelJsonPath = resolve(projectDir, "vercel.json");
  try {
    await access(vercelJsonPath);
  } catch {
    return;
  }
  let agentCrons: Record<string, CronJobConfig> = {};
  try {
    const agentMd = await readFile(resolve(projectDir, "AGENT.md"), "utf8");
    const parsed = parseAgentMarkdown(agentMd);
    agentCrons = parsed.frontmatter.cron ?? {};
  } catch {
    return;
  }
  let vercelCrons: Array<{ path: string; schedule: string }> = [];
  try {
    const raw = await readFile(vercelJsonPath, "utf8");
    const vercelConfig = JSON.parse(raw) as { crons?: Array<{ path: string; schedule: string }> };
    vercelCrons = vercelConfig.crons ?? [];
  } catch {
    return;
  }
  const vercelCronMap = new Map(
    vercelCrons
      .filter((c) => c.path.startsWith("/api/cron/"))
      .map((c) => [decodeURIComponent(c.path.replace("/api/cron/", "")), c.schedule]),
  );
  const diffs: string[] = [];
  for (const [jobName, job] of Object.entries(agentCrons)) {
    const existing = vercelCronMap.get(jobName);
    if (!existing) {
      diffs.push(`  + missing job "${jobName}" (${job.schedule})`);
    } else if (existing !== job.schedule) {
      diffs.push(`  ~ "${jobName}" schedule changed: "${existing}" → "${job.schedule}"`);
    }
    vercelCronMap.delete(jobName);
  }
  for (const [jobName, schedule] of vercelCronMap) {
    diffs.push(`  - removed job "${jobName}" (${schedule})`);
  }

  // Check reminder polling cron
  try {
    const cfg = await loadPonchoConfig(projectDir);
    const reminderCron = vercelCrons.find((c) => c.path === "/api/reminders/check");
    if (cfg?.reminders?.enabled && !reminderCron) {
      diffs.push(`  + missing reminders polling cron`);
    } else if (!cfg?.reminders?.enabled && reminderCron) {
      diffs.push(`  - reminders polling cron present but reminders disabled`);
    } else if (cfg?.reminders?.enabled && reminderCron) {
      const expected = cfg.reminders.pollSchedule ?? "*/10 * * * *";
      if (reminderCron.schedule !== expected) {
        diffs.push(`  ~ reminders poll schedule changed: "${reminderCron.schedule}" → "${expected}"`);
      }
    }
  } catch { /* best-effort */ }

  if (diffs.length > 0) {
    process.stderr.write(
      `\u26A0 vercel.json crons are out of sync with AGENT.md / poncho.config.js:\n${diffs.join("\n")}\n  Run \`poncho build vercel --force\` to update.\n\n`,
    );
  }
};

export const scaffoldDeployTarget = async (
  projectDir: string,
  target: DeployScaffoldTarget,
  options?: { force?: boolean },
): Promise<string[]> => {
  const writtenPaths: string[] = [];
  const cliVersion = await readCliVersion();
  const sharedServerEntrypoint = `import { startDevServer } from "@poncho-ai/cli";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
await startDevServer(Number.isNaN(port) ? 3000 : port, { workingDir: process.cwd() });
`;

  if (target === "vercel") {
    // Build @vercel/nft trace hints for packages that are dynamically loaded
    // at runtime.  Bare `import("pkg")` with a string literal is enough for
    // nft to include the package in the bundle.  Using async import() avoids
    // blocking the module graph at cold start; .catch() prevents errors when
    // an optional package isn't installed.
    const traceHints: string[] = [];

    let browserEnabled = false;
    try {
      const cfg = await loadPonchoConfig(projectDir);
      browserEnabled = !!cfg?.browser;
    } catch { /* best-effort */ }

    if (browserEnabled) {
      traceHints.push(`import("@poncho-ai/browser").catch(() => {});`);

      const projectPkgPath = resolve(projectDir, "package.json");
      try {
        const raw = await readFile(projectPkgPath, "utf8");
        const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
        if (pkg.dependencies?.["@sparticuz/chromium"]) {
          traceHints.push(`import("@sparticuz/chromium").catch(() => {});`);
        }
      } catch { /* best-effort */ }
    }

    const traceBlock = traceHints.length > 0
      ? `\n${traceHints.join("\n")}\n`
      : "";

    const entryPath = resolve(projectDir, "api", "index.mjs");
    await writeScaffoldFile(
      entryPath,
      `import "marked";${traceBlock}
import { createRequestHandler } from "@poncho-ai/cli";
let handlerPromise;
export default async function handler(req, res) {
  try {
    if (!handlerPromise) {
      handlerPromise = createRequestHandler({ workingDir: process.cwd() });
    }
    const requestHandler = await handlerPromise;
    await requestHandler(req, res);
  } catch (error) {
    console.error("Handler error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: error?.message || "Unknown error" }));
    }
  }
}
`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    const vercelConfigPath = resolve(projectDir, "vercel.json");
    let vercelCrons: Array<{ path: string; schedule: string }> | undefined;
    try {
      const agentMd = await readFile(resolve(projectDir, "AGENT.md"), "utf8");
      const parsed = parseAgentMarkdown(agentMd);
      if (parsed.frontmatter.cron) {
        vercelCrons = Object.entries(parsed.frontmatter.cron).map(
          ([jobName, job]) => ({
            path: `/api/cron/${encodeURIComponent(jobName)}`,
            schedule: job.schedule,
          }),
        );
      }
    } catch {
      // AGENT.md may not exist yet during init; skip cron generation
    }
    let existingVercelConfig: Record<string, unknown> = {};
    try {
      const raw = await readFile(vercelConfigPath, "utf8");
      existingVercelConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No existing vercel.json or invalid JSON — start fresh
    }
    const existingFunctions = (existingVercelConfig.functions ?? {}) as Record<string, Record<string, unknown>>;
    const existingApiEntry = existingFunctions["api/index.mjs"] ?? {};
    const vercelConfig: Record<string, unknown> = {
      ...existingVercelConfig,
      version: 2,
      functions: {
        ...existingFunctions,
        "api/index.mjs": {
          ...existingApiEntry,
          includeFiles:
            "{AGENT.md,poncho.config.js,skills/**,tests/**,node_modules/.pnpm/marked@*/node_modules/marked/lib/marked.umd.js}",
        },
      },
      headers: [
        {
          source: "/api/(.*)",
          headers: [
            { key: "Cache-Control", value: "private, no-cache, no-store, must-revalidate" },
          ],
        },
      ],
      routes: [{ src: "/(.*)", dest: "/api/index.mjs" }],
    };
    // Add reminder polling cron if reminders are enabled
    try {
      const cfg = await loadPonchoConfig(projectDir);
      if (cfg?.reminders?.enabled) {
        const schedule = cfg.reminders.pollSchedule ?? "*/10 * * * *";
        if (!vercelCrons) vercelCrons = [];
        vercelCrons.push({ path: "/api/reminders/check", schedule });
      }
    } catch { /* best-effort */ }

    if (vercelCrons && vercelCrons.length > 0) {
      vercelConfig.crons = vercelCrons;
    }
    await writeScaffoldFile(
      vercelConfigPath,
      `${JSON.stringify(vercelConfig, null, 2)}\n`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
  } else if (target === "docker") {
    const dockerfilePath = resolve(projectDir, "Dockerfile");
    await writeScaffoldFile(
      dockerfilePath,
      `FROM node:20-slim
WORKDIR /app
COPY package.json package.json
COPY AGENT.md AGENT.md
COPY poncho.config.js poncho.config.js
COPY skills skills
COPY tests tests
COPY .env.example .env.example
RUN corepack enable && npm install -g @poncho-ai/cli@^${cliVersion}
COPY server.js server.js
EXPOSE 3000
CMD ["node","server.js"]
`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    await writeScaffoldFile(resolve(projectDir, "server.js"), sharedServerEntrypoint, {
      force: options?.force,
      writtenPaths,
      baseDir: projectDir,
    });
  } else if (target === "lambda") {
    await writeScaffoldFile(
      resolve(projectDir, "lambda-handler.js"),
      `import { startDevServer } from "@poncho-ai/cli";
let serverPromise;
export const handler = async (event = {}) => {
  if (!serverPromise) {
    serverPromise = startDevServer(0, { workingDir: process.cwd() });
  }
  const body = JSON.stringify({
    status: "ready",
    route: event.rawPath ?? event.path ?? "/",
  });
  return { statusCode: 200, headers: { "content-type": "application/json" }, body };
};

// Cron jobs: use AWS EventBridge (CloudWatch Events) to trigger scheduled invocations.
// Create a rule for each cron job defined in AGENT.md that sends a GET request to:
//   /api/cron/<jobName>
// Include the Authorization header with your PONCHO_AUTH_TOKEN as a Bearer token.
//
// Reminders: Create a CloudWatch Events rule that triggers GET /api/reminders/check
// every 10 minutes (or your preferred interval) with Authorization: Bearer <PONCHO_AUTH_TOKEN>.
`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
  } else if (target === "fly") {
    await writeScaffoldFile(
      resolve(projectDir, "fly.toml"),
      `app = "poncho-app"
[env]
  PORT = "3000"
[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "stop"
  min_machines_running = 0
`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    await writeScaffoldFile(
      resolve(projectDir, "Dockerfile"),
      `FROM node:20-slim
WORKDIR /app
COPY package.json package.json
COPY AGENT.md AGENT.md
COPY poncho.config.js poncho.config.js
COPY skills skills
COPY tests tests
RUN npm install -g @poncho-ai/cli@^${cliVersion}
COPY server.js server.js
EXPOSE 3000
CMD ["node","server.js"]
`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    await writeScaffoldFile(resolve(projectDir, "server.js"), sharedServerEntrypoint, {
      force: options?.force,
      writtenPaths,
      baseDir: projectDir,
    });
  }

  const config = await loadPonchoConfig(projectDir);
  const { paths: packagePaths, addedDeps } = await ensureRuntimeCliDependency(
    projectDir,
    cliVersion,
    config,
    target,
  );
  const depNote = addedDeps.length > 0 ? ` (added ${addedDeps.join(", ")})` : "";
  for (const p of packagePaths) {
    if (!writtenPaths.includes(p)) {
      writtenPaths.push(depNote ? `${p}${depNote}` : p);
    }
  }

  return writtenPaths;
};

export const serializeJs = (value: unknown, indent = 0): string => {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);
  if (value === null || value === undefined) return String(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `${padInner}${serializeJs(v, indent + 1)}`);
    return `[\n${items.join(",\n")},\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const lines = entries.map(([k, v]) => {
      const key = safeKey.test(k) ? k : JSON.stringify(k);
      return `${padInner}${key}: ${serializeJs(v, indent + 1)}`;
    });
    return `{\n${lines.join(",\n")},\n${pad}}`;
  }
  return String(value);
};

export const renderConfigFile = (config: PonchoConfig): string =>
  `export default ${serializeJs(config)}\n`;

export const writeConfigFile = async (workingDir: string, config: PonchoConfig): Promise<void> => {
  const serialized = renderConfigFile(config);
  await writeFile(resolve(workingDir, "poncho.config.js"), serialized, "utf8");
};

export const ensureEnvPlaceholder = async (filePath: string, key: string): Promise<boolean> => {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return false;
  }
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, `${normalizedKey}=\n`, "utf8");
    return true;
  }
  const present = content
    .split(/\r?\n/)
    .some((line) => line.trimStart().startsWith(`${normalizedKey}=`));
  if (present) {
    return false;
  }
  const withTrailingNewline = content.length === 0 || content.endsWith("\n")
    ? content
    : `${content}\n`;
  await writeFile(filePath, `${withTrailingNewline}${normalizedKey}=\n`, "utf8");
  return true;
};

export const removeEnvPlaceholder = async (filePath: string, key: string): Promise<boolean> => {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return false;
  }
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => !line.trimStart().startsWith(`${normalizedKey}=`));
  if (filtered.length === lines.length) {
    return false;
  }
  const nextContent = filtered.join("\n").replace(/\n+$/, "");
  await writeFile(filePath, nextContent.length > 0 ? `${nextContent}\n` : "", "utf8");
  return true;
};
