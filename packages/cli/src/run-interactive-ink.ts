import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { parseAgentFile, type AgentHarness } from "@agentl/harness";
import {
  InteractiveInkApp,
  type SessionSnapshot,
  type UiMetadata,
} from "./interactive-ink.js";

const SESSION_PATH = [".agentl", "interactive-session.json"];
const shouldPersistSessions = (): boolean => {
  const value = (process.env.AGENTL_INTERACTIVE_PERSIST ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};

const loadSessionSnapshot = async (workingDir: string): Promise<SessionSnapshot | undefined> => {
  const sessionPath = resolve(workingDir, ...SESSION_PATH);
  try {
    await access(sessionPath);
    const content = await readFile(sessionPath, "utf8");
    return JSON.parse(content) as SessionSnapshot;
  } catch {
    return undefined;
  }
};

const persistSessionSnapshot = async (
  workingDir: string,
  snapshot: SessionSnapshot,
): Promise<void> => {
  const sessionPath = resolve(workingDir, ...SESSION_PATH);
  await mkdir(resolve(workingDir, ".agentl"), { recursive: true });
  await writeFile(sessionPath, JSON.stringify(snapshot), "utf8");
};

const loadMetadata = async (workingDir: string): Promise<UiMetadata> => {
  let agentName = "agent";
  let model = "unknown";
  let provider = "unknown";
  try {
    const parsedAgent = await parseAgentFile(workingDir);
    agentName = parsedAgent.frontmatter.name ?? agentName;
    model = parsedAgent.frontmatter.model?.name ?? model;
    provider = parsedAgent.frontmatter.model?.provider ?? provider;
  } catch {
    // Keep resilient defaults if AGENT.md is malformed or missing.
  }
  return {
    agentName,
    model,
    provider,
    workingDir,
    environment: process.env.AGENTL_ENV ?? process.env.NODE_ENV ?? "development",
  };
};

export const runInteractiveInk = async ({
  harness,
  params,
  workingDir,
}: {
  harness: AgentHarness;
  params: Record<string, string>;
  workingDir: string;
}): Promise<void> => {
  const persistenceEnabled = shouldPersistSessions();
  const [sessionSnapshot, metadata] = await Promise.all([
    persistenceEnabled ? loadSessionSnapshot(workingDir) : Promise.resolve(undefined),
    loadMetadata(workingDir),
  ]);
  const app = render(
    createElement(InteractiveInkApp, {
      harness,
      params,
      metadata,
      initialSnapshot: sessionSnapshot,
      persistenceEnabled,
      onPersist: persistenceEnabled
        ? async (snapshot: SessionSnapshot) => {
            await persistSessionSnapshot(workingDir, snapshot);
          }
        : undefined,
    }),
    {
      maxFps: 30,
      incrementalRendering: true,
      patchConsole: false,
    },
  );
  await app.waitUntilExit();
};
