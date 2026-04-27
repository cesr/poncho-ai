// Tiny zero-dependency logger for the dev server.
//
// Format: `HH:mm:ss <symbol> <scope-padded> <message>`
//   10:23:45 ✓ poncho     dev server ready at http://localhost:3000
//   10:25:01 ✗ poncho     internal error: ...
//
// Honors `NO_COLOR` / `FORCE_COLOR` and `LOG_LEVEL` (debug|info|warn|error|silent).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type LevelName = keyof typeof LEVELS;

const parseLevel = (raw: string | undefined): LevelName => {
  const v = (raw ?? "").trim().toLowerCase();
  return v in LEVELS ? (v as LevelName) : "info";
};

const colorEnabled = ((): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
})();

const wrap = (open: number, close = 0): ((s: string) => string) =>
  colorEnabled
    ? (s: string) => `\x1b[${open}m${s}\x1b[${close}m`
    : (s: string) => s;

const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
};

// Per-scope colors. Each scope name gets a stable, distinct color derived
// from a hash of its base name (so children like `cron:hourly_check` share
// the parent's color). Truecolor → unique hue per scope (best). 256-color
// fallback → curated palette. 16-color fallback → small palette.
const supportsTruecolor = ((): boolean => {
  if (!colorEnabled) return false;
  const t = process.env.COLORTERM;
  return t === "truecolor" || t === "24bit";
})();

const supports256 = ((): boolean => {
  if (!colorEnabled) return false;
  if (supportsTruecolor) return true;
  return Boolean(process.env.TERM && /256/.test(process.env.TERM));
})();

const PALETTE_256 = [
  33, 39, 38, 75, 81, 45, 50, 49, 43, 36, 73, 80, 86, 76, 82, 113,
  119, 148, 149, 178, 184, 220, 221, 208, 209, 214, 215, 202, 203,
  198, 199, 200, 207, 206, 171, 165, 135, 141, 99, 105, 129, 134, 174,
];
const PALETTE_16 = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];

const hashScope = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
};

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
};

const scopeColorCache = new Map<string, (s: string) => string>();
const colorForScope = (scope: string): ((s: string) => string) => {
  if (!colorEnabled) return (s) => s;
  const base = scope.split(":")[0]!;
  const cached = scopeColorCache.get(base);
  if (cached) return cached;
  const hash = hashScope(base);
  let fn: (s: string) => string;
  if (supportsTruecolor) {
    // Spread hues using the golden-angle multiplier for good visual distance
    // between consecutive scopes. Mid-range S/L reads on dark and light bgs.
    const hue = (hash * 137) % 360;
    // Soft pastel: low saturation, high lightness — readable on dark and
    // light backgrounds without being eye-grabbing.
    const [r, g, b] = hslToRgb(hue, 0.40, 0.75);
    fn = (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  } else if (supports256) {
    const code = PALETTE_256[hash % PALETTE_256.length];
    fn = (s: string) => `\x1b[38;5;${code}m${s}\x1b[39m`;
  } else {
    const code = PALETTE_16[hash % PALETTE_16.length];
    fn = (s: string) => `\x1b[${code}m${s}\x1b[39m`;
  }
  scopeColorCache.set(base, fn);
  return fn;
};

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
const formatTime = (d: Date): string =>
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const SCOPE_WIDTH = 10;
const padScope = (scope: string): string =>
  scope.length >= SCOPE_WIDTH ? scope : scope + " ".repeat(SCOPE_WIDTH - scope.length);

type Variant = "debug" | "info" | "warn" | "error" | "success" | "ready" | "neutral";

const SYMBOLS: Record<Variant, string> = {
  debug: "·",
  info: "→",
  warn: "⚠",
  error: "✗",
  success: "✓",
  ready: "✓",
  neutral: "•",
};

const SYMBOL_COLOR: Record<Variant, (s: string) => string> = {
  debug: c.dim,
  info: c.cyan,
  warn: c.yellow,
  error: c.red,
  success: c.green,
  ready: c.green,
  neutral: c.gray,
};

const VARIANT_LEVEL: Record<Variant, LevelName> = {
  debug: "debug",
  info: "info",
  neutral: "info",
  success: "info",
  ready: "info",
  warn: "warn",
  error: "error",
};

let currentLevel: LevelName = parseLevel(process.env.LOG_LEVEL);

export const setLogLevel = (level: LevelName): void => {
  currentLevel = level;
};

const stringifyArg = (a: unknown): string => {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
};

const write = (variant: Variant, scope: string, msg: string, extras: unknown[]): void => {
  if (LEVELS[VARIANT_LEVEL[variant]] < LEVELS[currentLevel]) return;
  const stream = variant === "warn" || variant === "error" ? process.stderr : process.stdout;
  const time = c.gray(formatTime(new Date()));
  const symbol = SYMBOL_COLOR[variant](SYMBOLS[variant]);
  const scopeText = colorForScope(scope)(padScope(scope));
  const tail = extras.length > 0 ? " " + extras.map(stringifyArg).join(" ") : "";
  stream.write(`${time} ${symbol} ${scopeText} ${msg}${tail}\n`);
};

export type Logger = {
  debug: (msg: string, ...extras: unknown[]) => void;
  info: (msg: string, ...extras: unknown[]) => void;
  warn: (msg: string, ...extras: unknown[]) => void;
  error: (msg: string, ...extras: unknown[]) => void;
  success: (msg: string, ...extras: unknown[]) => void;
  ready: (msg: string, ...extras: unknown[]) => void;
  item: (msg: string, ...extras: unknown[]) => void;
  child: (subscope: string) => Logger;
};

export const createLogger = (scope: string): Logger => ({
  debug: (msg, ...extras) => write("debug", scope, msg, extras),
  info: (msg, ...extras) => write("info", scope, msg, extras),
  warn: (msg, ...extras) => write("warn", scope, msg, extras),
  error: (msg, ...extras) => write("error", scope, msg, extras),
  success: (msg, ...extras) => write("success", scope, msg, extras),
  ready: (msg, ...extras) => write("ready", scope, msg, extras),
  item: (msg, ...extras) => write("neutral", scope, msg, extras),
  child: (subscope) => createLogger(`${scope}:${subscope}`),
});

export const formatError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Highlight helpers — use sparingly inside messages
export const url = (s: string): string => c.cyan(s);
export const muted = (s: string): string => c.dim(s);
export const num = (s: string | number): string => c.bold(String(s));
