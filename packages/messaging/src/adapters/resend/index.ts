import { createHmac } from "node:crypto";
import type http from "node:http";
import type { ToolDefinition } from "@poncho-ai/sdk";
import type {
  FileAttachment,
  IncomingMessage as PonchoIncomingMessage,
  IncomingMessageHandler,
  MessagingAdapter,
  RouteRegistrar,
  ThreadRef,
} from "../../types.js";

const isSocketError = (err: unknown): boolean =>
  err instanceof TypeError &&
  err.message === "fetch failed" &&
  (err as { cause?: { code?: string } }).cause?.code === "UND_ERR_SOCKET";

async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (attempt < retries && isSocketError(err)) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

import {
  buildReplyHeaders,
  buildReplySubject,
  extractDisplayName,
  extractEmailAddress,
  markdownToEmailHtml,
  matchesSenderPattern,
  parseReferences,
  stripQuotedReply,
} from "../email/utils.js";

// ---------------------------------------------------------------------------
// Types for the dynamically-imported Resend SDK
// ---------------------------------------------------------------------------

interface ResendClient {
  emails: {
    send(opts: {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html?: string;
      cc?: string[];
      bcc?: string[];
      reply_to?: string[];
      headers?: Record<string, string>;
      attachments?: Array<{ filename: string; content?: string; path?: string; contentType?: string }>;
    }): Promise<{ data?: { id: string }; error?: unknown }>;
    receiving: {
      get(emailId: string): Promise<{
        data?: {
          html?: string;
          text?: string;
          headers?: Array<{ name: string; value: string }>;
        };
        error?: unknown;
      }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Svix webhook verification (works with any Resend SDK version)
// ---------------------------------------------------------------------------

function verifySvixSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(svixTimestamp, 10);
  const tolerance = 5 * 60;
  if (isNaN(ts) || Math.abs(now - ts) > tolerance) {
    throw new Error("Timestamp outside tolerance");
  }

  const secretBytes = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice(6) : secret,
    "base64",
  );

  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes)
    .update(toSign)
    .digest("base64");

  const candidates = svixSignature.split(" ").map((sig) => {
    const parts = sig.split(",");
    return parts.length === 2 ? parts[1]! : parts[0]!;
  });

  if (!candidates.some((c) => c === expected)) {
    throw new Error("Signature mismatch");
  }
}

// ---------------------------------------------------------------------------
// LRU deduplication set
// ---------------------------------------------------------------------------

class LruSet {
  private readonly max: number;
  private readonly set = new Set<string>();

  constructor(max = 1000) {
    this.max = max;
  }

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.size >= this.max) {
      // Evict the oldest entry
      const first = this.set.values().next().value as string;
      this.set.delete(first);
    }
    this.set.add(key);
  }
}

// ---------------------------------------------------------------------------
// FileAttachment → Resend attachment normalisation
// ---------------------------------------------------------------------------

const DATA_URI_RE = /^data:[^;]+;base64,/;

/**
 * Convert a `FileAttachment` into a Resend-compatible attachment object.
 *
 * `FileAttachment.data` can be raw base64, a data URI, an HTTPS URL, or a
 * `poncho-upload://` reference. Resend accepts either `content` (base64 /
 * Buffer) or `path` (remote URL). This function maps each format to the
 * correct field, returning `null` for unresolvable references.
 */
function toResendAttachment(
  f: FileAttachment,
): { filename: string; content?: string; path?: string; contentType?: string } | null {
  const filename = f.filename ?? "attachment";
  const data = f.data;

  if (data.startsWith("poncho-upload://")) {
    console.warn("[resend-adapter] skipping poncho-upload:// attachment (not resolvable from adapter):", filename);
    return null;
  }

  if (data.startsWith("https://") || data.startsWith("http://")) {
    return { filename, path: data, contentType: f.mediaType };
  }

  if (DATA_URI_RE.test(data)) {
    return { filename, content: data.replace(DATA_URI_RE, ""), contentType: f.mediaType };
  }

  return { filename, content: data, contentType: f.mediaType };
}

// ---------------------------------------------------------------------------
// ResendAdapter
// ---------------------------------------------------------------------------

export interface ResendAdapterOptions {
  apiKeyEnv?: string;
  webhookSecretEnv?: string;
  fromEnv?: string;
  replyToEnv?: string;
  allowedSenders?: string[];
  mode?: "auto-reply" | "tool";
  allowedRecipients?: string[];
  maxSendsPerRun?: number;
}

const collectBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

interface ThreadMeta {
  subject: string;
  senderEmail: string;
  references: string[];
}

export class ResendAdapter implements MessagingAdapter {
  readonly platform = "resend" as const;
  readonly autoReply: boolean;

  hasSentInCurrentRequest = false;

  private resend: ResendClient | undefined;
  private apiKey = "";
  private webhookSecret = "";
  private fromAddress = "";
  private replyToAddress = "";
  private readonly apiKeyEnv: string;
  private readonly webhookSecretEnv: string;
  private readonly fromEnv: string;
  private readonly replyToEnv: string;
  private readonly allowedSenders: string[] | undefined;
  private readonly allowedRecipients: string[] | undefined;
  private readonly maxSendsPerRun: number;
  private readonly mode: "auto-reply" | "tool";
  private handler: IncomingMessageHandler | undefined;
  private sendCount = 0;

  /** Request-scoped thread metadata for sendReply. */
  private readonly threadMeta = new Map<string, ThreadMeta>();

  /** Deduplication set for svix-id headers. */
  private readonly processed = new LruSet(1000);

  constructor(options: ResendAdapterOptions = {}) {
    this.apiKeyEnv = options.apiKeyEnv ?? "RESEND_API_KEY";
    this.webhookSecretEnv = options.webhookSecretEnv ?? "RESEND_WEBHOOK_SECRET";
    this.fromEnv = options.fromEnv ?? "RESEND_FROM";
    this.replyToEnv = options.replyToEnv ?? "RESEND_REPLY_TO";
    this.allowedSenders = options.allowedSenders;
    this.mode = options.mode ?? "auto-reply";
    this.autoReply = this.mode !== "tool";
    this.allowedRecipients = options.allowedRecipients;
    this.maxSendsPerRun = options.maxSendsPerRun ?? 10;
  }

  resetRequestState(): void {
    this.hasSentInCurrentRequest = false;
    this.sendCount = 0;
  }

  // -----------------------------------------------------------------------
  // MessagingAdapter implementation
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.apiKey = process.env[this.apiKeyEnv] ?? "";
    this.webhookSecret = process.env[this.webhookSecretEnv] ?? "";
    this.fromAddress = process.env[this.fromEnv] ?? "";
    this.replyToAddress = process.env[this.replyToEnv] ?? "";

    if (!this.apiKey) {
      throw new Error(
        `Resend messaging: ${this.apiKeyEnv} environment variable is not set`,
      );
    }
    if (!this.webhookSecret) {
      throw new Error(
        `Resend messaging: ${this.webhookSecretEnv} environment variable is not set`,
      );
    }
    if (!this.fromAddress) {
      throw new Error(
        `Resend messaging: ${this.fromEnv} environment variable is not set`,
      );
    }

    try {
      const mod = await import("resend");
      const ResendClass = mod.Resend;
      this.resend = new ResendClass(this.apiKey) as unknown as ResendClient;
    } catch {
      throw new Error(
        "ResendAdapter requires the 'resend' package. Install it: npm install resend",
      );
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handler = handler;
  }

  registerRoutes(router: RouteRegistrar): void {
    router("POST", "/api/messaging/resend", (req, res) =>
      this.handleRequest(req, res),
    );
  }

  async sendReply(
    threadRef: ThreadRef,
    content: string,
    options?: { files?: FileAttachment[] },
  ): Promise<void> {
    if (!this.resend) throw new Error("ResendAdapter not initialised");

    const meta = this.threadMeta.get(threadRef.platformThreadId);
    this.threadMeta.delete(threadRef.platformThreadId);
    const subject = meta
      ? buildReplySubject(meta.subject)
      : "Re: (no subject)";
    const headers = meta
      ? buildReplyHeaders(threadRef.messageId ?? threadRef.platformThreadId, meta.references)
      : {};

    const attachments = options?.files
      ?.map((f) => toResendAttachment(f))
      .filter((a): a is NonNullable<typeof a> => a !== null);

    console.log("[resend-adapter] sendReply →", {
      from: this.fromAddress,
      to: threadRef.channelId,
      subject,
    });

    const result = await this.resend.emails.send({
      from: this.fromAddress,
      to: [threadRef.channelId],
      subject,
      text: content,
      html: markdownToEmailHtml(content),
      reply_to: this.replyToAddress ? [this.replyToAddress] : undefined,
      headers,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    });

    if (result.error) {
      console.error("[resend-adapter] send failed:", JSON.stringify(result.error));
      throw new Error(`Resend send failed: ${JSON.stringify(result.error)}`);
    }

    console.log("[resend-adapter] email sent:", result.data);
  }

  async indicateProcessing(
    _threadRef: ThreadRef,
  ): Promise<() => Promise<void>> {
    return async () => {};
  }

  getToolDefinitions(): ToolDefinition[] {
    if (this.mode !== "tool") return [];

    const adapter = this;

    return [
      {
        name: "send_email",
        description:
          "Send an email via Resend. The body is written in markdown and will be converted to HTML. " +
          "To thread as a reply, provide in_reply_to with the original message ID. Omit it for a new standalone email.",
        inputSchema: {
          type: "object",
          properties: {
            to: {
              type: "array",
              items: { type: "string" },
              description: "Recipient email addresses",
            },
            subject: {
              type: "string",
              description: "Email subject line",
            },
            body: {
              type: "string",
              description: "Email body in markdown (converted to HTML)",
            },
            cc: {
              type: "array",
              items: { type: "string" },
              description: "CC recipient email addresses",
            },
            bcc: {
              type: "array",
              items: { type: "string" },
              description: "BCC recipient email addresses",
            },
            in_reply_to: {
              type: "string",
              description: "Message-ID to thread this email under (for replies). Omit for a new email.",
            },
          },
          required: ["to", "subject", "body"],
        },
        handler: async (input: Record<string, unknown>) => {
          return adapter.handleSendEmailTool(input);
        },
      },
    ];
  }

  private async handleSendEmailTool(
    input: Record<string, unknown>,
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!this.resend) {
      return { success: false, error: "ResendAdapter not initialised" };
    }

    if (this.sendCount >= this.maxSendsPerRun) {
      return {
        success: false,
        error: `Send limit reached (${this.maxSendsPerRun} per run). Cannot send more emails in this run.`,
      };
    }

    const to = input.to as string[];
    const subject = input.subject as string;
    const body = input.body as string;
    const cc = input.cc as string[] | undefined;
    const bcc = input.bcc as string[] | undefined;
    const inReplyTo = input.in_reply_to as string | undefined;

    const allRecipients = [...to, ...(cc ?? []), ...(bcc ?? [])];
    if (this.allowedRecipients && this.allowedRecipients.length > 0) {
      for (const addr of allRecipients) {
        if (!matchesSenderPattern(addr, this.allowedRecipients)) {
          return {
            success: false,
            error: `Recipient "${addr}" is not in the allowed recipients list. Allowed patterns: ${this.allowedRecipients.join(", ")}`,
          };
        }
      }
    }

    const headers: Record<string, string> = {};
    if (inReplyTo) {
      headers["In-Reply-To"] = inReplyTo;
      headers["References"] = inReplyTo;
    }

    console.log("[resend-adapter] send_email tool →", {
      from: this.fromAddress,
      to,
      subject,
      cc: cc ?? undefined,
      bcc: bcc ?? undefined,
      inReplyTo: inReplyTo ?? undefined,
    });

    const result = await this.resend.emails.send({
      from: this.fromAddress,
      to,
      subject,
      text: body,
      html: markdownToEmailHtml(body),
      cc: cc && cc.length > 0 ? cc : undefined,
      bcc: bcc && bcc.length > 0 ? bcc : undefined,
      reply_to: this.replyToAddress ? [this.replyToAddress] : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });

    if (result.error) {
      console.error("[resend-adapter] send_email tool failed:", JSON.stringify(result.error));
      return { success: false, error: JSON.stringify(result.error) };
    }

    this.sendCount++;
    this.hasSentInCurrentRequest = true;

    console.log("[resend-adapter] send_email tool sent:", result.data);
    return { success: true, id: result.data?.id };
  }

  // -----------------------------------------------------------------------
  // HTTP request handling
  // -----------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.resend) {
      res.writeHead(500);
      res.end("Adapter not initialised");
      return;
    }

    const rawBody = await collectBody(req);

    // -- Svix signature verification --------------------------------------
    const svixId = req.headers["svix-id"] as string | undefined;
    const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
    const svixSignature = req.headers["svix-signature"] as string | undefined;

    if (!svixId || !svixTimestamp || !svixSignature) {
      console.warn("[resend-adapter] 401: missing svix headers", {
        hasSvixId: !!svixId,
        hasSvixTimestamp: !!svixTimestamp,
        hasSvixSignature: !!svixSignature,
      });
      res.writeHead(401);
      res.end("Missing signature headers");
      return;
    }

    try {
      verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature, this.webhookSecret);
    } catch (err) {
      console.warn("[resend-adapter] 401: signature verification failed", err instanceof Error ? err.message : err);
      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }

    // -- Deduplication via svix-id ----------------------------------------
    if (this.processed.has(svixId)) {
      res.writeHead(200);
      res.end();
      return;
    }
    this.processed.add(svixId);

    // -- Parse payload ----------------------------------------------------
    let payload: { type?: string; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    if (payload.type !== "email.received") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Acknowledge immediately
    res.writeHead(200);
    res.end();

    const data = payload.data;
    if (!data || !this.handler) return;

    try {
      await this.processInboundEmail(data, payload);
    } catch (err) {
      console.error("[resend-adapter] error processing inbound email", err);
    }
  }

  private async processInboundEmail(
    data: Record<string, unknown>,
    payload: unknown,
  ): Promise<void> {
    if (!this.handler) return;

    const fromRaw = String(data.from ?? "");
    const senderEmail = extractEmailAddress(fromRaw);
    const senderName = extractDisplayName(fromRaw);

    // -- Sender allowlist -------------------------------------------------
    if (!matchesSenderPattern(senderEmail, this.allowedSenders)) {
      return;
    }

    const emailId = String(data.email_id ?? "");
    const messageId = String(data.message_id ?? "");
    const subject = String(data.subject ?? "");

    // -- Fetch email body + headers via REST API ---------------------------
    let text = "";
    let emailHeaders: Array<{ name: string; value: string }> | Record<string, string> | undefined;

    if (emailId) {
      try {
        const resp = await fetchWithRetry(
          `https://api.resend.com/emails/receiving/${emailId}`,
          { headers: { Authorization: `Bearer ${this.apiKey}` } },
        );
        if (resp.ok) {
          const emailData = (await resp.json()) as {
            text?: string;
            html?: string;
            headers?: Array<{ name: string; value: string }> | Record<string, string>;
          };
          text = emailData.text ?? "";
          emailHeaders = emailData.headers;
        } else {
          const body = await resp.text().catch(() => "");
          console.error(
            `[resend-adapter] failed to fetch email body: ${resp.status} ${resp.statusText}`,
            `\n  URL: https://api.resend.com/emails/receiving/${emailId}`,
            `\n  Key: ${this.apiKey.slice(0, 6)}...${this.apiKey.slice(-4)}`,
            body ? `\n  Response: ${body.slice(0, 200)}` : "",
          );
        }
      } catch (err) {
        console.error("[resend-adapter] failed to fetch email body", err);
      }
    }

    // Strip quoted replies to avoid feeding duplicate context to the agent
    const cleanText = stripQuotedReply(text).trim();
    if (!cleanText) return;

    // -- Reply metadata (consumed by sendReply within the same invocation) --
    const references = parseReferences(emailHeaders);
    this.threadMeta.set(messageId, {
      subject,
      senderEmail,
      references: [...references, messageId].filter(Boolean),
    });

    // -- Download attachments ---------------------------------------------
    const webhookAttachments = data.attachments as Array<{ id?: string; filename?: string; content_type?: string }> | undefined;
    const files = await this.fetchAndDownloadAttachments(emailId, webhookAttachments);

    // -- Build and dispatch message ---------------------------------------
    // Each incoming email creates its own conversation (no threading).
    const message: PonchoIncomingMessage = {
      text: cleanText,
      subject: subject || undefined,
      files: files.length > 0 ? files : undefined,
      threadRef: {
        channelId: senderEmail,
        platformThreadId: messageId,
        messageId,
      },
      sender: { id: senderEmail, name: senderName },
      platform: "resend",
      raw: payload,
    };

    await this.handler(message);
  }

  // -----------------------------------------------------------------------
  // Attachment helpers
  // -----------------------------------------------------------------------

  private async fetchAndDownloadAttachments(
    emailId: string,
    webhookAttachments: Array<{ id?: string; filename?: string; content_type?: string }> | undefined,
  ): Promise<FileAttachment[]> {
    if (!emailId || !webhookAttachments || webhookAttachments.length === 0) return [];

    // Fetch attachment metadata (with download_url) from the Resend API
    let attachments: Array<{ filename?: string; content_type?: string; download_url?: string }> = [];
    try {
      const resp = await fetchWithRetry(
        `https://api.resend.com/emails/receiving/${emailId}/attachments`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      if (resp.ok) {
        const body = await resp.json();
        attachments = (Array.isArray(body) ? body : (body as { data?: unknown[] }).data ?? []) as typeof attachments;
      } else {
        console.error("[resend-adapter] failed to list attachments:", resp.status, resp.statusText);
        return [];
      }
    } catch (err) {
      console.error("[resend-adapter] failed to list attachments", err);
      return [];
    }

    const results: FileAttachment[] = [];
    for (const att of attachments) {
      if (!att.download_url) continue;
      try {
        const resp = await fetchWithRetry(att.download_url);
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        results.push({
          data: buf.toString("base64"),
          mediaType: att.content_type ?? "application/octet-stream",
          filename: att.filename,
        });
      } catch {
        // Best-effort: skip attachments that fail to download
      }
    }
    return results;
  }
}
