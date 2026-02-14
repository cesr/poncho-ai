import { defineTool, type ToolDefinition } from "@agentl/sdk";
import { access, readdir } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { SkillMetadata } from "./skill-context.js";
import { loadSkillInstructions, readSkillResource } from "./skill-context.js";

/**
 * Creates the built-in skill tools that implement progressive disclosure
 * per the Agent Skills specification (https://agentskills.io/integrate-skills).
 *
 * - `activate_skill`  — loads the full SKILL.md body on demand
 * - `read_skill_resource` — reads a file from a skill directory (references, scripts, assets)
 * - `list_skill_scripts` — lists runnable JavaScript/TypeScript scripts under scripts/
 * - `run_skill_script` — executes a JavaScript/TypeScript module under scripts/
 */
export const createSkillTools = (
  skills: SkillMetadata[],
): ToolDefinition[] => {
  if (skills.length === 0) {
    return [];
  }

  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const knownNames = skills.map((skill) => skill.name).join(", ");

  return [
    defineTool({
      name: "activate_skill",
      description:
        "Load the full instructions for an available skill. " +
        "Use this when a user's request matches a skill's description. " +
        `Available skills: ${knownNames}`,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the skill to activate",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        const skill = skillsByName.get(name);
        if (!skill) {
          return {
            error: `Unknown skill: "${name}". Available skills: ${knownNames}`,
          };
        }
        try {
          const instructions = await loadSkillInstructions(skill);
          return {
            skill: name,
            instructions: instructions || "(no instructions provided)",
          };
        } catch (err) {
          return {
            error: `Failed to load skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
    defineTool({
      name: "read_skill_resource",
      description:
        "Read a file from a skill's directory (references, scripts, assets). " +
        "Use relative paths from the skill root. " +
        `Available skills: ${knownNames}`,
      inputSchema: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: "Name of the skill",
          },
          path: {
            type: "string",
            description:
              "Relative path to the file within the skill directory (e.g. references/REFERENCE.md)",
          },
        },
        required: ["skill", "path"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const name = typeof input.skill === "string" ? input.skill.trim() : "";
        const path = typeof input.path === "string" ? input.path.trim() : "";
        const skill = skillsByName.get(name);
        if (!skill) {
          return {
            error: `Unknown skill: "${name}". Available skills: ${knownNames}`,
          };
        }
        if (!path) {
          return { error: "Path is required" };
        }
        try {
          const content = await readSkillResource(skill, path);
          return { skill: name, path, content };
        } catch (err) {
          return {
            error: `Failed to read "${path}" from skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
    defineTool({
      name: "list_skill_scripts",
      description:
        "List JavaScript/TypeScript script files available under a skill's scripts directory. " +
        `Available skills: ${knownNames}`,
      inputSchema: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: "Name of the skill",
          },
        },
        required: ["skill"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const name = typeof input.skill === "string" ? input.skill.trim() : "";
        const skill = skillsByName.get(name);
        if (!skill) {
          return {
            error: `Unknown skill: "${name}". Available skills: ${knownNames}`,
          };
        }
        try {
          const scripts = await listSkillScripts(skill);
          return {
            skill: name,
            scripts,
          };
        } catch (err) {
          return {
            error: `Failed to list scripts for skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
    defineTool({
      name: "run_skill_script",
      description:
        "Run a JavaScript/TypeScript module in a skill's scripts directory. " +
        "Uses default export function or named run/main/handler function. " +
        `Available skills: ${knownNames}`,
      inputSchema: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: "Name of the skill",
          },
          script: {
            type: "string",
            description:
              "Relative path under scripts/ (e.g. scripts/summarize.ts or summarize.ts)",
          },
          input: {
            type: "object",
            description: "Optional JSON input payload passed to the script function",
          },
        },
        required: ["skill", "script"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const name = typeof input.skill === "string" ? input.skill.trim() : "";
        const script = typeof input.script === "string" ? input.script.trim() : "";
        const payload =
          typeof input.input === "object" && input.input !== null
            ? (input.input as Record<string, unknown>)
            : {};

        const skill = skillsByName.get(name);
        if (!skill) {
          return {
            error: `Unknown skill: "${name}". Available skills: ${knownNames}`,
          };
        }
        if (!script) {
          return { error: "Script path is required" };
        }

        try {
          const scriptPath = resolveSkillScriptPath(skill, script);
          await access(scriptPath);
          const fn = await loadRunnableScriptFunction(scriptPath);
          const output = await fn(payload, {
            skill: name,
            skillDir: skill.skillDir,
            scriptPath,
          });
          return {
            skill: name,
            script,
            output,
          };
        } catch (err) {
          return {
            error: `Failed to run script "${script}" in skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
  ];
};

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

const listSkillScripts = async (skill: SkillMetadata): Promise<string[]> => {
  const scriptsRoot = resolve(skill.skillDir, "scripts");
  try {
    await access(scriptsRoot);
  } catch {
    return [];
  }

  const scripts = await collectScriptFiles(scriptsRoot);
  return scripts
    .map((fullPath) => `scripts/${fullPath.slice(scriptsRoot.length + 1).split(sep).join("/")}`)
    .sort();
};

const collectScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectScriptFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      const extension = extname(fullPath).toLowerCase();
      if (SCRIPT_EXTENSIONS.has(extension)) {
        files.push(fullPath);
      }
    }
  }
  return files;
};

const resolveSkillScriptPath = (skill: SkillMetadata, relativePath: string): string => {
  const normalized = normalize(relativePath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new Error("Script path must be relative and within the skill directory");
  }

  const normalizedWithPrefix = normalized.startsWith("scripts/")
    ? normalized
    : `scripts/${normalized}`;
  const fullPath = resolve(skill.skillDir, normalizedWithPrefix);
  const scriptsRoot = resolve(skill.skillDir, "scripts");

  if (!fullPath.startsWith(`${scriptsRoot}${sep}`) && fullPath !== scriptsRoot) {
    throw new Error("Script path must stay inside the scripts directory");
  }

  const extension = extname(fullPath).toLowerCase();
  if (!SCRIPT_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported script extension "${extension || "(none)"}". Allowed: ${[...SCRIPT_EXTENSIONS].join(", ")}`,
    );
  }

  return fullPath;
};

type RunnableScriptFunction = (
  input: Record<string, unknown>,
  context: {
    skill: string;
    skillDir: string;
    scriptPath: string;
  },
) => unknown | Promise<unknown>;

const loadRunnableScriptFunction = async (
  scriptPath: string,
): Promise<RunnableScriptFunction> => {
  const loaded = await loadScriptModule(scriptPath);
  const fn = extractRunnableFunction(loaded);
  if (!fn) {
    throw new Error(
      "Script module must export a function (default export or named run/main/handler)",
    );
  }
  return fn;
};

const loadScriptModule = async (scriptPath: string): Promise<unknown> => {
  try {
    return await import(pathToFileURL(scriptPath).href);
  } catch {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    return await jiti.import(scriptPath);
  }
};

const extractRunnableFunction = (value: unknown): RunnableScriptFunction | undefined => {
  if (typeof value === "function") {
    return value as RunnableScriptFunction;
  }
  if (Array.isArray(value) || typeof value !== "object" || value === null) {
    return undefined;
  }

  const module = value as {
    default?: unknown;
    run?: unknown;
    main?: unknown;
    handler?: unknown;
  };
  const defaultValue = module.default;
  if (typeof defaultValue === "function") {
    return defaultValue as RunnableScriptFunction;
  }
  if (typeof module.run === "function") {
    return module.run as RunnableScriptFunction;
  }
  if (typeof module.main === "function") {
    return module.main as RunnableScriptFunction;
  }
  if (typeof module.handler === "function") {
    return module.handler as RunnableScriptFunction;
  }
  if (
    defaultValue &&
    typeof defaultValue === "object" &&
    !Array.isArray(defaultValue)
  ) {
    const inner = defaultValue as {
      run?: unknown;
      main?: unknown;
      handler?: unknown;
    };
    if (typeof inner.run === "function") {
      return inner.run as RunnableScriptFunction;
    }
    if (typeof inner.main === "function") {
      return inner.main as RunnableScriptFunction;
    }
    if (typeof inner.handler === "function") {
      return inner.handler as RunnableScriptFunction;
    }
  }
  return undefined;
};
