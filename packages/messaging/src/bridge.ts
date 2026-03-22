import { createHash } from "node:crypto";
import type {
  AgentBridgeOptions,
  FileAttachment,
  IncomingMessage,
  MessagingAdapter,
  AgentRunner,
  ThreadRef,
} from "./types.js";

/**
 * Derive a deterministic UUID from a platform thread reference.
 * SHA-256 hashes the composite key and formats 16 bytes as a UUID v4-shaped
 * string, ensuring a valid UUID that's stable across requests for the same thread.
 */
export const conversationIdFromThread = (
  platform: string,
  ref: ThreadRef,
): string => {
  const key = `${platform}:${ref.channelId}:${ref.platformThreadId}`;
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join("-");
};

export class AgentBridge {
  private readonly adapter: MessagingAdapter;
  private readonly runner: AgentRunner;
  private readonly waitUntil: (promise: Promise<unknown>) => void;
  private readonly ownerIdOverride: string | undefined;

  constructor(options: AgentBridgeOptions) {
    this.adapter = options.adapter;
    this.runner = options.runner;
    this.waitUntil = options.waitUntil ?? ((_p: Promise<unknown>) => {});
    this.ownerIdOverride = options.ownerId;
  }

  /** Wire the adapter's message handler and initialise. */
  async start(): Promise<void> {
    this.adapter.onMessage((msg) => {
      const processing = this.handleMessage(msg);
      // On serverless (Vercel), waitUntil keeps the function alive after
      // the HTTP 200 response so the agent run completes.
      this.waitUntil(processing);
      return processing;
    });

    if (this.adapter.onReset && this.runner.resetConversation) {
      this.adapter.onReset(async (platform, threadRef) => {
        const conversationId = conversationIdFromThread(platform, threadRef);
        await this.runner.resetConversation!(conversationId);
      });
    }

    await this.adapter.initialize();
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    const MAX_CONTINUATIONS = 10;
    let cleanup: (() => Promise<void>) | undefined;

    this.adapter.resetRequestState?.();

    try {
      cleanup = await this.adapter.indicateProcessing(message.threadRef);

      const conversationId = conversationIdFromThread(
        message.platform,
        message.threadRef,
      );

      const platformTag = `[${message.platform.charAt(0).toUpperCase()}${message.platform.slice(1)}]`;
      const senderLabel = message.sender.name || message.sender.id;
      const titleParts = [platformTag, senderLabel];
      if (message.subject) titleParts.push(message.subject);
      const title = titleParts.join(" ") || `${message.platform} thread`;

      const senderLine = message.sender.name
        ? `From: ${message.sender.name} <${message.sender.id}>`
        : `From: ${message.sender.id}`;
      const subjectLine = message.subject ? `Subject: ${message.subject}` : "";
      const header = [senderLine, subjectLine].filter(Boolean).join("\n");

      let currentTask: string | undefined = `${header}\n\n${message.text}`;
      let currentFiles = message.files;
      let accumulatedResponse = "";
      let accumulatedFiles: FileAttachment[] = [];
      let totalSteps = 0;
      let stepBudget = 0;
      let continuationCount = 0;

      while (true) {
        const conversation = await this.runner.getOrCreateConversation(
          conversationId,
          {
            platform: message.platform,
            ownerId: this.ownerIdOverride ?? message.sender.id,
            title,
            channelId: message.threadRef.channelId,
            platformThreadId: message.threadRef.platformThreadId,
          },
        );

        const result = await this.runner.run(conversationId, {
          task: currentTask,
          messages: conversation.messages,
          files: currentFiles,
          metadata: {
            platform: message.platform,
            sender: message.sender,
            threadId: message.threadRef.platformThreadId,
          },
        });

        accumulatedResponse += result.response;
        if (result.files) accumulatedFiles.push(...result.files);
        totalSteps += result.steps ?? 0;
        if (typeof result.maxSteps === "number") stepBudget = result.maxSteps;

        if (
          result.continuation &&
          continuationCount < MAX_CONTINUATIONS &&
          (stepBudget <= 0 || totalSteps < stepBudget)
        ) {
          continuationCount++;
          console.log(`[agent-bridge] continuation ${continuationCount}/${MAX_CONTINUATIONS} for ${conversationId}`);
          currentTask = undefined;
          currentFiles = undefined;
          continue;
        }

        break;
      }

      if (this.adapter.autoReply) {
        await this.adapter.sendReply(message.threadRef, accumulatedResponse, {
          files: accumulatedFiles.length > 0 ? accumulatedFiles : undefined,
        });
      } else if (!this.adapter.hasSentInCurrentRequest) {
        console.warn("[agent-bridge] tool mode completed without send_email being called; no reply sent");
      }
    } catch (error) {
      console.error("[agent-bridge] handleMessage error:", error instanceof Error ? error.message : error);
      if (!this.adapter.hasSentInCurrentRequest) {
        const snippet =
          error instanceof Error ? error.message : "Unknown error";
        try {
          await this.adapter.sendReply(
            message.threadRef,
            `Sorry, something went wrong: ${snippet}`,
          );
        } catch (replyError) {
          console.error("[agent-bridge] failed to send error reply:", replyError instanceof Error ? replyError.message : replyError);
        }
      }
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch {
          // Indicator removal is best-effort.
        }
      }
    }
  }
}
