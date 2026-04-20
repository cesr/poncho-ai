import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  LocalMcpBridge,
  loadPonchoConfig,
} from "@poncho-ai/harness";
import dotenv from "dotenv";
import {
  writeConfigFile,
  ensureEnvPlaceholder,
  removeEnvPlaceholder,
} from "./scaffolding.js";

const normalizeMcpName = (entry: { url?: string; name?: string }): string =>
  entry.name ?? entry.url ?? `mcp_${Date.now()}`;

export { normalizeMcpName };

export const mcpAdd = async (
  workingDir: string,
  options: {
    url?: string;
    name?: string;
    envVars?: string[];
    authBearerEnv?: string;
    headers?: string[];
  },
): Promise<void> => {
  const config = (await loadPonchoConfig(workingDir)) ?? { mcp: [] };
  const mcp = [...(config.mcp ?? [])];
  if (!options.url) {
    throw new Error("Remote MCP only: provide --url for a remote MCP server.");
  }
  if (options.url.startsWith("ws://") || options.url.startsWith("wss://")) {
    throw new Error("WebSocket MCP URLs are no longer supported. Use an HTTP MCP endpoint.");
  }
  if (!options.url.startsWith("http://") && !options.url.startsWith("https://")) {
    throw new Error("Invalid MCP URL. Expected http:// or https://.");
  }
  const parsedHeaders: Record<string, string> | undefined =
    options.headers && options.headers.length > 0
      ? Object.fromEntries(
          options.headers.map((h) => {
            const idx = h.indexOf(":");
            if (idx < 1) {
              throw new Error(`Invalid header format "${h}". Expected "Name: value".`);
            }
            return [h.slice(0, idx).trim(), h.slice(idx + 1).trim()];
          }),
        )
      : undefined;
  const serverName = options.name ?? normalizeMcpName({ url: options.url });
  mcp.push({
    name: serverName,
    url: options.url,
    env: options.envVars ?? [],
    auth: options.authBearerEnv
      ? {
          type: "bearer",
          tokenEnv: options.authBearerEnv,
        }
      : undefined,
    headers: parsedHeaders,
  });

  await writeConfigFile(workingDir, { ...config, mcp });
  let envSeedMessage: string | undefined;
  if (options.authBearerEnv) {
    const envPath = resolve(workingDir, ".env");
    const envExamplePath = resolve(workingDir, ".env.example");
    const addedEnv = await ensureEnvPlaceholder(envPath, options.authBearerEnv);
    const addedEnvExample = await ensureEnvPlaceholder(envExamplePath, options.authBearerEnv);
    if (addedEnv || addedEnvExample) {
      envSeedMessage = `Added ${options.authBearerEnv}= to ${addedEnv ? ".env" : ""}${addedEnv && addedEnvExample ? " and " : ""}${addedEnvExample ? ".env.example" : ""}.`;
    }
  }
  const nextSteps: string[] = [];
  let step = 1;
  if (options.authBearerEnv) {
    nextSteps.push(`  ${step}) Set token in .env: ${options.authBearerEnv}=...`);
    step += 1;
  }
  nextSteps.push(`  ${step}) Discover tools: poncho mcp tools list ${serverName}`);
  step += 1;
  nextSteps.push(`  ${step}) Select tools:   poncho mcp tools select ${serverName}`);
  step += 1;
  nextSteps.push(`  ${step}) Verify config:  poncho mcp list`);
  process.stdout.write(
    [
      `MCP server added: ${serverName}`,
      ...(envSeedMessage ? [envSeedMessage] : []),
      "Next steps:",
      ...nextSteps,
      "",
    ].join("\n"),
  );
};

export const mcpList = async (workingDir: string): Promise<void> => {
  const config = await loadPonchoConfig(workingDir);
  const mcp = config?.mcp ?? [];
  if (mcp.length === 0) {
    process.stdout.write("No MCP servers configured.\n");
    return;
  }
  process.stdout.write("Configured MCP servers:\n");
  for (const entry of mcp) {
    const auth =
      entry.auth?.type === "bearer" ? `auth=bearer:${entry.auth.tokenEnv}` : "auth=none";
    const headerKeys = entry.headers ? Object.keys(entry.headers) : [];
    const headerInfo = headerKeys.length > 0 ? `, headers=${headerKeys.join(",")}` : "";
    process.stdout.write(
      `- ${entry.name ?? entry.url} (remote: ${entry.url}, ${auth}${headerInfo})\n`,
    );
  }
};

export const mcpRemove = async (workingDir: string, name: string): Promise<void> => {
  const config = (await loadPonchoConfig(workingDir)) ?? { mcp: [] };
  const before = config.mcp ?? [];
  const removed = before.filter((entry) => normalizeMcpName(entry) === name);
  const filtered = before.filter((entry) => normalizeMcpName(entry) !== name);
  await writeConfigFile(workingDir, { ...config, mcp: filtered });
  const removedTokenEnvNames = new Set(
    removed
      .map((entry) =>
        entry.auth?.type === "bearer" ? entry.auth.tokenEnv?.trim() ?? "" : "",
      )
      .filter((value) => value.length > 0),
  );
  const stillUsedTokenEnvNames = new Set(
    filtered
      .map((entry) =>
        entry.auth?.type === "bearer" ? entry.auth.tokenEnv?.trim() ?? "" : "",
      )
      .filter((value) => value.length > 0),
  );
  const removedFromExample: string[] = [];
  for (const tokenEnv of removedTokenEnvNames) {
    if (stillUsedTokenEnvNames.has(tokenEnv)) {
      continue;
    }
    const changed = await removeEnvPlaceholder(resolve(workingDir, ".env.example"), tokenEnv);
    if (changed) {
      removedFromExample.push(tokenEnv);
    }
  }
  process.stdout.write(`Removed MCP server: ${name}\n`);
  if (removedFromExample.length > 0) {
    process.stdout.write(
      `Removed unused token placeholder(s) from .env.example: ${removedFromExample.join(", ")}\n`,
    );
  }
};

const resolveMcpEntry = async (
  workingDir: string,
  serverName: string,
): Promise<{ config: import("@poncho-ai/harness").PonchoConfig; index: number }> => {
  const config = (await loadPonchoConfig(workingDir)) ?? { mcp: [] };
  const entries = config.mcp ?? [];
  const index = entries.findIndex((entry) => normalizeMcpName(entry) === serverName);
  if (index < 0) {
    throw new Error(`MCP server "${serverName}" is not configured.`);
  }
  return { config, index };
};

export { resolveMcpEntry };

const discoverMcpTools = async (
  workingDir: string,
  serverName: string,
): Promise<string[]> => {
  dotenv.config({ path: resolve(workingDir, ".env") });
  const { config, index } = await resolveMcpEntry(workingDir, serverName);
  const entry = (config.mcp ?? [])[index];
  const bridge = new LocalMcpBridge({ mcp: [entry] });
  try {
    await bridge.startLocalServers();
    await bridge.discoverTools();
    return bridge.listDiscoveredTools(normalizeMcpName(entry));
  } finally {
    await bridge.stopLocalServers();
  }
};

export { discoverMcpTools };

export const mcpToolsList = async (
  workingDir: string,
  serverName: string,
): Promise<void> => {
  const discovered = await discoverMcpTools(workingDir, serverName);
  if (discovered.length === 0) {
    process.stdout.write(`No tools discovered for MCP server "${serverName}".\n`);
    return;
  }
  process.stdout.write(`Discovered tools for "${serverName}":\n`);
  for (const tool of discovered) {
    process.stdout.write(`- ${tool}\n`);
  }
};

export const mcpToolsSelect = async (
  workingDir: string,
  serverName: string,
  options: {
    all?: boolean;
    toolsCsv?: string;
  },
): Promise<void> => {
  const discovered = await discoverMcpTools(workingDir, serverName);
  if (discovered.length === 0) {
    process.stdout.write(`No tools discovered for MCP server "${serverName}".\n`);
    return;
  }
  let selected: string[] = [];
  if (options.all) {
    selected = [...discovered];
  } else if (options.toolsCsv && options.toolsCsv.trim().length > 0) {
    const requested = options.toolsCsv
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    selected = discovered.filter((tool) => requested.includes(tool));
  } else {
    process.stdout.write(`Discovered tools for "${serverName}":\n`);
    discovered.forEach((tool, idx) => {
      process.stdout.write(`${idx + 1}. ${tool}\n`);
    });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      "Enter comma-separated tool numbers/names to allow (or * for all): ",
    );
    rl.close();
    const raw = answer.trim();
    if (raw === "*") {
      selected = [...discovered];
    } else {
      const tokens = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const fromIndex = tokens
        .map((token) => Number.parseInt(token, 10))
        .filter((value) => !Number.isNaN(value))
        .map((index) => discovered[index - 1])
        .filter((value): value is string => typeof value === "string");
      const byName = discovered.filter((tool) => tokens.includes(tool));
      selected = [...new Set([...fromIndex, ...byName])];
    }
  }
  if (selected.length === 0) {
    throw new Error("No valid tools selected.");
  }
  const includePatterns =
    selected.length === discovered.length
      ? [`${serverName}/*`]
      : selected.sort();
  process.stdout.write(`Selected MCP tools: ${includePatterns.join(", ")}\n`);
  process.stdout.write(
    "\nRequired next step: add MCP intent in AGENT.md or SKILL.md allowed-tools. Without this, these MCP tools will not be registered for the model.\n",
  );
  process.stdout.write(
    "\nOption A: AGENT.md (global fallback intent)\n" +
      "Paste this into AGENT.md frontmatter:\n" +
      "---\n" +
      "allowed-tools:\n" +
      includePatterns.map((tool) => `  - mcp:${tool}`).join("\n") +
      "\n---\n",
  );
  process.stdout.write(
    "\nOption B: SKILL.md (only when that skill is activated)\n" +
      "Paste this into SKILL.md frontmatter:\n" +
      "---\n" +
      "allowed-tools:\n" +
      includePatterns.map((tool) => `  - mcp:${tool}`).join("\n") +
      "\napproval-required:\n" +
      includePatterns.map((tool) => `  - mcp:${tool}`).join("\n") +
      "\n---\n",
  );
};
