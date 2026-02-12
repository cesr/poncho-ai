import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

export interface SkillContextEntry {
  name: string;
  description?: string;
  tools: string[];
  instructions: string;
}

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const MAX_INSTRUCTIONS_PER_SKILL = 1200;
const MAX_CONTEXT_SIZE = 7000;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const parseSkillMarkdown = (content: string): SkillContextEntry | undefined => {
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

  const toolsValue = parsed.tools;
  const tools = Array.isArray(toolsValue)
    ? toolsValue.filter((tool): tool is string => typeof tool === "string")
    : [];

  const body = match[2].trim();
  const instructions =
    body.length > MAX_INSTRUCTIONS_PER_SKILL
      ? `${body.slice(0, MAX_INSTRUCTIONS_PER_SKILL)}...`
      : body;

  return {
    name,
    description:
      typeof parsed.description === "string" ? parsed.description.trim() : undefined,
    tools,
    instructions,
  };
};

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

export const loadSkillContext = async (workingDir: string): Promise<SkillContextEntry[]> => {
  const skillsRoot = resolve(workingDir, "skills");
  let manifests: string[] = [];
  try {
    manifests = await collectSkillManifests(skillsRoot);
  } catch {
    return [];
  }

  const contexts: SkillContextEntry[] = [];
  for (const manifest of manifests) {
    try {
      const content = await readFile(manifest, "utf8");
      const parsed = parseSkillMarkdown(content);
      if (parsed) {
        contexts.push(parsed);
      }
    } catch {
      // Ignore unreadable skill manifests.
    }
  }
  return contexts;
};

export const buildSkillContextWindow = (skills: SkillContextEntry[]): string => {
  if (skills.length === 0) {
    return "";
  }

  const blocks: string[] = [];
  for (const skill of skills) {
    const toolsLine = skill.tools.length > 0 ? skill.tools.join(", ") : "none listed";
    const descriptionLine = skill.description ? `Description: ${skill.description}` : "";
    blocks.push(
      [
        `### Skill: ${skill.name}`,
        descriptionLine,
        `Tools: ${toolsLine}`,
        "Instructions:",
        skill.instructions || "(no instructions provided)",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }

  const body = blocks.join("\n\n");
  const trimmedBody =
    body.length > MAX_CONTEXT_SIZE ? `${body.slice(0, MAX_CONTEXT_SIZE)}...` : body;
  return `## Agent Skills Context\n\nUse this skill guidance when selecting and composing tool calls.\n\n${trimmedBody}`;
};
