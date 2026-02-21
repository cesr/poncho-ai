import type http from "node:http";
import type {
  IncomingMessage as PonchoIncomingMessage,
  IncomingMessageHandler,
  MessagingAdapter,
  RouteRegistrar,
  ThreadRef,
} from "../../types.js";
import { verifySlackSignature } from "./verify.js";
import {
  addReaction,
  postMessage,
  removeReaction,
  splitMessage,
  stripMention,
} from "./utils.js";

const PROCESSING_REACTION = "eyes";

export interface SlackAdapterOptions {
  botTokenEnv?: string;
  signingSecretEnv?: string;
}

/**
 * Collect the raw request body from a Node `http.IncomingMessage`.
 */
const collectBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export class SlackAdapter implements MessagingAdapter {
  readonly platform = "slack" as const;

  private botToken = "";
  private signingSecret = "";
  private readonly botTokenEnv: string;
  private readonly signingSecretEnv: string;
  private handler: IncomingMessageHandler | undefined;

  constructor(options: SlackAdapterOptions = {}) {
    this.botTokenEnv = options.botTokenEnv ?? "SLACK_BOT_TOKEN";
    this.signingSecretEnv =
      options.signingSecretEnv ?? "SLACK_SIGNING_SECRET";
  }

  // -----------------------------------------------------------------------
  // MessagingAdapter implementation
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.botToken = process.env[this.botTokenEnv] ?? "";
    this.signingSecret = process.env[this.signingSecretEnv] ?? "";

    if (!this.botToken) {
      throw new Error(
        `Slack messaging: ${this.botTokenEnv} environment variable is not set`,
      );
    }
    if (!this.signingSecret) {
      throw new Error(
        `Slack messaging: ${this.signingSecretEnv} environment variable is not set`,
      );
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handler = handler;
  }

  registerRoutes(router: RouteRegistrar): void {
    router("POST", "/api/messaging/slack", (req, res) =>
      this.handleRequest(req, res),
    );
  }

  async sendReply(threadRef: ThreadRef, content: string): Promise<void> {
    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await postMessage(
        this.botToken,
        threadRef.channelId,
        chunk,
        threadRef.platformThreadId,
      );
    }
  }

  async indicateProcessing(
    threadRef: ThreadRef,
  ): Promise<() => Promise<void>> {
    // React to the specific message that triggered the event, not the
    // thread parent. Falls back to platformThreadId for non-threaded msgs.
    const reactionTarget =
      threadRef.messageId ?? threadRef.platformThreadId;

    await addReaction(
      this.botToken,
      threadRef.channelId,
      reactionTarget,
      PROCESSING_REACTION,
    );

    return () =>
      removeReaction(
        this.botToken,
        threadRef.channelId,
        reactionTarget,
        PROCESSING_REACTION,
      );
  }

  // -----------------------------------------------------------------------
  // HTTP request handling
  // -----------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const rawBody = await collectBody(req);

    // -- Signature verification ------------------------------------------
    const isValid = verifySlackSignature(
      this.signingSecret,
      {
        signature: req.headers["x-slack-signature"] as string | undefined,
        timestamp: req.headers["x-slack-request-timestamp"] as
          | string
          | undefined,
      },
      rawBody,
    );

    if (!isValid) {
      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    // -- URL verification challenge --------------------------------------
    if (payload.type === "url_verification") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    // -- Retry deduplication ---------------------------------------------
    if (req.headers["x-slack-retry-num"]) {
      res.writeHead(200);
      res.end();
      return;
    }

    // -- Event dispatch --------------------------------------------------
    if (payload.type === "event_callback") {
      // Acknowledge immediately so Slack doesn't retry.
      res.writeHead(200);
      res.end();

      const event = payload.event as Record<string, unknown> | undefined;
      if (event?.type === "app_mention" && this.handler) {
        const text = stripMention(String(event.text ?? ""));
        if (!text) return;

        // thread_ts = parent message (for threading replies).
        // ts = this specific message (for reactions).
        const threadTs = String(event.thread_ts ?? event.ts ?? "");
        const messageTs = String(event.ts ?? "");
        const channel = String(event.channel ?? "");
        const userId = String(event.user ?? "");

        const message: PonchoIncomingMessage = {
          text,
          threadRef: {
            platformThreadId: threadTs,
            channelId: channel,
            messageId: messageTs,
          },
          sender: { id: userId },
          platform: "slack",
          raw: event,
        };

        // Processing is fire-and-forget; the bridge's waitUntil keeps
        // serverless functions alive.  If the handler was wired via
        // AgentBridge.scheduleProcessing, it already uses waitUntil.
        // If wired via onMessage, we await here (long-running server).
        void this.handler(message).catch((err) => {
          console.error("[slack-adapter] unhandled message handler error", err);
        });
      }

      return;
    }

    // Unknown payload type
    res.writeHead(200);
    res.end();
  }
}
