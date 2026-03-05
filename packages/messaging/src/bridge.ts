import type {
  AgentBridgeOptions,
  IncomingMessage,
  MessagingAdapter,
  AgentRunner,
  ThreadRef,
} from "./types.js";

/**
 * Derive a stable conversation ID from a platform thread reference.
 * Format: `<platform>:<channelId>:<threadId>`
 */
const conversationIdFromThread = (
  platform: string,
  ref: ThreadRef,
): string => `${platform}:${ref.channelId}:${ref.platformThreadId}`;

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
    await this.adapter.initialize();
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    let cleanup: (() => Promise<void>) | undefined;

    this.adapter.resetRequestState?.();

    try {
      cleanup = await this.adapter.indicateProcessing(message.threadRef);

      const conversationId = conversationIdFromThread(
        message.platform,
        message.threadRef,
      );

      const conversation = await this.runner.getOrCreateConversation(
        conversationId,
        {
          platform: message.platform,
          ownerId: this.ownerIdOverride ?? message.sender.id,
          title: `${message.platform} thread`,
        },
      );

      const senderLine = message.sender.name
        ? `From: ${message.sender.name} <${message.sender.id}>`
        : `From: ${message.sender.id}`;
      const subjectLine = message.subject ? `Subject: ${message.subject}` : "";
      const header = [senderLine, subjectLine].filter(Boolean).join("\n");
      const task = `${header}\n\n${message.text}`;

      const result = await this.runner.run(conversationId, {
        task,
        messages: conversation.messages,
        files: message.files,
        metadata: {
          platform: message.platform,
          sender: message.sender,
          threadId: message.threadRef.platformThreadId,
        },
      });

      if (this.adapter.autoReply) {
        await this.adapter.sendReply(message.threadRef, result.response, {
          files: result.files,
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
