import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  AgentHarness,
  TelemetryEmitter,
  createConversationStore,
  createConversationStoreFromEngine,
  createUploadStore,
  ensureAgentIdentity,
  loadPonchoConfig,
  resolveStateConfig,
  type PonchoConfig,
  type ConversationStore,
} from "@poncho-ai/harness";
import type { FileInput, RunInput } from "@poncho-ai/sdk";
import dotenv from "dotenv";
import { extToMime, resolveHarnessEnvironment } from "./http-utils.js";

export const runOnce = async (
  task: string,
  options: {
    params: Record<string, string>;
    json: boolean;
    filePaths: string[];
    workingDir?: string;
  },
): Promise<void> => {
  const workingDir = options.workingDir ?? process.cwd();
  dotenv.config({ path: resolve(workingDir, ".env") });
  const config = await loadPonchoConfig(workingDir);
  const uploadStore = await createUploadStore(config?.uploads, workingDir);
  const harness = new AgentHarness({ workingDir, uploadStore });
  const telemetry = new TelemetryEmitter(config?.telemetry);
  await harness.initialize();

  const fileInputs: FileInput[] = await Promise.all(
    options.filePaths.map(async (filePath) => {
      const absPath = resolve(workingDir, filePath);
      const buf = await readFile(absPath);
      const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
      return {
        data: buf.toString("base64"),
        mediaType: extToMime(ext),
        filename: basename(filePath),
      };
    }),
  );

  const input: RunInput = {
    task,
    parameters: options.params,
    files: fileInputs.length > 0 ? fileInputs : undefined,
  };

  if (options.json) {
    const output = await harness.runToCompletion(input);
    for (const event of output.events) {
      await telemetry.emit(event);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  for await (const event of harness.runWithTelemetry(input)) {
    await telemetry.emit(event);
    if (event.type === "model:chunk") {
      process.stdout.write(event.content);
    }
    if (event.type === "run:error") {
      process.stderr.write(`\nError: ${event.error.message}\n`);
    }
    if (event.type === "run:completed") {
      process.stdout.write("\n");
    }
    if (event.type === "run:cancelled") {
      process.stdout.write("\n");
      process.stderr.write("Run cancelled.\n");
    }
  }
};

export const runInteractive = async (
  workingDir: string,
  params: Record<string, string>,
): Promise<void> => {
  dotenv.config({ path: resolve(workingDir, ".env") });
  const config = await loadPonchoConfig(workingDir);

  const uploadStore = await createUploadStore(config?.uploads, workingDir);
  const harness = new AgentHarness({
    workingDir,
    environment: resolveHarnessEnvironment(),
    uploadStore,
  });
  await harness.initialize();
  const identity = await ensureAgentIdentity(workingDir);
  try {
    const { runInteractiveInk } = await import("./run-interactive-ink.js");
    await (
      runInteractiveInk as (input: {
        harness: AgentHarness;
        params: Record<string, string>;
        workingDir: string;
        config?: PonchoConfig;
        conversationStore: ConversationStore;
      }) => Promise<void>
    )({
      harness,
      params,
      workingDir,
      config,
      conversationStore: (() => {
        if (!harness.storageEngine) {
          process.stderr.write(
            "[poncho] WARNING: harness.storageEngine is undefined. " +
              "This usually means an outdated @poncho-ai/harness (< 0.37.0) is installed. " +
              "Falling back to in-memory storage — conversations will NOT be persisted. " +
              "Fix: `pnpm up @poncho-ai/harness@latest` or add a pnpm.overrides entry to force resolution.\n",
          );
          return createConversationStore(resolveStateConfig(config), { workingDir, agentId: identity.id });
        }
        return createConversationStoreFromEngine(harness.storageEngine);
      })(),
    });
  } finally {
    await harness.shutdown();
  }
};

export const listTools = async (workingDir: string): Promise<void> => {
  dotenv.config({ path: resolve(workingDir, ".env") });
  const harness = new AgentHarness({ workingDir });
  await harness.initialize();
  const tools = harness.listTools();

  if (tools.length === 0) {
    process.stdout.write("No tools registered.\n");
    return;
  }

  process.stdout.write("Available tools:\n");
  for (const tool of tools) {
    process.stdout.write(`- ${tool.name}: ${tool.description}\n`);
  }
};
