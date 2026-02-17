import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
export const STORAGE_SCHEMA_VERSION = "v1";

export type AgentIdentity = {
  name: string;
  id: string;
};

const isServerlessEnvironment = (): boolean => {
  const cwd = process.cwd();
  const home = homedir();
  return (
    process.env.VERCEL === "1" ||
    process.env.VERCEL_ENV !== undefined ||
    process.env.VERCEL_URL !== undefined ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
    process.env.AWS_EXECUTION_ENV?.includes("AWS_Lambda") === true ||
    process.env.LAMBDA_TASK_ROOT !== undefined ||
    process.env.NOW_REGION !== undefined ||
    cwd.startsWith("/var/task") ||
    home.startsWith("/var/task") ||
    process.env.SERVERLESS === "1"
  );
};

export const getPonchoStoreRoot = (): string =>
  isServerlessEnvironment()
    ? "/tmp/.poncho/store"
    : resolve(homedir(), ".poncho", "store");

const toRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export const slugifyStorageComponent = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "agent";
};

export const generateAgentId = (): string => `agent_${randomUUID().replace(/-/g, "")}`;

const fallbackIdentity = (workingDir: string): AgentIdentity => {
  const projectName = basename(workingDir).replace(/[^a-zA-Z0-9_-]+/g, "-") || "agent";
  const projectHash = createHash("sha256").update(workingDir).digest("hex").slice(0, 12);
  return {
    name: projectName,
    id: `agent_${projectHash}`,
  };
};

const parseIdentityFromAgentContent = (content: string): AgentIdentity | undefined => {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return undefined;
  }
  const parsed = toRecord(YAML.parse(match[1]) ?? {});
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const id =
    typeof parsed.id === "string" && parsed.id.trim().length > 0
      ? parsed.id.trim()
      : undefined;
  if (!id) {
    return undefined;
  }
  return { name, id };
};

export const resolveAgentIdentity = async (
  workingDir: string,
): Promise<AgentIdentity> => {
  const filePath = resolve(workingDir, "AGENT.md");
  try {
    const content = await readFile(filePath, "utf8");
    return parseIdentityFromAgentContent(content) ?? fallbackIdentity(workingDir);
  } catch {
    return fallbackIdentity(workingDir);
  }
};

export const ensureAgentIdentity = async (
  workingDir: string,
): Promise<AgentIdentity> => {
  const filePath = resolve(workingDir, "AGENT.md");
  try {
    const content = await readFile(filePath, "utf8");
    const match = content.match(FRONTMATTER_PATTERN);
    if (!match) {
      return fallbackIdentity(workingDir);
    }
    const parsed = toRecord(YAML.parse(match[1]) ?? {});
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) {
      return fallbackIdentity(workingDir);
    }
    const existingId =
      typeof parsed.id === "string" && parsed.id.trim().length > 0
        ? parsed.id.trim()
        : undefined;
    if (existingId) {
      return { name, id: existingId };
    }
    const id = generateAgentId();
    parsed.id = id;
    const nextFrontmatter = YAML.stringify(parsed).trimEnd();
    const body = match[2].replace(/^\n+/, "");
    const nextContent = `---\n${nextFrontmatter}\n---\n\n${body}`;
    await writeFile(filePath, nextContent, "utf8");
    return { name, id };
  } catch {
    return fallbackIdentity(workingDir);
  }
};

export const buildAgentDirectoryName = (identity: AgentIdentity): string =>
  `${slugifyStorageComponent(identity.name)}--${slugifyStorageComponent(identity.id)}`;

export const getAgentStoreDirectory = (identity: AgentIdentity): string =>
  resolve(getPonchoStoreRoot(), buildAgentDirectoryName(identity));
