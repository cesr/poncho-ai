import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import { access, readdir, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { SkillMetadata } from "./skill-context.js";
import { loadSkillInstructions, readSkillResource } from "./skill-context.js";
import type { StorageEngine } from "./storage/engine.js";

export interface CreateSkillToolsOptions {
  workingDir?: string;
  /** Resolve the skill set visible to a given tenant (repo + that tenant's VFS). */
  getSkills: (tenantId: string | undefined | null) => Promise<SkillMetadata[]>;
  /** Lazy accessor for the engine used for VFS reads when a skill's source is `vfs`. */
  storageEngine?: () => StorageEngine | undefined;
  onActivateSkill?: (name: string) => Promise<string[]> | string[];
  onDeactivateSkill?: (name: string) => Promise<string[]> | string[];
  onListActiveSkills?: () => string[];
  isScriptAllowed?: (skill: string, scriptPath: string) => boolean;
  isRootScriptAllowed?: (scriptPath: string) => boolean;
}

const findSkill = async (
  options: CreateSkillToolsOptions,
  tenantId: string | undefined | null,
  name: string,
): Promise<SkillMetadata | undefined> => {
  const skills = await options.getSkills(tenantId);
  return skills.find((skill) => skill.name === name);
};

export const createSkillTools = (options: CreateSkillToolsOptions): ToolDefinition[] => {
  return [
    defineTool({
      name: "activate_skill",
      description:
        "Load the full instructions for an available skill. " +
        "Use this when a user's request matches a skill's description. " +
        "Available skills are listed in the <available_skills> block of the system prompt.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the skill to activate" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        const skill = await findSkill(options, context.tenantId, name);
        if (!skill) {
          return { error: `Unknown skill: "${name}".` };
        }
        try {
          const instructions = await loadSkillInstructions(skill, options.storageEngine?.());
          const activeSkills = options.onActivateSkill
            ? await options.onActivateSkill(name)
            : [];
          return {
            skill: name,
            activeSkills,
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
      name: "deactivate_skill",
      description:
        "Deactivate a previously activated skill and update scoped tool availability.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the skill to deactivate" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) {
          return { error: "Skill name is required" };
        }
        try {
          const activeSkills = options.onDeactivateSkill
            ? await options.onDeactivateSkill(name)
            : [];
          return { skill: name, activeSkills };
        } catch (err) {
          return {
            error: `Failed to deactivate skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
    defineTool({
      name: "list_active_skills",
      description: "List currently active skills with scoped MCP tools.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({
        activeSkills: options.onListActiveSkills ? options.onListActiveSkills() : [],
      }),
    }),
    defineTool({
      name: "read_skill_resource",
      description:
        "Read a file from a skill's directory (references, scripts, assets). " +
        "Use relative paths from the skill root. " +
        "Available skills are listed in the <available_skills> block of the system prompt.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Name of the skill" },
          path: {
            type: "string",
            description:
              "Relative path to the file within the skill directory (e.g. references/REFERENCE.md)",
          },
        },
        required: ["skill", "path"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const name = typeof input.skill === "string" ? input.skill.trim() : "";
        const path = typeof input.path === "string" ? input.path.trim() : "";
        const skill = await findSkill(options, context.tenantId, name);
        if (!skill) {
          return { error: `Unknown skill: "${name}".` };
        }
        if (!path) {
          return { error: "Path is required" };
        }
        try {
          const content = await readSkillResource(skill, path, options.storageEngine?.());
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
        "List JavaScript/TypeScript script files available under a skill directory (recursive). " +
        "Available skills are listed in the <available_skills> block of the system prompt.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Name of the skill" },
        },
        required: ["skill"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const name = typeof input.skill === "string" ? input.skill.trim() : "";
        const skill = await findSkill(options, context.tenantId, name);
        if (!skill) {
          return { error: `Unknown skill: "${name}".` };
        }
        try {
          const scripts = skill.source.kind === "vfs"
            ? await listVfsSkillScripts(skill, options.storageEngine?.(), options.isScriptAllowed)
            : await listRepoSkillScripts(skill, options.isScriptAllowed);
          return { skill: name, scripts };
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
        "Run a JavaScript/TypeScript module shipped with a repo skill or under the project's scripts directory. " +
        "Scripts run with full Node access via jiti and must export a default function or named run/main/handler. " +
        "For VFS (tenant-authored) skills, use `run_code` with `file: '/skills/<name>/scripts/<file>.ts'` instead — " +
        "those scripts run in the sandboxed isolate.",
      inputSchema: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description:
              "Optional skill name. Omit to run a project-level script relative to AGENT.md directory.",
          },
          script: {
            type: "string",
            description:
              "Relative script path from the skill/project root (e.g. ./fetch-page.ts, scripts/summarize.ts)",
          },
          input: {
            type: "object",
            description: "Optional JSON input payload passed to the script function",
          },
        },
        required: ["script"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const name = typeof input.skill === "string" ? input.skill.trim() : "";
        const script = typeof input.script === "string" ? input.script.trim() : "";
        const payload =
          typeof input.input === "object" && input.input !== null
            ? (input.input as Record<string, unknown>)
            : {};

        if (!script) {
          return { error: "Script path is required" };
        }

        try {
          if (name) {
            const skill = await findSkill(options, context.tenantId, name);
            if (!skill) {
              return { error: `Unknown skill: "${name}".` };
            }
            if (skill.source.kind === "vfs") {
              const filePath = `${skill.skillDir}/${normalizeScriptPolicyPath(script)}`;
              return {
                error:
                  `Skill "${name}" is a VFS (tenant-authored) skill. ` +
                  `Use \`run_code\` with \`file: "${filePath}"\` (and \`input\` if needed) instead.`,
              };
            }
            const projectRoot = options.workingDir ?? process.cwd();
            const resolved = resolveScriptPath(skill.skillDir, script, projectRoot);
            if (
              options.isScriptAllowed &&
              !options.isScriptAllowed(name, resolved.relativePath)
            ) {
              return {
                error: `Script "${resolved.relativePath}" for skill "${name}" is not allowed by policy.`,
              };
            }
            await access(resolved.fullPath);
            const fn = await loadRunnableScriptFunction(resolved.fullPath);
            const output = await fn(payload, {
              scope: "skill",
              skill: name,
              scriptPath: resolved.fullPath,
            });
            return { skill: name, script: resolved.relativePath, output };
          }
          const baseDir = options.workingDir ?? process.cwd();
          const resolved = resolveScriptPath(baseDir, script);
          if (
            options.isRootScriptAllowed &&
            !options.isRootScriptAllowed(resolved.relativePath)
          ) {
            return {
              error: `Script "${resolved.relativePath}" is not allowed by policy.`,
            };
          }
          await access(resolved.fullPath);
          const fn = await loadRunnableScriptFunction(resolved.fullPath);
          const output = await fn(payload, {
            scope: "agent",
            scriptPath: resolved.fullPath,
          });
          return { skill: null, script: resolved.relativePath, output };
        } catch (err) {
          return {
            error: name
              ? `Failed to run script "${script}" in skill "${name}": ${err instanceof Error ? err.message : String(err)}`
              : `Failed to run script "${script}" from AGENT scope: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
  ];
};

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const VFS_SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts"]);

const listRepoSkillScripts = async (
  skill: SkillMetadata,
  isScriptAllowed?: (skill: string, scriptPath: string) => boolean,
): Promise<string[]> => {
  const scripts = await collectScriptFiles(skill.skillDir);
  return scripts
    .map((fullPath) => fullPath.slice(skill.skillDir.length + 1).split(sep).join("/"))
    .filter((relativePath) => relativePath.toLowerCase() !== "skill.md")
    .map((relativePath) =>
      relativePath.includes("/") ? relativePath : `./${relativePath}`,
    )
    .filter((path) => (isScriptAllowed ? isScriptAllowed(skill.name, path) : true))
    .sort();
};

const listVfsSkillScripts = async (
  skill: SkillMetadata,
  engine: StorageEngine | undefined,
  isScriptAllowed?: (skill: string, scriptPath: string) => boolean,
): Promise<string[]> => {
  if (!engine || skill.source.kind !== "vfs") return [];
  const tenantId = skill.source.tenantId;
  const dir = skill.skillDir;
  const found: string[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await engine.vfs.readdir(tenantId, current);
    for (const entry of entries) {
      const childPath = `${current}/${entry.name}`;
      if (entry.type === "directory") {
        await walk(childPath);
        continue;
      }
      if (entry.type !== "file") continue;
      const ext = extname(entry.name).toLowerCase();
      if (!VFS_SCRIPT_EXTENSIONS.has(ext)) continue;
      if (entry.name.toLowerCase() === "skill.md") continue;
      const rel = childPath.slice(dir.length + 1);
      found.push(rel.includes("/") ? rel : `./${rel}`);
    }
  };

  try {
    await walk(dir);
  } catch {
    return [];
  }
  return found
    .filter((path) => (isScriptAllowed ? isScriptAllowed(skill.name, path) : true))
    .sort();
};

const collectScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const fullPath = resolve(directory, entry.name);

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      try {
        const s = await stat(fullPath);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
    }

    if (isDir) {
      files.push(...(await collectScriptFiles(fullPath)));
      continue;
    }
    if (isFile) {
      const extension = extname(fullPath).toLowerCase();
      if (SCRIPT_EXTENSIONS.has(extension)) {
        files.push(fullPath);
      }
    }
  }
  return files;
};

export const normalizeScriptPolicyPath = (relativePath: string): string => {
  const trimmed = relativePath.trim();
  const normalized = normalize(trimmed).split(sep).join("/");
  if (normalized.startsWith("/")) {
    throw new Error("Script path must be relative and within the allowed directory");
  }
  const withoutDotPrefix = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  if (withoutDotPrefix.length === 0 || withoutDotPrefix === ".") {
    throw new Error("Script path must point to a file");
  }
  return withoutDotPrefix;
};

const resolveScriptPath = (
  baseDir: string,
  relativePath: string,
  containmentDir?: string,
): { fullPath: string; relativePath: string } => {
  const normalized = normalizeScriptPolicyPath(relativePath);
  const fullPath = resolve(baseDir, normalized);
  const boundary = resolve(containmentDir ?? baseDir);
  if (!fullPath.startsWith(`${boundary}${sep}`) && fullPath !== boundary) {
    throw new Error("Script path must stay inside the allowed directory");
  }
  const extension = extname(fullPath).toLowerCase();
  if (!SCRIPT_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported script extension "${extension || "(none)"}". Allowed: ${[...SCRIPT_EXTENSIONS].join(", ")}`,
    );
  }
  return { fullPath, relativePath: `./${normalized}` };
};

type RunnableScriptFunction = (
  input: Record<string, unknown>,
  context: {
    scope: "agent" | "skill";
    skill?: string;
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
  const extension = extname(scriptPath).toLowerCase();
  const cacheBust = `?t=${Date.now()}`;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    return await jiti.import(scriptPath + cacheBust);
  }
  try {
    return await import(pathToFileURL(scriptPath).href + cacheBust);
  } catch {
    const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    return await jiti.import(scriptPath + cacheBust);
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
