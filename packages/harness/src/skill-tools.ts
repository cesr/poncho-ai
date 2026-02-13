import { defineTool, type ToolDefinition } from "@agentl/sdk";
import type { SkillMetadata } from "./skill-context.js";
import { loadSkillInstructions, readSkillResource } from "./skill-context.js";

/**
 * Creates the built-in skill tools that implement progressive disclosure
 * per the Agent Skills specification (https://agentskills.io/integrate-skills).
 *
 * - `activate_skill`  — loads the full SKILL.md body on demand
 * - `read_skill_resource` — reads a file from a skill directory (references, scripts, assets)
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
  ];
};
