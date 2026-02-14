import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, normalize } from "node:path";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// Skill directory scanning — default directories and ecosystem compatibility
// ---------------------------------------------------------------------------

/**
 * Default directories to scan for skills, relative to the project root.
 * Additional directories can be added via `skillPaths` in agentl.config.js.
 */
const DEFAULT_SKILL_DIRS: string[] = ["skills"];

/**
 * Resolve the full list of skill directories to scan.
 * Merges the defaults with any extra paths provided via config.
 */
export const resolveSkillDirs = (
  workingDir: string,
  extraPaths?: string[],
): string[] => {
  const dirs = [...DEFAULT_SKILL_DIRS];
  if (extraPaths) {
    for (const p of extraPaths) {
      if (!dirs.includes(p)) {
        dirs.push(p);
      }
    }
  }
  return dirs.map((d) => resolve(workingDir, d));
};

export interface SkillMetadata {
  /** Unique skill name from frontmatter. */
  name: string;
  /** What the skill does and when to use it. */
  description: string;
  /** Tool hints declared in frontmatter (spec `allowed-tools` or legacy `tools`). */
  tools: string[];
  /** Absolute path to the skill directory. */
  skillDir: string;
  /** Absolute path to the SKILL.md file. */
  skillPath: string;
}

/**
 * @deprecated Use {@link SkillMetadata} instead. Kept for backward compatibility.
 */
export type SkillContextEntry = SkillMetadata & {
  instructions: string;
};

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

// ---------------------------------------------------------------------------
// Frontmatter parsing (metadata only — no body content)
// ---------------------------------------------------------------------------

const parseSkillFrontmatter = (
  content: string,
): { name: string; description: string; tools: string[] } | undefined => {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return undefined;
  }

  const parsedYaml = YAML.parse(match[1]) ?? {};
  const parsed = asRecord(parsedYaml);
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) {
    return undefined;
  }

  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : "";

  const allowedToolsValue = parsed["allowed-tools"];
  const allowedTools =
    typeof allowedToolsValue === "string"
      ? allowedToolsValue
          .split(/\s+/)
          .map((tool) => tool.trim())
          .filter((tool) => tool.length > 0)
      : [];

  const legacyToolsValue = parsed.tools;
  const legacyTools = Array.isArray(legacyToolsValue)
    ? legacyToolsValue.filter((tool): tool is string => typeof tool === "string")
    : [];

  const tools = allowedTools.length > 0 ? allowedTools : legacyTools;

  return { name, description, tools };
};

// ---------------------------------------------------------------------------
// Discovery — find all SKILL.md files recursively
// ---------------------------------------------------------------------------

const collectSkillManifests = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSkillManifests(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
      files.push(fullPath);
    }
  }

  return files;
};

// ---------------------------------------------------------------------------
// Public: load only metadata at startup (name + description per skill)
// ---------------------------------------------------------------------------

export const loadSkillMetadata = async (
  workingDir: string,
  extraSkillPaths?: string[],
): Promise<SkillMetadata[]> => {
  const skillDirs = resolveSkillDirs(workingDir, extraSkillPaths);
  const allManifests: string[] = [];

  for (const dir of skillDirs) {
    try {
      allManifests.push(...(await collectSkillManifests(dir)));
    } catch {
      // Directory doesn't exist or isn't readable — skip silently.
    }
  }

  const skills: SkillMetadata[] = [];
  const seen = new Set<string>();

  for (const manifest of allManifests) {
    try {
      const content = await readFile(manifest, "utf8");
      const parsed = parseSkillFrontmatter(content);
      if (parsed && !seen.has(parsed.name)) {
        seen.add(parsed.name);
        skills.push({
          ...parsed,
          skillDir: dirname(manifest),
          skillPath: manifest,
        });
      }
    } catch {
      // Ignore unreadable skill manifests.
    }
  }
  return skills;
};

// ---------------------------------------------------------------------------
// Public: build the <available_skills> XML injected into the system prompt
// ---------------------------------------------------------------------------

export const buildSkillContextWindow = (skills: SkillMetadata[]): string => {
  if (skills.length === 0) {
    return "";
  }

  const xmlSkills = skills
    .map((skill) => {
      const lines = [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
      ];
      if (skill.description) {
        lines.push(
          `    <description>${escapeXml(skill.description)}</description>`,
        );
      }
      lines.push("  </skill>");
      return lines.join("\n");
    })
    .join("\n");

  return `<available_skills description="Skills the agent can use. Use the activate_skill tool to load full instructions for a skill when a user's request matches its description.">
${xmlSkills}
</available_skills>`;
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// ---------------------------------------------------------------------------
// Public: on-demand activation — load the full SKILL.md body
// ---------------------------------------------------------------------------

export const loadSkillInstructions = async (
  skill: SkillMetadata,
): Promise<string> => {
  const content = await readFile(skill.skillPath, "utf8");
  const match = content.match(FRONTMATTER_PATTERN);
  return match ? match[2].trim() : content.trim();
};

// ---------------------------------------------------------------------------
// Public: on-demand resource reading from a skill directory
// ---------------------------------------------------------------------------

export const readSkillResource = async (
  skill: SkillMetadata,
  relativePath: string,
): Promise<string> => {
  const normalized = normalize(relativePath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new Error("Path must be relative and within the skill directory");
  }
  const fullPath = resolve(skill.skillDir, normalized);
  // Ensure the resolved path is still inside the skill directory
  if (!fullPath.startsWith(skill.skillDir)) {
    throw new Error("Path escapes the skill directory");
  }
  return await readFile(fullPath, "utf8");
};

// ---------------------------------------------------------------------------
// Backward-compat: loadSkillContext (returns full entries with instructions)
// ---------------------------------------------------------------------------

const MAX_INSTRUCTIONS_PER_SKILL = 1200;

export const loadSkillContext = async (
  workingDir: string,
): Promise<SkillContextEntry[]> => {
  const metadata = await loadSkillMetadata(workingDir);
  const entries: SkillContextEntry[] = [];
  for (const skill of metadata) {
    try {
      const instructions = await loadSkillInstructions(skill);
      const trimmed =
        instructions.length > MAX_INSTRUCTIONS_PER_SKILL
          ? `${instructions.slice(0, MAX_INSTRUCTIONS_PER_SKILL)}...`
          : instructions;
      entries.push({ ...skill, instructions: trimmed });
    } catch {
      entries.push({ ...skill, instructions: "" });
    }
  }
  return entries;
};
