import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { ToolDefinition } from "@poncho-ai/sdk";
import { resolveSkillDirs } from "./skill-context.js";

const TOOL_FILE_PATTERN = /\.(?:[cm]?js|[cm]?ts)$/i;

const collectToolFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectToolFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && TOOL_FILE_PATTERN.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
};

const loadToolModule = async (filePath: string): Promise<unknown> => {
  try {
    const module = await import(pathToFileURL(filePath).href);
    return module;
  } catch {
    try {
      const jiti = createJiti(import.meta.url, { interopDefault: true });
      return await jiti.import(filePath);
    } catch {
      const source = await readFile(filePath, "utf8");
      const shimmed = source.replace(
        /import\s+\{\s*defineTool\s*\}\s+from\s+["']@poncho-ai\/(?:sdk|harness)["'];?\s*/g,
        "const defineTool = (definition) => definition;\n",
      );
      const dataUrl = `data:text/javascript;base64,${Buffer.from(shimmed, "utf8").toString("base64")}`;
      return await import(dataUrl);
    }
  }
};

const normalizeToolExports = (loaded: unknown): ToolDefinition[] => {
  const module = loaded as {
    default?: unknown;
    tools?: unknown;
    [key: string]: unknown;
  };
  const candidates = [
    module.default,
    module.tools,
    ...Object.values(module).filter((value) => value && typeof value === "object"),
  ];

  const toolDefinitions = candidates
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(
      (value): value is ToolDefinition =>
        Boolean(value) &&
        typeof value === "object" &&
        "name" in value &&
        "description" in value &&
        "inputSchema" in value &&
        "handler" in value,
    );

  return toolDefinitions;
};

export const loadLocalSkillTools = async (
  workingDir: string,
  extraSkillPaths?: string[],
): Promise<ToolDefinition[]> => {
  const skillDirs = resolveSkillDirs(workingDir, extraSkillPaths);
  const allToolFiles: string[] = [];

  for (const dir of skillDirs) {
    try {
      allToolFiles.push(...(await collectToolFiles(dir)));
    } catch {
      // Directory doesn't exist or isn't readable — skip silently.
    }
  }

  const tools: ToolDefinition[] = [];
  for (const filePath of allToolFiles) {
    try {
      const loaded = await loadToolModule(filePath);
      tools.push(...normalizeToolExports(loaded));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[poncho] Skipping skill tool module ${filePath}: ${message}\n`,
      );
    }
  }

  const unique = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    unique.set(tool.name, tool);
  }
  return [...unique.values()];
};
