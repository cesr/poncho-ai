import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Message } from "@agentl/sdk";

export interface WebUiConversation {
  conversationId: string;
  title: string;
  messages: Message[];
  runtimeRunId?: string;
  ownerId: string;
  tenantId: string | null;
  createdAt: number;
  updatedAt: number;
}

type ConversationStoreFile = {
  conversations: WebUiConversation[];
};

const DEFAULT_OWNER = "local-owner";

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
      homedir(),
      ".agentl",
      "state",
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

  constructor(ttlMs = 1000 * 60 * 60 * 8) {
    this.ttlMs = ttlMs;
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
      // Ignore malformed cookie encoding instead of throwing.
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
  // Trust direct socket peer by default to avoid spoofable forwarded headers.
  // Reverse-proxy deployments can map trusted client IPs before this layer.
  return request.socket.remoteAddress ?? "unknown";
};

export const inferConversationTitle = (text: string): string => {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "New conversation";
  }
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 48)}...`;
};

export const renderWebUiHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentL Web UI</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0f1117; color: #e9edf5; }
      .shell { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
      .sidebar { border-right: 1px solid #252a38; background: #121624; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
      .conversation-list { overflow: auto; display: flex; flex-direction: column; gap: 6px; }
      .conversation-item { border: 1px solid #2c3347; border-radius: 8px; padding: 8px 10px; cursor: pointer; background: #171d2c; }
      .conversation-item.active { border-color: #5b7cff; background: #1f2a4a; }
      .conversation-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
      .conversation-meta { font-size: 11px; color: #9ca6bf; }
      .conversation-actions { margin-top: 6px; display: flex; gap: 6px; }
      .main { display: grid; grid-template-rows: auto 1fr auto; min-height: 100vh; }
      .topbar { border-bottom: 1px solid #252a38; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
      .status { color: #9ca6bf; font-size: 12px; }
      .messages { padding: 20px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
      .message { max-width: 760px; border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.35; }
      .message.user { align-self: flex-end; background: #27417f; }
      .message.assistant { align-self: flex-start; background: #1b2233; border: 1px solid #2c3347; }
      .composer { border-top: 1px solid #252a38; padding: 12px 16px; display: grid; gap: 8px; }
      textarea { width: 100%; min-height: 78px; border-radius: 10px; border: 1px solid #2c3347; background: #121624; color: #e9edf5; padding: 10px; resize: vertical; }
      button { border: 1px solid #2c3347; background: #1a2133; color: #e9edf5; padding: 7px 10px; border-radius: 8px; cursor: pointer; }
      button.primary { border-color: #4b6bff; background: #3656dd; }
      button.danger { border-color: #6d2b3a; background: #3a1b24; }
      button:disabled { opacity: 0.6; cursor: default; }
      .row { display: flex; gap: 8px; align-items: center; }
      .hidden { display: none !important; }
      .auth { min-height: 100vh; display: grid; place-items: center; }
      .auth-card { width: min(420px, 90vw); border: 1px solid #2c3347; background: #121624; border-radius: 12px; padding: 20px; display: grid; gap: 10px; }
      input { width: 100%; border-radius: 10px; border: 1px solid #2c3347; background: #0f1117; color: #e9edf5; padding: 10px; }
      .error { color: #ff9aa9; font-size: 12px; min-height: 16px; }
      .empty { color: #9ca6bf; font-size: 13px; }
      @media (max-width: 860px) {
        .shell { grid-template-columns: 1fr; }
        .sidebar { min-height: 220px; border-right: none; border-bottom: 1px solid #252a38; }
        .main { min-height: calc(100vh - 220px); }
      }
    </style>
  </head>
  <body>
    <div id="auth" class="auth hidden">
      <form id="login-form" class="auth-card">
        <h2 style="margin: 0">AgentL login</h2>
        <p style="margin: 0; color: #9ca6bf; font-size: 13px">Enter the configured passphrase to use this UI.</p>
        <input id="passphrase" type="password" autocomplete="current-password" placeholder="Passphrase" required />
        <button class="primary" type="submit">Sign in</button>
        <div id="login-error" class="error"></div>
      </form>
    </div>

    <div id="app" class="shell hidden">
      <aside class="sidebar">
        <div class="row">
          <button id="new-chat" class="primary">New chat</button>
          <button id="refresh-list">Refresh</button>
        </div>
        <div id="conversation-list" class="conversation-list"></div>
      </aside>

      <section class="main">
        <div class="topbar">
          <div id="chat-title">AgentL</div>
          <div class="row">
            <span id="connection-status" class="status">idle</span>
            <button id="rename-chat">Rename</button>
            <button id="delete-chat" class="danger">Delete</button>
            <button id="logout">Logout</button>
          </div>
        </div>
        <div id="messages" class="messages">
          <div class="empty">Select or create a conversation to start chatting.</div>
        </div>
        <form id="composer" class="composer">
          <textarea id="prompt" placeholder="Send a message..."></textarea>
          <div class="row">
            <button id="send" class="primary" type="submit">Send</button>
          </div>
        </form>
      </section>
    </div>

    <script>
      const state = {
        csrfToken: "",
        conversations: [],
        activeConversationId: null,
        isStreaming: false
      };

      const elements = {
        auth: document.getElementById("auth"),
        app: document.getElementById("app"),
        loginForm: document.getElementById("login-form"),
        passphrase: document.getElementById("passphrase"),
        loginError: document.getElementById("login-error"),
        list: document.getElementById("conversation-list"),
        newChat: document.getElementById("new-chat"),
        refreshList: document.getElementById("refresh-list"),
        messages: document.getElementById("messages"),
        chatTitle: document.getElementById("chat-title"),
        renameChat: document.getElementById("rename-chat"),
        deleteChat: document.getElementById("delete-chat"),
        logout: document.getElementById("logout"),
        composer: document.getElementById("composer"),
        prompt: document.getElementById("prompt"),
        send: document.getElementById("send"),
        connectionStatus: document.getElementById("connection-status")
      };

      const mutatingMethods = new Set(["POST", "PATCH", "PUT", "DELETE"]);

      const api = async (path, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const headers = { ...(options.headers || {}) };
        if (mutatingMethods.has(method) && state.csrfToken) {
          headers["x-csrf-token"] = state.csrfToken;
        }
        if (options.body && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        const response = await fetch(path, { credentials: "include", ...options, method, headers });
        if (!response.ok) {
          let payload = {};
          try { payload = await response.json(); } catch {}
          const error = new Error(payload.message || ("Request failed: " + response.status));
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          return await response.json();
        }
        return await response.text();
      };

      const formatDate = (epoch) => {
        try { return new Date(epoch).toLocaleString(); } catch { return ""; }
      };

      const renderConversationList = () => {
        elements.list.innerHTML = "";
        if (state.conversations.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "No conversations yet.";
          elements.list.appendChild(empty);
          return;
        }
        for (const conversation of state.conversations) {
          const item = document.createElement("div");
          item.className = "conversation-item" + (conversation.conversationId === state.activeConversationId ? " active" : "");
          item.innerHTML = '<div class="conversation-title"></div><div class="conversation-meta"></div>';
          item.querySelector(".conversation-title").textContent = conversation.title;
          item.querySelector(".conversation-meta").textContent = formatDate(conversation.updatedAt);
          item.addEventListener("click", async () => {
            state.activeConversationId = conversation.conversationId;
            renderConversationList();
            await loadConversation(conversation.conversationId);
          });
          elements.list.appendChild(item);
        }
      };

      const renderMessages = (messages) => {
        elements.messages.innerHTML = "";
        if (!messages || messages.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Start the conversation by sending a message.";
          elements.messages.appendChild(empty);
          return;
        }
        for (const message of messages) {
          const node = document.createElement("div");
          node.className = "message " + (message.role === "assistant" ? "assistant" : "user");
          node.textContent = String(message.content || "");
          elements.messages.appendChild(node);
        }
        elements.messages.scrollTop = elements.messages.scrollHeight;
      };

      const loadConversations = async () => {
        const payload = await api("/api/conversations");
        state.conversations = payload.conversations || [];
        renderConversationList();
      };

      const loadConversation = async (conversationId) => {
        const payload = await api("/api/conversations/" + encodeURIComponent(conversationId));
        elements.chatTitle.textContent = payload.conversation.title;
        renderMessages(payload.conversation.messages);
      };

      const createConversation = async (title) => {
        const payload = await api("/api/conversations", {
          method: "POST",
          body: JSON.stringify(title ? { title } : {})
        });
        state.activeConversationId = payload.conversation.conversationId;
        await loadConversations();
        await loadConversation(state.activeConversationId);
        return state.activeConversationId;
      };

      const parseSseChunk = (buffer, onEvent) => {
        let rest = buffer;
        while (true) {
          const index = rest.indexOf("\\n\\n");
          if (index < 0) {
            return rest;
          }
          const raw = rest.slice(0, index);
          rest = rest.slice(index + 2);
          const lines = raw.split("\\n");
          let eventName = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += line.slice(5).trim();
            }
          }
          if (data) {
            try {
              onEvent(eventName, JSON.parse(data));
            } catch {}
          }
        }
      };

      const setStreaming = (value) => {
        state.isStreaming = value;
        elements.send.disabled = value;
        elements.prompt.disabled = value;
        elements.connectionStatus.textContent = value ? "streaming..." : "idle";
      };

      const sendMessage = async (text) => {
        const messageText = (text || "").trim();
        if (!messageText || state.isStreaming) {
          return;
        }
        let conversationId = state.activeConversationId;
        if (!conversationId) {
          conversationId = await createConversation(messageText);
        }
        const existingPayload = await api("/api/conversations/" + encodeURIComponent(conversationId));
        const localMessages = [...(existingPayload.conversation.messages || []), { role: "user", content: messageText }];
        let assistantMessage = { role: "assistant", content: "" };
        localMessages.push(assistantMessage);
        renderMessages(localMessages);
        setStreaming(true);
        try {
          const response = await fetch("/api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "x-csrf-token": state.csrfToken },
            body: JSON.stringify({ message: messageText })
          });
          if (!response.ok || !response.body) {
            throw new Error("Failed to stream response");
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSseChunk(buffer, (eventName, payload) => {
              if (eventName === "model:chunk") {
                assistantMessage.content += String(payload.content || "");
                renderMessages(localMessages);
              }
              if (eventName === "run:completed" && (!assistantMessage.content || assistantMessage.content.length === 0)) {
                assistantMessage.content = String(payload.result?.response || "");
                renderMessages(localMessages);
              }
            });
          }
          await loadConversations();
          await loadConversation(conversationId);
        } finally {
          setStreaming(false);
        }
      };

      const requireAuth = async () => {
        try {
          const session = await api("/api/auth/session");
          if (!session.authenticated) {
            elements.auth.classList.remove("hidden");
            elements.app.classList.add("hidden");
            return false;
          }
          state.csrfToken = session.csrfToken || "";
          elements.auth.classList.add("hidden");
          elements.app.classList.remove("hidden");
          return true;
        } catch {
          elements.auth.classList.remove("hidden");
          elements.app.classList.add("hidden");
          return false;
        }
      };

      elements.loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        elements.loginError.textContent = "";
        try {
          const result = await api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ passphrase: elements.passphrase.value || "" })
          });
          state.csrfToken = result.csrfToken || "";
          elements.passphrase.value = "";
          elements.auth.classList.add("hidden");
          elements.app.classList.remove("hidden");
          await loadConversations();
          if (state.conversations[0]) {
            state.activeConversationId = state.conversations[0].conversationId;
            await loadConversation(state.activeConversationId);
          }
        } catch (error) {
          elements.loginError.textContent = error.message || "Login failed";
        }
      });

      elements.newChat.addEventListener("click", async () => {
        await createConversation();
      });

      elements.refreshList.addEventListener("click", async () => {
        await loadConversations();
      });

      elements.renameChat.addEventListener("click", async () => {
        if (!state.activeConversationId) {
          return;
        }
        const nextTitle = window.prompt("Rename conversation");
        if (!nextTitle) {
          return;
        }
        await api("/api/conversations/" + encodeURIComponent(state.activeConversationId), {
          method: "PATCH",
          body: JSON.stringify({ title: nextTitle })
        });
        await loadConversations();
        await loadConversation(state.activeConversationId);
      });

      elements.deleteChat.addEventListener("click", async () => {
        if (!state.activeConversationId) {
          return;
        }
        if (!window.confirm("Delete this conversation?")) {
          return;
        }
        await api("/api/conversations/" + encodeURIComponent(state.activeConversationId), { method: "DELETE" });
        state.activeConversationId = null;
        elements.chatTitle.textContent = "AgentL";
        renderMessages([]);
        await loadConversations();
      });

      elements.logout.addEventListener("click", async () => {
        await api("/api/auth/logout", { method: "POST" });
        state.activeConversationId = null;
        state.conversations = [];
        state.csrfToken = "";
        await requireAuth();
      });

      elements.composer.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = elements.prompt.value;
        elements.prompt.value = "";
        await sendMessage(value);
      });

      (async () => {
        const authenticated = await requireAuth();
        if (!authenticated) {
          return;
        }
        await loadConversations();
        if (state.conversations[0]) {
          state.activeConversationId = state.conversations[0].conversationId;
          await loadConversation(state.activeConversationId);
          renderConversationList();
        }
      })();
    </script>
  </body>
</html>`;
