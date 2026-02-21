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

  constructor(options: AgentBridgeOptions) {
    this.adapter = options.adapter;
    this.runner = options.runner;
    this.waitUntil = options.waitUntil ?? ((_p: Promise<unknown>) => {});
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
          ownerId: message.sender.id,
          title: `${message.platform} thread`,
        },
      );

      const result = await this.runner.run(conversationId, {
        task: message.text,
        messages: conversation.messages,
      });

      await this.adapter.sendReply(message.threadRef, result.response);
    } catch (error) {
      const snippet =
        error instanceof Error ? error.message : "Unknown error";
      try {
        await this.adapter.sendReply(
          message.threadRef,
          `Sorry, something went wrong: ${snippet}`,
        );
      } catch {
        // Best-effort error reporting — nothing more we can do.
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
