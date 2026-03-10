import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Message } from "@poncho-ai/sdk";

export interface WebUiConversation {
  conversationId: string;
  title: string;
  messages: Message[];
  runtimeRunId?: string;
  ownerId: string;
  tenantId: string | null;
  contextTokens?: number;
  contextWindow?: number;
  createdAt: number;
  updatedAt: number;
}

type ConversationStoreFile = {
  conversations: WebUiConversation[];
};

const DEFAULT_OWNER = "local-owner";

const getStateDirectory = (): string => {
  const cwd = process.cwd();
  const home = homedir();
  const isServerless =
    process.env.VERCEL === "1" ||
    process.env.VERCEL_ENV !== undefined ||
    process.env.VERCEL_URL !== undefined ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
    process.env.AWS_EXECUTION_ENV?.includes("AWS_Lambda") === true ||
    process.env.LAMBDA_TASK_ROOT !== undefined ||
    process.env.NOW_REGION !== undefined ||
    cwd.startsWith("/var/task") ||
    home.startsWith("/var/task") ||
    process.env.SERVERLESS === "1";
  if (isServerless) {
    return "/tmp/.poncho/state";
  }
  return resolve(homedir(), ".poncho", "state");
};

export class FileConversationStore {
  private readonly filePath: string;
  private readonly conversations = new Map<string, WebUiConversation>();
  private loaded = false;
  private writing = Promise.resolve();

  constructor(workingDir: string) {
    const projectName = basename(workingDir).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project";
    const projectHash = createHash("sha256")
      .update(workingDir)
      .digest("hex")
      .slice(0, 12);
    this.filePath = resolve(
      getStateDirectory(),
      `${projectName}-${projectHash}-web-ui-state.json`,
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as ConversationStoreFile;
      for (const conversation of parsed.conversations ?? []) {
        this.conversations.set(conversation.conversationId, conversation);
      }
    } catch {
      // File does not exist yet or contains invalid JSON.
    }
  }

  private async persist(): Promise<void> {
    const payload: ConversationStoreFile = {
      conversations: Array.from(this.conversations.values()),
    };
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writing;
  }

  async list(ownerId = DEFAULT_OWNER): Promise<WebUiConversation[]> {
    await this.ensureLoaded();
    return Array.from(this.conversations.values())
      .filter((conversation) => conversation.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(conversationId: string): Promise<WebUiConversation | undefined> {
    await this.ensureLoaded();
    return this.conversations.get(conversationId);
  }

  async create(ownerId = DEFAULT_OWNER, title?: string): Promise<WebUiConversation> {
    await this.ensureLoaded();
    const now = Date.now();
    const conversation: WebUiConversation = {
      conversationId: randomUUID(),
      title: title && title.trim().length > 0 ? title.trim() : "New conversation",
      messages: [],
      ownerId,
      tenantId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.conversationId, conversation);
    await this.persist();
    return conversation;
  }

  async update(conversation: WebUiConversation): Promise<void> {
    await this.ensureLoaded();
    this.conversations.set(conversation.conversationId, {
      ...conversation,
      updatedAt: Date.now(),
    });
    await this.persist();
  }

  async rename(conversationId: string, title: string): Promise<WebUiConversation | undefined> {
    await this.ensureLoaded();
    const existing = this.conversations.get(conversationId);
    if (!existing) {
      return undefined;
    }
    const updated = {
      ...existing,
      title: title.trim().length > 0 ? title.trim() : existing.title,
      updatedAt: Date.now(),
    };
    this.conversations.set(conversationId, updated);
    await this.persist();
    return updated;
  }

  async delete(conversationId: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.conversations.delete(conversationId);
    if (removed) {
      await this.persist();
    }
    return removed;
  }
}

type SessionRecord = {
  sessionId: string;
  ownerId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ttlMs: number;
  private signingKey: string | undefined;

  constructor(ttlMs = 1000 * 60 * 60 * 8) {
    this.ttlMs = ttlMs;
  }

  setSigningKey(key: string): void {
    if (key) this.signingKey = key;
  }

  create(ownerId = DEFAULT_OWNER): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      sessionId: randomUUID(),
      ownerId,
      csrfToken: randomUUID(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastSeenAt: now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Encode a session into a signed cookie value that survives serverless
   * cold starts. Format: `base64url(payload).signature`
   */
  signSession(session: SessionRecord): string | undefined {
    if (!this.signingKey) return undefined;
    const payload = Buffer.from(
      JSON.stringify({
        sid: session.sessionId,
        o: session.ownerId,
        csrf: session.csrfToken,
        exp: session.expiresAt,
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", this.signingKey)
      .update(payload)
      .digest("base64url");
    return `${payload}.${sig}`;
  }

  /**
   * Restore a session from a signed cookie value. Returns the session
   * (also added to the in-memory store) or undefined if invalid/expired.
   */
  restoreFromSigned(cookieValue: string): SessionRecord | undefined {
    if (!this.signingKey) return undefined;
    const dotIdx = cookieValue.lastIndexOf(".");
    if (dotIdx <= 0) return undefined;

    const payload = cookieValue.slice(0, dotIdx);
    const sig = cookieValue.slice(dotIdx + 1);
    const expected = createHmac("sha256", this.signingKey)
      .update(payload)
      .digest("base64url");
    if (sig.length !== expected.length) return undefined;
    if (
      !timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))
    )
      return undefined;

    try {
      const data = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { sid?: string; o?: string; csrf?: string; exp?: number };
      if (!data.sid || !data.o || !data.csrf || !data.exp) return undefined;
      if (Date.now() > data.exp) return undefined;

      const session: SessionRecord = {
        sessionId: data.sid,
        ownerId: data.o,
        csrfToken: data.csrf,
        createdAt: data.exp - this.ttlMs,
        expiresAt: data.exp,
        lastSeenAt: Date.now(),
      };
      this.sessions.set(session.sessionId, session);
      return session;
    } catch {
      return undefined;
    }
  }
}

type LoginAttemptState = {
  count: number;
  firstFailureAt: number;
  lockedUntil?: number;
};

export class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttemptState>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 1000 * 60 * 5,
    private readonly lockoutMs = 1000 * 60 * 10,
  ) {}

  canAttempt(key: string): { allowed: boolean; retryAfterSeconds?: number } {
    const current = this.attempts.get(key);
    if (!current) {
      return { allowed: true };
    }
    if (current.lockedUntil && Date.now() < current.lockedUntil) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((current.lockedUntil - Date.now()) / 1000),
      };
    }
    return { allowed: true };
  }

  registerFailure(key: string): { locked: boolean; retryAfterSeconds?: number } {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || now - current.firstFailureAt > this.windowMs) {
      this.attempts.set(key, { count: 1, firstFailureAt: now });
      return { locked: false };
    }
    const count = current.count + 1;
    const next: LoginAttemptState = {
      ...current,
      count,
    };
    if (count >= this.maxAttempts) {
      next.lockedUntil = now + this.lockoutMs;
      this.attempts.set(key, next);
      return { locked: true, retryAfterSeconds: Math.ceil(this.lockoutMs / 1000) };
    }
    this.attempts.set(key, next);
    return { locked: false };
  }

  registerSuccess(key: string): void {
    this.attempts.delete(key);
  }
}

export const parseCookies = (request: IncomingMessage): Record<string, string> => {
  const cookieHeader = request.headers.cookie ?? "";
  const pairs = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const cookies: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
};

export const setCookie = (
  response: ServerResponse,
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
    maxAge?: number;
  },
): void => {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? "/"}`);
  if (typeof options.maxAge === "number") {
    segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`);
  }
  const previous = response.getHeader("Set-Cookie");
  const serialized = segments.join("; ");
  if (!previous) {
    response.setHeader("Set-Cookie", serialized);
    return;
  }
  if (Array.isArray(previous)) {
    response.setHeader("Set-Cookie", [...previous, serialized]);
    return;
  }
  response.setHeader("Set-Cookie", [String(previous), serialized]);
};

export const verifyPassphrase = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    const zero = Buffer.alloc(expectedBuffer.length);
    return timingSafeEqual(expectedBuffer, zero) && false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
};

export const getRequestIp = (request: IncomingMessage): string => {
  return request.socket.remoteAddress ?? "unknown";
};

export const inferConversationTitle = (text: string): string => {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "New conversation";
  }
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 48)}...`;
};
