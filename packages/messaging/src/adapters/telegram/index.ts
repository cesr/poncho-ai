import type http from "node:http";
import type {
  FileAttachment,
  IncomingMessage as PonchoIncomingMessage,
  IncomingMessageHandler,
  MessagingAdapter,
  ResetHandler,
  RouteRegistrar,
  ThreadRef,
} from "../../types.js";
import { verifyTelegramSecret } from "./verify.js";
import {
  type TelegramInlineKeyboardButton,
  type TelegramMessage,
  type TelegramUpdate,
  answerCallbackQuery,
  downloadFile,
  editMessageText,
  getFile,
  getMe,
  isBotMentioned,
  sendChatAction,
  sendDocument,
  sendMessage,
  sendMessageWithKeyboard,
  sendPhoto,
  splitMessage,
  stripMention,
} from "./utils.js";

const TYPING_INTERVAL_MS = 4_000;
const NEW_COMMAND_RE = /^\/new(?:@(\S+))?$/i;

const parseMessageThreadId = (
  platformThreadId: string,
  chatId: string,
): number | undefined => {
  const parts = platformThreadId.split(":");
  // Telegram thread format:
  // - non-topic chats: `${chatId}:${session}`
  // - forum topics: `${chatId}:${message_thread_id}:${session}`
  if (parts.length !== 3 || parts[0] !== chatId) return undefined;
  const threadId = Number(parts[1]);
  return Number.isInteger(threadId) ? threadId : undefined;
};

export interface TelegramApprovalInfo {
  approvalId: string;
  tool: string;
  input: Record<string, unknown>;
}

export type TelegramApprovalDecisionHandler = (
  approvalId: string,
  approved: boolean,
  chatId: string,
) => Promise<void>;

export interface TelegramAdapterOptions {
  botTokenEnv?: string;
  webhookSecretEnv?: string;
  allowedUserIds?: number[];
}

const collectBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export class TelegramAdapter implements MessagingAdapter {
  readonly platform = "telegram" as const;
  readonly autoReply = true;
  readonly hasSentInCurrentRequest = false;

  private botToken = "";
  private webhookSecret = "";
  private botUsername = "";
  private botId = 0;
  private readonly botTokenEnv: string;
  private readonly webhookSecretEnv: string;
  private readonly allowedUserIds: number[] | undefined;
  private handler: IncomingMessageHandler | undefined;
  private resetHandler: ResetHandler | undefined;
  private approvalDecisionHandler: TelegramApprovalDecisionHandler | undefined;
  private readonly approvalMessageIds = new Map<string, { chatId: string; messageId: number }>();
  private lastUpdateId = 0;

  constructor(options: TelegramAdapterOptions = {}) {
    this.botTokenEnv = options.botTokenEnv ?? "TELEGRAM_BOT_TOKEN";
    this.webhookSecretEnv =
      options.webhookSecretEnv ?? "TELEGRAM_WEBHOOK_SECRET";
    this.allowedUserIds =
      options.allowedUserIds && options.allowedUserIds.length > 0
        ? options.allowedUserIds
        : undefined;
  }

  // -----------------------------------------------------------------------
  // MessagingAdapter implementation
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.botToken = process.env[this.botTokenEnv] ?? "";
    this.webhookSecret = process.env[this.webhookSecretEnv] ?? "";

    if (!this.botToken) {
      throw new Error(
        `Telegram messaging: ${this.botTokenEnv} environment variable is not set`,
      );
    }

    const me = await getMe(this.botToken);
    this.botUsername = me.username;
    this.botId = me.id;
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handler = handler;
  }

  onReset(handler: ResetHandler): void {
    this.resetHandler = handler;
  }

  registerRoutes(router: RouteRegistrar): void {
    router("POST", "/api/messaging/telegram", (req, res) =>
      this.handleRequest(req, res),
    );
  }

  async sendReply(
    threadRef: ThreadRef,
    content: string,
    options?: { files?: FileAttachment[] },
  ): Promise<void> {
    const chatId = threadRef.channelId;
    const replyTo = threadRef.messageId
      ? Number(threadRef.messageId)
      : undefined;
    const messageThreadId = parseMessageThreadId(
      threadRef.platformThreadId,
      chatId,
    );

    if (content) {
      const chunks = splitMessage(content);
      for (const chunk of chunks) {
        await sendMessage(this.botToken, chatId, chunk, {
          reply_to_message_id: replyTo,
          message_thread_id: messageThreadId,
        });
      }
    }

    if (options?.files) {
      for (const file of options.files) {
        if (file.mediaType.startsWith("image/")) {
          await sendPhoto(this.botToken, chatId, file.data, {
            reply_to_message_id: replyTo,
            message_thread_id: messageThreadId,
            filename: file.filename,
          });
        } else {
          await sendDocument(this.botToken, chatId, file.data, {
            reply_to_message_id: replyTo,
            message_thread_id: messageThreadId,
            filename: file.filename,
            mediaType: file.mediaType,
          });
        }
      }
    }
  }

  async indicateProcessing(
    threadRef: ThreadRef,
  ): Promise<() => Promise<void>> {
    const chatId = threadRef.channelId;

    await sendChatAction(this.botToken, chatId, "typing");

    const interval = setInterval(() => {
      void sendChatAction(this.botToken, chatId, "typing").catch(() => {});
    }, TYPING_INTERVAL_MS);

    return async () => {
      clearInterval(interval);
    };
  }

  // -----------------------------------------------------------------------
  // Approval support
  // -----------------------------------------------------------------------

  onApprovalDecision(handler: TelegramApprovalDecisionHandler): void {
    this.approvalDecisionHandler = handler;
  }

  async sendApprovalRequest(
    chatId: string,
    approvals: TelegramApprovalInfo[],
    opts?: { message_thread_id?: number },
  ): Promise<void> {
    const MAX_INPUT_LENGTH = 3500;

    for (const approval of approvals) {
      let inputSummary = Object.entries(approval.input)
        .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");

      if (inputSummary.length > MAX_INPUT_LENGTH) {
        inputSummary = inputSummary.slice(0, MAX_INPUT_LENGTH) + "\n  …(truncated)";
      }

      const text = [
        `🔧 Tool approval required: ${approval.tool}`,
        "",
        inputSummary ? `Input:\n${inputSummary}` : "(no input)",
      ].join("\n");

      const keyboard: TelegramInlineKeyboardButton[][] = [
        [
          { text: "✅ Approve", callback_data: `a:${approval.approvalId}` },
          { text: "❌ Deny", callback_data: `d:${approval.approvalId}` },
        ],
      ];

      try {
        const messageId = await sendMessageWithKeyboard(
          this.botToken,
          chatId,
          text,
          keyboard,
          { message_thread_id: opts?.message_thread_id },
        );
        this.approvalMessageIds.set(approval.approvalId, {
          chatId,
          messageId,
        });
      } catch (err) {
        console.error(
          "[telegram-adapter] failed to send approval request:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async updateApprovalMessage(
    approvalId: string,
    decision: "approved" | "denied",
    tool: string,
  ): Promise<void> {
    const tracked = this.approvalMessageIds.get(approvalId);
    if (!tracked) return;

    const icon = decision === "approved" ? "✅" : "❌";
    const label = decision === "approved" ? "Approved" : "Denied";
    const text = `${icon} ${label}: ${tool}`;

    try {
      await editMessageText(
        this.botToken,
        tracked.chatId,
        tracked.messageId,
        text,
      );
    } catch (err) {
      console.warn(
        "[telegram-adapter] failed to update approval message:",
        err instanceof Error ? err.message : err,
      );
    }
    this.approvalMessageIds.delete(approvalId);
  }

  // -----------------------------------------------------------------------
  // HTTP request handling
  // -----------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const rawBody = await collectBody(req);

    // -- Secret verification ----------------------------------------------
    if (this.webhookSecret) {
      const headerSecret = req.headers[
        "x-telegram-bot-api-secret-token"
      ] as string | undefined;
      if (!verifyTelegramSecret(this.webhookSecret, headerSecret)) {
        res.writeHead(401);
        res.end("Invalid secret");
        return;
      }
    }

    let payload: TelegramUpdate;
    try {
      payload = JSON.parse(rawBody) as TelegramUpdate;
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    // -- Update deduplication -----------------------------------------------
    if (payload.update_id <= this.lastUpdateId) {
      res.writeHead(200);
      res.end();
      return;
    }
    this.lastUpdateId = payload.update_id;

    // -- Callback query (inline keyboard button press) ---------------------
    if (payload.callback_query) {
      res.writeHead(200);
      res.end();
      void this.handleCallbackQuery(payload.callback_query).catch((err) => {
        console.error(
          "[telegram-adapter] callback_query error:",
          err instanceof Error ? err.message : err,
        );
      });
      return;
    }

    const message = payload.message;
    if (!message) {
      res.writeHead(200);
      res.end();
      return;
    }

    const text = message.text ?? message.caption ?? "";
    const hasFiles = !!(message.photo || message.document);

    if (!text && !hasFiles) {
      res.writeHead(200);
      res.end();
      return;
    }

    // -- User allowlist -----------------------------------------------------
    if (this.allowedUserIds && message.from) {
      if (!this.allowedUserIds.includes(message.from.id)) {
        res.writeHead(200);
        res.end();
        return;
      }
    }

    const chatId = String(message.chat.id);
    const chatType = message.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    const entities = message.entities ?? message.caption_entities;

    // -- /new command -----------------------------------------------------
    const newMatch = text.match(NEW_COMMAND_RE);
    if (newMatch) {
      const suffix = newMatch[1];
      if (
        isGroup &&
        suffix &&
        suffix.toLowerCase() !== this.botUsername.toLowerCase()
      ) {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end();

      // Clear conversation in the store so the next message starts fresh.
      if (this.resetHandler) {
        const topicId = message.message_thread_id;
        const threadId = topicId
          ? `${chatId}:${topicId}:0`
          : `${chatId}:0`;
        try {
          await this.resetHandler("telegram", {
            channelId: chatId,
            platformThreadId: threadId,
          });
        } catch (err) {
          console.error("[telegram-adapter] reset handler error:", err instanceof Error ? err.message : err);
        }
      }

      await sendMessage(
        this.botToken,
        chatId,
        "Conversation reset. Send a new message to start fresh.",
        {
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id,
        },
      );
      return;
    }

    // -- Group mention filter ---------------------------------------------
    if (isGroup) {
      if (!isBotMentioned(entities, this.botUsername, this.botId, text)) {
        res.writeHead(200);
        res.end();
        return;
      }
    }

    const cleanText = isGroup
      ? stripMention(text, entities, this.botUsername, this.botId)
      : text;

    if (!cleanText && !hasFiles) {
      res.writeHead(200);
      res.end();
      return;
    }

    // Acknowledge immediately so Telegram doesn't retry.
    res.writeHead(200);
    res.end();

    if (!this.handler) return;

    // -- File extraction --------------------------------------------------
    const files = await this.extractFiles(message);

    // -- Build thread ref -------------------------------------------------
    // Always use a fixed session component so the conversationId is stable
    // across serverless cold starts. /new resets via the store instead.
    const topicId = message.message_thread_id;
    const platformThreadId = topicId
      ? `${chatId}:${topicId}:0`
      : `${chatId}:0`;

    const userId = String(message.from?.id ?? "unknown");
    const userName =
      [message.from?.first_name, message.from?.last_name]
        .filter(Boolean)
        .join(" ") || undefined;

    const ponchoMessage: PonchoIncomingMessage = {
      text: cleanText,
      files: files.length > 0 ? files : undefined,
      threadRef: {
        platformThreadId,
        channelId: chatId,
        messageId: String(message.message_id),
      },
      sender: { id: userId, name: userName },
      platform: "telegram",
      raw: message,
    };

    void this.handler(ponchoMessage).catch((err) => {
      console.error(
        "[telegram-adapter] unhandled message handler error",
        err,
      );
    });
  }

  // -----------------------------------------------------------------------
  // Callback query handling
  // -----------------------------------------------------------------------

  private async handleCallbackQuery(
    query: import("./utils.js").TelegramCallbackQuery,
  ): Promise<void> {
    if (this.allowedUserIds && !this.allowedUserIds.includes(query.from.id)) {
      await answerCallbackQuery(this.botToken, query.id, {
        text: "You are not authorized to approve tools.",
      });
      return;
    }

    const data = query.data;
    if (!data) {
      await answerCallbackQuery(this.botToken, query.id);
      return;
    }

    const isApprove = data.startsWith("a:");
    const isDeny = data.startsWith("d:");
    if (!isApprove && !isDeny) {
      await answerCallbackQuery(this.botToken, query.id);
      return;
    }

    const approvalId = data.slice(2);
    const approved = isApprove;
    const chatId = query.message?.chat.id
      ? String(query.message.chat.id)
      : undefined;

    await answerCallbackQuery(this.botToken, query.id, {
      text: approved ? "Approved" : "Denied",
    });

    if (this.approvalDecisionHandler && chatId) {
      await this.approvalDecisionHandler(approvalId, approved, chatId);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async extractFiles(
    message: TelegramMessage,
  ): Promise<FileAttachment[]> {
    const files: FileAttachment[] = [];
    try {
      if (message.photo && message.photo.length > 0) {
        const largest = message.photo[message.photo.length - 1]!;
        const filePath = await getFile(this.botToken, largest.file_id);
        const { data } = await downloadFile(this.botToken, filePath);
        files.push({ data, mediaType: "image/jpeg", filename: "photo.jpg" });
      }

      if (message.document) {
        const filePath = await getFile(
          this.botToken,
          message.document.file_id,
        );
        const downloaded = await downloadFile(this.botToken, filePath);
        files.push({
          data: downloaded.data,
          mediaType: message.document.mime_type ?? downloaded.mediaType,
          filename: message.document.file_name,
        });
      }
    } catch (err) {
      console.warn(
        "[telegram-adapter] failed to download file:",
        err instanceof Error ? err.message : err,
      );
    }
    return files;
  }
}
