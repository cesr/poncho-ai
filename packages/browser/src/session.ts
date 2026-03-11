import { resolve, join } from "node:path";
import { homedir, tmpdir, platform } from "node:os";
import { mkdir, readFile, unlink } from "node:fs/promises";
import type {
  BrowserConfig,
  BrowserFrame,
  BrowserStatus,
  ScreencastOptions,
  MouseInputEvent,
  KeyboardInputEvent,
  ScrollInputEvent,
} from "./types.js";
import { defaultUserAgent, buildStealthArgs, STEALTH_INIT_SCRIPT } from "./stealth.js";

type FrameListener = (frame: BrowserFrame) => void;
type StatusListener = (status: BrowserStatus) => void;

let BrowserManagerCtor: (new () => BrowserManagerInstance) | undefined;

interface CDPSessionHandle {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface BrowserContextHandle {
  addInitScript(script: string | { path?: string; content?: string }): Promise<void>;
}

interface BrowserManagerInstance {
  isLaunched(): boolean;
  launch(options: Record<string, unknown>): Promise<void>;
  getPage(): { url(): string; title(): Promise<string>; screenshot(opts?: Record<string, unknown>): Promise<Buffer>; goBack(): Promise<unknown>; goForward(): Promise<unknown>; evaluate(fn: string | (() => unknown)): Promise<unknown> };
  getContext(): BrowserContextHandle | null;
  getSnapshot(options?: { interactive?: boolean; compact?: boolean }): Promise<{ tree: string; refs: Record<string, unknown> }>;
  getLocatorFromRef(ref: string): { click(): Promise<void> } | null;
  getLocator(selector: string): { fill(text: string): Promise<void>; click(): Promise<void> };
  newTab(): Promise<void>;
  switchTo(index: number): Promise<{ index: number; url: string }>;
  closeTab(index?: number): Promise<{ closed: number; remaining: number }>;
  listTabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>>;
  getActiveIndex(): number;
  startScreencast(
    callback: (frame: { data: string; metadata: Record<string, number>; sessionId: number }) => void,
    options?: Record<string, unknown>,
  ): Promise<void>;
  stopScreencast(): Promise<void>;
  isScreencasting(): boolean;
  injectMouseEvent(params: Record<string, unknown>): Promise<void>;
  injectKeyboardEvent(params: Record<string, unknown>): Promise<void>;
  getCDPSession(): Promise<CDPSessionHandle>;
  saveStorageState(path: string): Promise<void>;
  close(): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
}

async function getBrowserManagerCtor(): Promise<new () => BrowserManagerInstance> {
  if (!BrowserManagerCtor) {
    const mod = await import("agent-browser/dist/browser.js");
    BrowserManagerCtor = mod.BrowserManager as unknown as new () => BrowserManagerInstance;
  }
  return BrowserManagerCtor;
}

const MAX_TABS = 8;

/**
 * Init script that forces new-tab navigations (window.open, target="_blank")
 * to open in the current tab. Runs before page scripts on every navigation.
 */
const SAME_TAB_INIT_SCRIPT = `
(() => {
  // Override window.open to navigate in-place
  try {
    const origOpen = window.open;
    window.open = function(url, target, features) {
      if (url) {
        location.href = url;
        return window;
      }
      return origOpen.call(this, url, target, features);
    };
  } catch {}

  // Rewrite target="_blank" on existing and future links
  try {
    const rewrite = (el) => {
      if (el.tagName === 'A' && el.target === '_blank') {
        el.target = '_self';
      }
    };
    // Catch links already in the DOM
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('a[target="_blank"]').forEach(rewrite);
    });
    // Catch dynamically added links
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          rewrite(node);
          if (node.querySelectorAll) {
            node.querySelectorAll('a[target="_blank"]').forEach(rewrite);
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
})();
`;

// Per-conversation tab state
interface ConversationTab {
  tabIndex: number;
  url?: string;
  active: boolean;
  lastUsed: number;
  frameListeners: Set<FrameListener>;
  statusListeners: Set<StatusListener>;
}

export class BrowserSession {
  private readonly config: BrowserConfig;
  private readonly sessionId: string;
  private manager: BrowserManagerInstance | undefined;

  // Tab management: conversationId → tab state
  private readonly tabs = new Map<string, ConversationTab>();

  // Whether context-level stealth init script has been installed
  private _contextStealthInstalled = false;

  // Track which tabs have had per-page CDP UA override applied
  private readonly _uaOverrideApplied = new Set<string>();

  // Serialization lock for tab-switching operations
  private _lockQueue: Array<() => void> = [];
  private _locked = false;

  // Currently screencast conversation (only one at a time due to CDP)
  private _screencastConversation: string | undefined;

  constructor(sessionId: string, config: BrowserConfig = {}) {
    this.sessionId = sessionId;
    this.config = config;
  }

  get profileDir(): string {
    return this.config.profileDir
      ?? resolve(homedir(), ".poncho", "browser-profiles", this.sessionId);
  }

  // -----------------------------------------------------------------------
  // Lock for serializing tab-switching operations
  // -----------------------------------------------------------------------

  private async lock(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._lockQueue.indexOf(resolve);
        if (idx !== -1) this._lockQueue.splice(idx, 1);
        reject(new Error("Browser operation timed out waiting for lock (30s)"));
      }, 30_000);
      this._lockQueue.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  private unlock(): void {
    const next = this._lockQueue.shift();
    if (next) next();
    else this._locked = false;
  }

  // -----------------------------------------------------------------------
  // Core browser + tab management
  // -----------------------------------------------------------------------

  private get stealthEnabled(): boolean {
    return this.config.stealth !== false;
  }

  private get stealthUserAgent(): string | undefined {
    if (this.config.userAgent) return this.config.userAgent;
    if (this.stealthEnabled) return defaultUserAgent();
    return undefined;
  }

  /**
   * Install the stealth init script on the Playwright BrowserContext.
   * This runs before ALL page scripts on every navigation across every tab.
   * Only needs to be called once per browser launch.
   */
  private async installContextStealth(mgr: BrowserManagerInstance): Promise<void> {
    if (this._contextStealthInstalled) return;
    const ctx = mgr.getContext();
    if (!ctx) {
      console.warn("[poncho][browser] Cannot install stealth: no browser context");
      return;
    }
    try {
      await ctx.addInitScript({ content: STEALTH_INIT_SCRIPT });
      this._contextStealthInstalled = true;
      console.log("[poncho][browser] Stealth init script installed on context");
    } catch (err) {
      console.warn("[poncho][browser] Failed to install stealth init script:", (err as Error)?.message ?? err);
    }
  }

  /**
   * Force all new-tab navigations (window.open, target="_blank") to open
   * in the current tab instead. Agents operate on a single tab at a time
   * and can't see or interact with popups.
   */
  private async installSameTabScript(mgr: BrowserManagerInstance): Promise<void> {
    const ctx = mgr.getContext();
    if (!ctx) return;
    try {
      await ctx.addInitScript({ content: SAME_TAB_INIT_SCRIPT });
    } catch (err) {
      console.warn("[poncho][browser] Failed to install same-tab init script:", (err as Error)?.message ?? err);
    }
  }

  /**
   * Override the user-agent via CDP on the current page target.
   * CDP Network.setUserAgentOverride is per-target, so call per-tab.
   */
  private async overrideUserAgentOnPage(mgr: BrowserManagerInstance, conversationId: string): Promise<void> {
    if (this._uaOverrideApplied.has(conversationId)) return;
    const ua = this.stealthUserAgent;
    if (!ua) return;
    try {
      const cdp = await mgr.getCDPSession();
      await cdp.send("Network.setUserAgentOverride", {
        userAgent: ua,
        acceptLanguage: "en-US,en;q=0.9",
        platform: platform() === "darwin" ? "macOS" : platform() === "win32" ? "Win32" : "Linux x86_64",
      });
      this._uaOverrideApplied.add(conversationId);
    } catch (err) {
      console.warn("[poncho][browser] Failed to override UA via CDP:", (err as Error)?.message ?? err);
    }
  }

  private get isRemote(): boolean {
    return !!(this.config.provider || this.config.cdpUrl);
  }

  private get isServerless(): boolean {
    return !!(
      process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.AWS_EXECUTION_ENV ||
      process.env.SERVERLESS
    );
  }

  /**
   * Resolve executablePath for local launches. When no explicit path is set
   * and we're on a serverless platform, try `@sparticuz/chromium` automatically.
   */
  private async resolveExecutablePath(): Promise<string | undefined> {
    if (this.config.executablePath) return this.config.executablePath;
    if (!this.isServerless) return undefined;
    try {
      // Dynamic require — @sparticuz/chromium is an optional peer dependency
      // that the user installs in their agent project for serverless runtimes.
      const spec = ["@sparticuz", "chromium"].join("/");
      const mod = await import(/* webpackIgnore: true */ spec);
      const chromium = mod.default ?? mod;
      const path = await chromium.executablePath();
      console.log(`[poncho][browser] Auto-detected @sparticuz/chromium: ${path}`);
      return path;
    } catch {
      return undefined;
    }
  }

  private async launchFreshManager(): Promise<BrowserManagerInstance> {
    const Ctor = await getBrowserManagerCtor();
    const mgr = new Ctor();

    const viewport = this.config.viewport ?? { width: 1280, height: 720 };
    const executablePath = await this.resolveExecutablePath();

    const launchOpts: Record<string, unknown> = {
      action: "launch",
      headless: this.config.headless ?? true,
      viewport: { width: viewport.width ?? 1280, height: viewport.height ?? 720 },
      executablePath,
    };

    if (this.config.cdpUrl) {
      launchOpts.cdpUrl = this.config.cdpUrl;
      console.log(`[poncho][browser] Connecting via CDP: ${this.config.cdpUrl}`);
    } else if (this.config.provider) {
      launchOpts.provider = this.config.provider;
      console.log(`[poncho][browser] Using cloud provider: ${this.config.provider}`);
    } else {
      const profileDir = this.isServerless && !this.config.profileDir
        ? join(tmpdir(), "poncho-browser", this.sessionId)
        : this.profileDir;
      await mkdir(profileDir, { recursive: true });
      launchOpts.profile = profileDir;
    }

    if (this.stealthEnabled) {
      const ua = this.stealthUserAgent!;
      launchOpts.userAgent = ua;
      if (!this.isRemote) {
        launchOpts.args = buildStealthArgs(ua);
      }
      console.log("[poncho][browser] Launching with stealth mode enabled (UA: " + ua + ")");
    } else if (this.config.userAgent) {
      launchOpts.userAgent = this.config.userAgent;
    }

    await mgr.launch(launchOpts as Parameters<BrowserManagerInstance["launch"]>[0]);

    // Reset stealth tracking for fresh browser
    this._contextStealthInstalled = false;
    this._uaOverrideApplied.clear();

    // Install context-level stealth (covers all tabs, all navigations)
    if (this.stealthEnabled) {
      await this.installContextStealth(mgr);
    }

    // Redirect new-tab navigations into the current tab
    await this.installSameTabScript(mgr);

    try {
      const cdp = await mgr.getCDPSession();
      await cdp.send("Debugger.disable");
      await this.restoreStorageState(cdp);
    } catch { /* best-effort */ }

    this.manager = mgr;
    return mgr;
  }

  private async ensureManager(): Promise<BrowserManagerInstance> {
    if (this.manager) {
      try {
        if (this.manager.isLaunched()) return this.manager;
      } catch { /* stale manager */ }
      // Manager exists but is dead/stale -- discard it
      try { await this.manager.close(); } catch { /* */ }
      this.manager = undefined;
      this._contextStealthInstalled = false;
      this._uaOverrideApplied.clear();
      // Clear tab state since they belonged to the dead browser
      for (const [cid, tab] of this.tabs) {
        if (tab.tabIndex >= 0) {
          tab.tabIndex = -1;
          tab.active = false;
          tab.url = undefined;
        }
      }
    }

    return this.launchFreshManager();
  }

  private async evictOldestTab(mgr: BrowserManagerInstance): Promise<void> {
    let oldest: { cid: string; tab: ConversationTab } | undefined;
    for (const [cid, tab] of this.tabs) {
      if (tab.tabIndex < 0) continue;
      if (!oldest || tab.lastUsed < oldest.tab.lastUsed) {
        oldest = { cid, tab };
      }
    }
    if (!oldest) return;
    console.log(`[poncho][browser] Evicting idle tab for conversation ${oldest.cid.slice(0, 8)}...`);
    if (this._screencastConversation === oldest.cid) {
      try { await mgr.stopScreencast(); } catch { /* */ }
      this._screencastConversation = undefined;
    }
    if (this.tabs.size > 1) {
      try { await mgr.closeTab(oldest.tab.tabIndex); } catch { /* */ }
      for (const [, t] of this.tabs) {
        if (t.tabIndex > oldest.tab.tabIndex) t.tabIndex--;
      }
    }
    oldest.tab.active = false;
    oldest.tab.url = undefined;
    this.emitStatus(oldest.cid);
    this.tabs.delete(oldest.cid);
    this._uaOverrideApplied.delete(oldest.cid);
  }

  /** Reconcile tab indices with the manager's actual page list. */
  private async reconcileTabs(mgr: BrowserManagerInstance): Promise<void> {
    try {
      const managerTabs = await mgr.listTabs();
      const managerUrls = managerTabs.map((t) => t.url);
      for (const [cid, tab] of this.tabs) {
        if (tab.tabIndex >= managerUrls.length) {
          tab.active = false;
          tab.url = undefined;
          this.emitStatus(cid);
          this.tabs.delete(cid);
        }
      }
    } catch { /* best-effort */ }
  }

  private realTabCount(): number {
    let n = 0;
    for (const t of this.tabs.values()) { if (t.tabIndex >= 0) n++; }
    return n;
  }

  private async switchToConversation(mgr: BrowserManagerInstance, conversationId: string): Promise<ConversationTab> {
    let tab = this.tabs.get(conversationId);
    if (!tab || tab.tabIndex < 0) {
      const realTabs = this.realTabCount();
      if (realTabs >= MAX_TABS) {
        await this.evictOldestTab(mgr);
      }
      if (realTabs > 0) {
        await mgr.newTab();
      }
      const existing = tab;
      tab = {
        tabIndex: mgr.getActiveIndex(),
        active: true,
        lastUsed: Date.now(),
        frameListeners: existing?.frameListeners ?? new Set(),
        statusListeners: existing?.statusListeners ?? new Set(),
      };
      this.tabs.set(conversationId, tab);
    } else {
      if (mgr.getActiveIndex() !== tab.tabIndex) {
        await mgr.switchTo(tab.tabIndex);
      }
      tab.lastUsed = Date.now();
    }
    return tab;
  }

  /** Check if a conversation has an active browser tab. */
  isActiveFor(conversationId: string): boolean {
    return this.tabs.has(conversationId) && (this.tabs.get(conversationId)!.active);
  }

  /** Get the current URL for a conversation's tab. */
  getUrl(conversationId: string): string | undefined {
    return this.tabs.get(conversationId)?.url;
  }

  /** Whether the browser has been launched. */
  get isLaunched(): boolean {
    return !!this.manager?.isLaunched();
  }

  // -----------------------------------------------------------------------
  // Browser operations (all scoped by conversationId)
  // -----------------------------------------------------------------------

  async open(conversationId: string, url: string): Promise<{ title?: string }> {
    await this.lock();
    try {
      return await this._doOpen(conversationId, url);
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "";
      if (msg.includes("not launched") || msg.includes("closed") || msg.includes("Target closed")) {
        console.log("[poncho][browser] Browser died mid-open, relaunching...");
        try { await this.manager?.close(); } catch { /* */ }
        this.manager = undefined;
        this._contextStealthInstalled = false;
        this._uaOverrideApplied.clear();
        for (const [, t] of this.tabs) {
          if (t.tabIndex >= 0) { t.tabIndex = -1; t.active = false; t.url = undefined; }
        }
        return await this._doOpen(conversationId, url);
      }
      throw err;
    } finally {
      this.unlock();
    }
  }

  private async _doOpen(conversationId: string, url: string): Promise<{ title?: string }> {
    const mgr = await this.ensureManager();
    const tab = await this.switchToConversation(mgr, conversationId);

    // Ensure context-level stealth is installed (covers reused managers too)
    if (this.stealthEnabled) {
      await this.installContextStealth(mgr);
      await this.overrideUserAgentOnPage(mgr, conversationId);
    }

    const page = mgr.getPage();

    await (page as unknown as { goto(url: string, opts?: Record<string, unknown>): Promise<unknown> })
      .goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    tab.url = page.url();
    tab.active = true;
    this.emitStatus(conversationId);

    const title = await page.title();
    return { title: title || undefined };
  }

  async snapshot(conversationId: string): Promise<string> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      const snap = await mgr.getSnapshot({ interactive: true, compact: true });
      return snap.tree;
    } finally {
      this.unlock();
    }
  }

  async click(conversationId: string, ref: string): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      const tab = await this.switchToConversation(mgr, conversationId);
      const locator = mgr.getLocatorFromRef(ref);
      if (!locator) throw new Error(`No element found for ref ${ref}`);
      await locator.click();
      tab.url = mgr.getPage().url();
    } finally {
      this.unlock();
    }
  }

  async type(conversationId: string, ref: string, text: string): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      const tab = await this.switchToConversation(mgr, conversationId);
      const locator = mgr.getLocatorFromRef(ref);
      if (!locator) throw new Error(`No element found for ref ${ref}`);
      await (locator as unknown as { fill(text: string): Promise<void> }).fill(text);
      tab.url = mgr.getPage().url();
    } finally {
      this.unlock();
    }
  }

  async screenshot(conversationId: string): Promise<string> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      const page = mgr.getPage();
      const buf = await page.screenshot({ type: "jpeg", quality: 75 });
      return buf.toString("base64");
    } finally {
      this.unlock();
    }
  }

  async content(conversationId: string): Promise<{ text: string; url: string; title: string }> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      const page = mgr.getPage();
      const text = (await page.evaluate("document.body.innerText")) as string;
      const title = await page.title();
      return { text: text ?? "", url: page.url(), title: title ?? "" };
    } finally {
      this.unlock();
    }
  }

  async scroll(conversationId: string, direction: "up" | "down", amount?: number): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      const page = mgr.getPage();
      const pixels = amount ?? 600;
      const delta = direction === "down" ? pixels : -pixels;
      await page.evaluate(`window.scrollBy(0, ${delta})`);
    } finally {
      this.unlock();
    }
  }

  async clickText(conversationId: string, text: string, exact?: boolean): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      const tab = await this.switchToConversation(mgr, conversationId);
      const selector = exact ? `text="${text}"` : `text=${text}`;
      const locator = mgr.getLocator(selector);
      await locator.click();
      tab.url = mgr.getPage().url();
    } finally {
      this.unlock();
    }
  }

  async executeJs(conversationId: string, script: string): Promise<unknown> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      const page = mgr.getPage();
      return await page.evaluate(script);
    } finally {
      this.unlock();
    }
  }

  async closeTab(conversationId: string): Promise<void> {
    await this.lock();
    try {
      const tab = this.tabs.get(conversationId);
      if (!tab) return;

      if (this._screencastConversation === conversationId) {
        try { await this.manager?.stopScreencast(); } catch { /* */ }
        this._screencastConversation = undefined;
      }

      const otherRealTabs = this.realTabCount() - (tab.tabIndex >= 0 ? 1 : 0);
      if (otherRealTabs > 0 && this.manager?.isLaunched() && tab.tabIndex >= 0) {
        try { await this.manager.closeTab(tab.tabIndex); } catch { /* */ }
        for (const [, t] of this.tabs) {
          if (t.tabIndex > tab.tabIndex) t.tabIndex--;
        }
      } else if (this.manager?.isLaunched()) {
        await this.persistStorageState();
        try { await this.manager.close(); } catch { /* */ }
        this.manager = undefined;
      }

      tab.active = false;
      tab.url = undefined;
      this.emitStatus(conversationId);
      this.tabs.delete(conversationId);
      this._uaOverrideApplied.delete(conversationId);
    } finally {
      this.unlock();
    }
  }

  async navigate(conversationId: string, action: string): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      const tab = await this.switchToConversation(mgr, conversationId);
      const page = mgr.getPage();
      if (action === "back") await page.goBack();
      else if (action === "forward") await page.goForward();
      else throw new Error(`Unknown navigation action: ${action}`);
      tab.url = page.url();
    } finally {
      this.unlock();
    }
  }

  // -----------------------------------------------------------------------
  // Screencast (one active at a time, tied to the viewed conversation)
  // -----------------------------------------------------------------------

  async startScreencast(conversationId: string, options?: ScreencastOptions): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      const tab = this.tabs.get(conversationId);
      if (!tab) { return; }

      // Always stop any existing screencast so we get a fresh CDP stream
      if (mgr.isScreencasting()) {
        try { await mgr.stopScreencast(); } catch { /* */ }
      }

      if (mgr.getActiveIndex() !== tab.tabIndex) {
        await mgr.switchTo(tab.tabIndex);
      }

      this._screencastConversation = conversationId;
      await mgr.startScreencast(
        (frame) => {
          const cid = this._screencastConversation;
          if (!cid) return;
          const t = this.tabs.get(cid);
          if (!t) return;
          const browserFrame: BrowserFrame = {
            data: frame.data,
            width: frame.metadata.deviceWidth,
            height: frame.metadata.deviceHeight,
            timestamp: Date.now(),
          };
          for (const listener of t.frameListeners) {
            try { listener(browserFrame); } catch { /* */ }
          }
        },
        {
          format: options?.format ?? "jpeg",
          quality: options?.quality ?? this.config.quality ?? 60,
          maxWidth: options?.maxWidth ?? this.config.viewport?.width ?? 1280,
          maxHeight: options?.maxHeight ?? this.config.viewport?.height ?? 720,
          everyNthFrame: options?.everyNthFrame ?? this.config.everyNthFrame ?? 2,
        },
      );
    } finally {
      this.unlock();
    }
  }

  async stopScreencast(): Promise<void> {
    if (!this.manager?.isScreencasting()) return;
    await this.manager.stopScreencast();
    this._screencastConversation = undefined;
  }

  // -----------------------------------------------------------------------
  // Per-conversation event listeners
  // -----------------------------------------------------------------------

  onFrame(conversationId: string, listener: FrameListener): () => void {
    let tab = this.tabs.get(conversationId);
    if (!tab) {
      tab = { tabIndex: -1, active: false, lastUsed: Date.now(), frameListeners: new Set(), statusListeners: new Set() };
      this.tabs.set(conversationId, tab);
    }
    tab.frameListeners.add(listener);
    return () => { tab!.frameListeners.delete(listener); };
  }

  onStatus(conversationId: string, listener: StatusListener): () => void {
    let tab = this.tabs.get(conversationId);
    if (!tab) {
      tab = { tabIndex: -1, active: false, lastUsed: Date.now(), frameListeners: new Set(), statusListeners: new Set() };
      this.tabs.set(conversationId, tab);
    }
    tab.statusListeners.add(listener);
    return () => { tab!.statusListeners.delete(listener); };
  }

  // -----------------------------------------------------------------------
  // User input injection (all scoped by conversationId)
  // -----------------------------------------------------------------------

  async injectMouse(conversationId: string, event: MouseInputEvent): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      await mgr.injectMouseEvent({
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button ?? "left",
        clickCount: event.clickCount ?? 1,
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
      });
    } finally {
      this.unlock();
    }
  }

  async injectKeyboard(conversationId: string, event: KeyboardInputEvent): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      const cdp = await mgr.getCDPSession();
      let cdpType: string = event.type;
      if (event.type === "keyDown" && !event.text) cdpType = "rawKeyDown";
      await cdp.send("Input.dispatchKeyEvent", {
        type: cdpType,
        key: event.key,
        code: event.code,
        text: event.text,
        windowsVirtualKeyCode: event.keyCode ?? 0,
        nativeVirtualKeyCode: event.keyCode ?? 0,
      });
    } finally {
      this.unlock();
    }
  }

  async injectPaste(conversationId: string, text: string): Promise<void> {
    await this.lock();
    try {
      const mgr = await this.ensureManager();
      await this.switchToConversation(mgr, conversationId);
      const cdp = await mgr.getCDPSession();
      await cdp.send("Input.insertText", { text });
    } finally {
      this.unlock();
    }
  }

  async injectScroll(conversationId: string, event: ScrollInputEvent): Promise<void> {
    await this.injectMouse(conversationId, {
      type: "mouseWheel",
      x: event.x ?? 0,
      y: event.y ?? 0,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
    });
  }

  // -----------------------------------------------------------------------
  // Session persistence & shutdown
  // -----------------------------------------------------------------------

  async saveState(storagePath: string): Promise<void> {
    if (!this.manager?.isLaunched()) return;
    await mkdir(resolve(storagePath, ".."), { recursive: true });
    await this.manager.saveStorageState(storagePath);
  }

  private async persistStorageState(): Promise<void> {
    const persistence = this.config.storagePersistence;
    if (!persistence || !this.manager?.isLaunched()) return;
    try {
      const tmpFile = join(tmpdir(), `poncho-browser-state-${this.sessionId}-${Date.now()}.json`);
      await this.manager.saveStorageState(tmpFile);
      const json = await readFile(tmpFile, "utf8");
      await unlink(tmpFile).catch(() => {});
      await persistence.save(json);
      console.log(`[poncho][browser] Storage state persisted (${json.length} bytes)`);
    } catch (err) {
      console.warn("[poncho][browser] Failed to persist storage state:", (err as Error)?.message ?? err);
    }
  }

  private async restoreStorageState(
    cdp: { send(method: string, params?: Record<string, unknown>): Promise<unknown> },
  ): Promise<void> {
    const persistence = this.config.storagePersistence;
    if (!persistence) return;
    try {
      const json = await persistence.load();
      if (!json) return;
      const state = JSON.parse(json) as {
        cookies?: Array<Record<string, unknown>>;
        origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
      };
      if (state.cookies?.length) {
        await cdp.send("Network.setCookies", { cookies: state.cookies });
        console.log(`[poncho][browser] Restored ${state.cookies.length} cookies`);
      }
      if (state.origins?.length) {
        const entries: Record<string, Array<{ name: string; value: string }>> = {};
        for (const origin of state.origins) {
          if (origin.localStorage?.length) {
            entries[origin.origin] = origin.localStorage;
          }
        }
        if (Object.keys(entries).length) {
          const script = `try{const __e=${JSON.stringify(entries)};const __i=__e[location.origin];if(__i)for(const{name:n,value:v}of __i)try{localStorage.setItem(n,v)}catch{}}catch{}`;
          await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
          console.log(`[poncho][browser] Registered localStorage restore for ${Object.keys(entries).length} origin(s)`);
        }
      }
    } catch (err) {
      console.warn("[poncho][browser] Failed to restore storage state:", (err as Error)?.message ?? err);
    }
  }

  async close(): Promise<void> {
    try { await this.stopScreencast(); } catch { /* */ }
    await this.persistStorageState();
    try { await this.manager?.close(); } catch { /* */ }
    this.manager = undefined;
    this._contextStealthInstalled = false;
    this._uaOverrideApplied.clear();
    for (const [cid, tab] of this.tabs) {
      tab.active = false;
      tab.url = undefined;
      this.emitStatus(cid);
    }
    this.tabs.clear();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private emitStatus(conversationId: string): void {
    const tab = this.tabs.get(conversationId);
    const status: BrowserStatus = {
      active: tab?.active ?? false,
      url: tab?.url,
      interactionAllowed: tab?.active ?? false,
    };
    if (tab) {
      for (const listener of tab.statusListeners) {
        try { listener(status); } catch { /* */ }
      }
    }
  }
}
