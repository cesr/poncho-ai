import type { AgentEvent, RunInput, RunResult } from "@poncho-ai/sdk";
import { SignJWT } from "jose";
import { BaseClient } from "./base.js";
import type { AgentClientOptions } from "./base.js";
import type { ConversationRecord, FileAttachment, SyncRunResponse } from "./types.js";
import type { SubscribeToEventsOptions } from "./conversations.js";
import {
  listConversations,
  createConversation,
  getConversation,
  getConversationStatus,
  deleteConversation,
  renameConversation,
  stopRun,
  compactConversation,
  listTodos,
  listThreads,
  createThread,
  subscribeToEvents,
} from "./conversations.js";
import { submitApproval } from "./approvals.js";
import { listSubagents } from "./subagents.js";
import { listSecrets, setSecret, deleteSecret } from "./secrets.js";
import { listSlashCommands } from "./commands.js";
import { readFile } from "./vfs.js";

// Re-export everything consumers need
export type { AgentClientOptions } from "./base.js";
export type {
  SyncRunResponse,
  ContinueInput,
  ConversationSummary,
  ConversationRecord,
  FileAttachment,
} from "./types.js";
export type { SubscribeToEventsOptions } from "./conversations.js";
export type {
  ApiApprovalResponse,
  ApiStopRunResponse,
  ApiCompactResponse,
  ApiSubagentSummary,
  ApiSecretEntry,
  ApiSlashCommand,
  ApiThreadSummary,
  ApiThreadListResponse,
  ApiCreateThreadRequest,
  ApiCreateThreadResponse,
} from "@poncho-ai/sdk";

export interface CreateTenantTokenOptions {
  /** The signing key (typically PONCHO_AUTH_TOKEN). */
  signingKey: string;
  /** Unique identifier for the tenant (becomes JWT `sub` claim). */
  tenantId: string;
  /** Expiration: string like "1h", "7d" or number of seconds. Omit for no expiration. */
  expiresIn?: string | number;
  /** Optional metadata stored in the JWT `meta` claim. */
  metadata?: Record<string, unknown>;
}

/**
 * Create a tenant-scoped JWT (HS256) for use with a poncho agent.
 * Builders can also use any JWT library in any language — this is a convenience.
 */
export async function createTenantToken(options: CreateTenantTokenOptions): Promise<string> {
  const secret = new TextEncoder().encode(options.signingKey);
  let builder = new SignJWT(
    options.metadata ? { meta: options.metadata } : {},
  )
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(options.tenantId)
    .setIssuedAt();

  if (options.expiresIn) {
    if (typeof options.expiresIn === "number") {
      builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn);
    } else {
      builder = builder.setExpirationTime(options.expiresIn);
    }
  }

  return await builder.sign(secret);
}

export class AgentClient extends BaseClient {
  // --- Conversation management (from conversations.ts) ---
  listConversations = listConversations;
  createConversation = createConversation;
  getConversation = getConversation;
  getConversationStatus = getConversationStatus;
  deleteConversation = deleteConversation;
  renameConversation = renameConversation;
  stopRun = stopRun;
  compactConversation = compactConversation;
  listTodos = listTodos;
  listThreads = listThreads;
  createThread = createThread;
  subscribeToEvents = subscribeToEvents;

  // --- Approvals (from approvals.ts) ---
  submitApproval = submitApproval;

  // --- Subagents (from subagents.ts) ---
  listSubagents = listSubagents;

  // --- Secrets (from secrets.ts) ---
  listSecrets = listSecrets;
  setSecret = setSecret;
  deleteSecret = deleteSecret;

  // --- Slash commands (from commands.ts) ---
  listSlashCommands = listSlashCommands;

  // --- VFS (from vfs.ts) ---
  readFile = readFile;

  // --- Core messaging & streaming (kept inline) ---

  async sendMessage(
    conversationId: string,
    message: string,
    optionsOrParameters?: {
      parameters?: Record<string, unknown>;
      files?: FileAttachment[];
      waitForSubagents?: boolean;
    } | Record<string, unknown>,
  ): Promise<SyncRunResponse> {
    // Backward compat: third arg can be plain parameters Record or new options object
    let parameters: Record<string, unknown> | undefined;
    let files: FileAttachment[] | undefined;
    let waitForSubagents = false;
    if (optionsOrParameters && ("parameters" in optionsOrParameters || "files" in optionsOrParameters || "waitForSubagents" in optionsOrParameters)) {
      const opts = optionsOrParameters as { parameters?: Record<string, unknown>; files?: FileAttachment[]; waitForSubagents?: boolean };
      parameters = opts.parameters;
      files = opts.files;
      waitForSubagents = opts.waitForSubagents === true;
    } else if (optionsOrParameters) {
      parameters = optionsOrParameters as Record<string, unknown>;
    }
    let totalSteps = 0;
    let stepBudget = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDuration = 0;
    let latestRunId = "";
    let needsContinuation = false;

    const processEvents = (events: AgentEvent[]): SyncRunResponse | "continue" | "cancelled" | undefined => {
      const runStarted = events.find(
        (event): event is Extract<AgentEvent, { type: "run:started" }> =>
          event.type === "run:started",
      );
      if (runStarted) latestRunId = runStarted.runId;

      const completed = events.find(
        (event): event is Extract<AgentEvent, { type: "run:completed" }> =>
          event.type === "run:completed",
      );
      if (completed) {
        totalSteps += completed.result.steps;
        totalInputTokens += completed.result.tokens.input;
        totalOutputTokens += completed.result.tokens.output;
        totalDuration += completed.result.duration;
        if (typeof completed.result.maxSteps === "number") stepBudget = completed.result.maxSteps;

        if (completed.result.continuation && (stepBudget <= 0 || totalSteps < stepBudget)) {
          return "continue";
        }
        return {
          runId: latestRunId || completed.runId,
          status: completed.result.status,
          result: {
            ...completed.result,
            steps: totalSteps,
            tokens: { input: totalInputTokens, output: totalOutputTokens, cached: 0 },
            duration: totalDuration,
          },
          ...(completed.pendingSubagents ? { pendingSubagents: true } : {}),
        };
      }
      const cancelled = events.find(
        (event): event is Extract<AgentEvent, { type: "run:cancelled" }> =>
          event.type === "run:cancelled",
      );
      if (cancelled) return "cancelled";
      return undefined;
    };

    // Initial message
    const bodyPayload: Record<string, unknown> = { message };
    if (parameters) bodyPayload.parameters = parameters;
    if (files && files.length > 0) bodyPayload.files = files;

    const response = await this.fetchImpl(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(bodyPayload),
      },
    );
    if (!response.ok) {
      throw new Error(`Send message failed: HTTP ${response.status}`);
    }
    const events = await this.parseSse(response);
    let outcome = processEvents(events);
    needsContinuation = outcome === "continue";

    // Continuation loop via /continue endpoint
    while (needsContinuation) {
      needsContinuation = false;
      const contResponse = await this.fetchImpl(
        `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/continue`,
        {
          method: "POST",
          headers: this.headers(),
        },
      );
      if (!contResponse.ok) {
        // Safety net may have claimed continuation; poll for completion
        const POLL_INTERVAL = 2000;
        const MAX_POLL_TIME = 600_000;
        const pollStart = Date.now();
        while (Date.now() - pollStart < MAX_POLL_TIME) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL));
          const status = await this.getConversationStatus(conversationId);
          if (!status.hasActiveRun && !status.needsContinuation) {
            const msgs = status.conversation.messages;
            const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
            return {
              runId: latestRunId,
              status: "completed",
              result: {
                status: "completed",
                steps: totalSteps,
                tokens: { input: totalInputTokens, output: totalOutputTokens, cached: 0 },
                duration: totalDuration,
                response: lastAssistant
                  ? typeof lastAssistant.content === "string"
                    ? lastAssistant.content
                    : lastAssistant.content.map(p => "text" in p ? p.text : "").join("")
                  : undefined,
              },
            };
          }
        }
        throw new Error("Continuation polling timed out");
      }
      const contEvents = await this.parseSse(contResponse);
      outcome = processEvents(contEvents);
      needsContinuation = outcome === "continue";
    }

    if (outcome === "cancelled" || outcome === undefined) {
      return {
        runId: latestRunId,
        status: "cancelled",
        result: {
          status: "cancelled",
          steps: totalSteps,
          tokens: { input: totalInputTokens, output: totalOutputTokens, cached: 0 },
          duration: totalDuration,
        },
      };
    }
    if (typeof outcome === "object") {
      const syncResult = outcome;
      if (waitForSubagents && syncResult.pendingSubagents) {
        const POLL_INTERVAL = 3000;
        const MAX_POLL_TIME = 3600_000;
        const pollStart = Date.now();
        while (Date.now() - pollStart < MAX_POLL_TIME) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL));
          const status = await this.getConversationStatus(conversationId);
          if (!status.hasRunningSubagents && !status.hasActiveRun) {
            syncResult.pendingSubagents = false;
            const msgs = status.conversation.messages;
            const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
            if (lastAssistant) {
              syncResult.result = {
                ...syncResult.result,
                response: typeof lastAssistant.content === "string"
                  ? lastAssistant.content
                  : lastAssistant.content.map(p => "text" in p ? p.text : "").join(""),
              };
            }
            break;
          }
        }
      }
      return syncResult;
    }
    throw new Error("Send message failed: missing run:completed or run:cancelled event");
  }

  async run(input: RunInput & { files?: FileAttachment[] }): Promise<SyncRunResponse> {
    if ((input.messages?.length ?? 0) > 0) {
      throw new Error(
        "run() with pre-seeded messages is no longer supported. Use createConversation/sendMessage.",
      );
    }
    const conversation = await this.createConversation({
      title: input.task,
    });
    return await this.sendMessage(conversation.conversationId, input.task ?? "", {
      parameters: input.parameters,
      files: input.files,
    });
  }

  async continue(input: { runId: string; message: string; parameters?: Record<string, unknown>; files?: FileAttachment[] }): Promise<SyncRunResponse> {
    return await this.sendMessage(input.runId, input.message, {
      parameters: input.parameters,
      files: input.files,
    });
  }

  conversation(initialRunId?: string): {
    send: (
      message: string,
      options?: { parameters?: Record<string, unknown>; files?: FileAttachment[] },
    ) => Promise<SyncRunResponse>;
  } {
    let runId = initialRunId;
    return {
      send: async (
        message: string,
        options?: { parameters?: Record<string, unknown>; files?: FileAttachment[] },
      ) => {
        if (!runId) {
          const initialConversation = await this.createConversation({ title: message });
          const initial = await this.sendMessage(
            initialConversation.conversationId,
            message,
            options,
          );
          runId = initialConversation.conversationId;
          return initial;
        }
        const next = await this.continue({ runId, message, ...options });
        return next;
      },
    };
  }

  async *stream(input: RunInput & { files?: FileAttachment[] }): AsyncGenerator<AgentEvent> {
    if ((input.messages?.length ?? 0) > 0) {
      throw new Error(
        "stream() with pre-seeded messages is no longer supported. Use conversation APIs directly.",
      );
    }
    const conversation = await this.createConversation({ title: input.task });
    let totalSteps = 0;
    let stepBudget = 0;
    let shouldContinue = false;

    const self = this;
    const readStream = async function* (response: Response): AsyncGenerator<AgentEvent> {
      shouldContinue = false;
      for await (const payload of self.readSseStream(response)) {
        if (payload.type === "run:completed") {
          totalSteps += payload.result.steps;
          if (typeof payload.result.maxSteps === "number") stepBudget = payload.result.maxSteps;
          if (payload.result.continuation && (stepBudget <= 0 || totalSteps < stepBudget)) {
            shouldContinue = true;
          }
        }
        yield payload;
        if (payload.type === "run:completed" && payload.pendingSubagents) {
          yield { type: "subagents:pending" } as AgentEvent;
        }
      }
    };

    // Initial message
    const bodyPayload: Record<string, unknown> = { message: input.task, parameters: input.parameters };
    if (input.files && input.files.length > 0) bodyPayload.files = input.files;

    const response = await this.fetchImpl(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(bodyPayload),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Streaming request failed: HTTP ${response.status}`);
    }
    yield* readStream(response);

    // Continuation loop via /continue endpoint
    while (shouldContinue) {
      const contResponse = await this.fetchImpl(
        `${this.baseUrl}/api/conversations/${encodeURIComponent(conversation.conversationId)}/continue`,
        {
          method: "POST",
          headers: this.headers(),
        },
      );
      if (!contResponse.ok || !contResponse.body) break;
      yield* readStream(contResponse);
    }
  }
}
