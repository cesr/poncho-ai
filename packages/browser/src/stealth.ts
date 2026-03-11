import { platform } from "node:os";

/**
 * Returns a realistic Chrome user-agent string for the host OS.
 * Uses a recent stable Chrome version to blend in with normal traffic.
 */
export function defaultUserAgent(): string {
  const chromeVersion = "145.0.7632.117";
  const os = platform();

  if (os === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  if (os === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/**
 * Static Chromium flags that suppress automation fingerprints.
 */
export const STEALTH_ARGS: string[] = [
  "--disable-blink-features=AutomationControlled",
  "--enable-webgl",
  "--use-gl=angle",
  "--enable-features=VaapiVideoDecoder",
  "--ignore-gpu-blocklist",
];

/**
 * Build the full stealth args array including the browser-level user-agent
 * override. The `--user-agent` flag sets the UA globally — including in
 * Web Workers and Service Workers — which context-level overrides can't reach.
 */
export function buildStealthArgs(userAgent: string): string[] {
  return [...STEALTH_ARGS, `--user-agent=${userAgent}`];
}

/**
 * JS source injected via Playwright context.addInitScript().
 * Runs before ALL page scripts on every navigation, every tab.
 * Each section has its own try/catch so one failure doesn't block the rest.
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. navigator.webdriver → false
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true,
    });
  } catch {}

  // 2. window.chrome stub (headless Chromium omits it)
  try {
    if (!window.chrome) {
      const chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails() { return null; },
          getIsInstalled() { return false; },
          installState() { return 'not_installed'; },
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', FUCHSIA: 'fuchsia', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
          connect() { return { onMessage: { addListener() {}, removeListener() {} }, postMessage() {}, disconnect() {} }; },
          sendMessage() {},
          id: undefined,
        },
        csi() { return {}; },
        loadTimes() { return {}; },
      };
      Object.defineProperty(window, 'chrome', {
        value: chrome,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
  } catch {}

  // 3. navigator.plugins — expose the plugins a real Chrome has
  try {
    const makeMimeType = (type, desc, suffixes, plugin) => {
      const mt = Object.create(MimeType.prototype);
      Object.defineProperties(mt, {
        type: { get: () => type },
        description: { get: () => desc },
        suffixes: { get: () => suffixes },
        enabledPlugin: { get: () => plugin },
      });
      return mt;
    };
    const fakePluginDefs = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', hasMime: true },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', hasMime: false },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', hasMime: false },
    ];
    const plugins = [];
    for (const fp of fakePluginDefs) {
      const p = Object.create(Plugin.prototype);
      const mime = fp.hasMime ? makeMimeType('application/x-google-chrome-pdf', 'Portable Document Format', 'pdf', p) : null;
      Object.defineProperties(p, {
        name: { get: () => fp.name },
        filename: { get: () => fp.filename },
        description: { get: () => fp.description },
        length: { get: () => mime ? 1 : 0 },
      });
      if (mime) Object.defineProperty(p, 0, { get: () => mime });
      Object.defineProperty(p, 'item', { value: (i) => i === 0 && mime ? mime : null });
      Object.defineProperty(p, 'namedItem', { value: (n) => mime && n === mime.type ? mime : null });
      Object.defineProperty(p, Symbol.iterator, { value: function*() { if (mime) yield mime; } });
      plugins.push(p);
    }
    const pluginArray = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => Object.defineProperty(pluginArray, i, { get: () => p, enumerable: true }));
    Object.defineProperty(pluginArray, 'length', { get: () => plugins.length });
    Object.defineProperty(pluginArray, 'item', { value: (i) => plugins[i] ?? null });
    Object.defineProperty(pluginArray, 'namedItem', { value: (n) => plugins.find(p => p.name === n) ?? null });
    Object.defineProperty(pluginArray, 'refresh', { value: () => {} });
    Object.defineProperty(pluginArray, Symbol.iterator, { value: function*() { for (const p of plugins) yield p; } });
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray, configurable: true });
  } catch {}

  // 4. navigator.languages
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => Object.freeze(['en-US', 'en']),
      configurable: true,
    });
  } catch {}

  // 5. Notification.permission — return "default" (headless returns "denied")
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', {
        get: () => 'default',
        configurable: true,
      });
    }
  } catch {}

  // 6. WebGL vendor/renderer — hide SwiftShader (headless giveaway)
  try {
    const UNMASKED_VENDOR  = 0x9245;
    const UNMASKED_RENDERER = 0x9246;
    const spoofVendor = 'Google Inc. (Intel)';
    const spoofRenderer = 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics, OpenGL 4.1)';
    for (const Ctx of [WebGLRenderingContext, typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : null].filter(Boolean)) {
      const orig = Ctx.prototype.getParameter;
      Ctx.prototype.getParameter = function(param) {
        if (param === UNMASKED_VENDOR)  return spoofVendor;
        if (param === UNMASKED_RENDERER) return spoofRenderer;
        return orig.call(this, param);
      };
    }
  } catch {}

  // 7. Prevent iframe-based detection of navigator.webdriver
  try {
    const origCreate = Document.prototype.createElement;
    Document.prototype.createElement = function(...args) {
      const el = origCreate.apply(this, args);
      if (el.nodeName === 'IFRAME') {
        const origGet = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')?.get;
        if (origGet) {
          Object.defineProperty(el, 'contentWindow', {
            get() {
              const w = origGet.call(this);
              if (w) {
                try {
                  Object.defineProperty(w.navigator, 'webdriver', { get: () => false, configurable: true });
                } catch {}
              }
              return w;
            },
            configurable: true,
          });
        }
      }
      return el;
    };
  } catch {}
})();
`;
