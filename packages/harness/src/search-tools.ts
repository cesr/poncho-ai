import { load as cheerioLoad, type CheerioAPI } from "cheerio";
import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";

const SEARCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

const SEARCH_MAX_RETRIES = 4;
const SEARCH_INITIAL_DELAY_MS = 2_000;
const SEARCH_MIN_INTERVAL_MS = 4_000;
const SEARCH_FALLBACK_COOLDOWN_MS = 12_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// web_search — Brave Search HTML scraping (no API key)
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

let searchQueue: Promise<void> = Promise.resolve();
let nextSearchAllowedAt = 0;

function parseRetryAfterMs(retryAfterHeader: string | null): number {
  if (!retryAfterHeader) return SEARCH_FALLBACK_COOLDOWN_MS;
  const asSeconds = Number(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.max(Math.floor(asSeconds * 1000), SEARCH_MIN_INTERVAL_MS);
  }
  const asDate = new Date(retryAfterHeader).getTime();
  if (Number.isFinite(asDate)) {
    return Math.max(asDate - Date.now(), SEARCH_MIN_INTERVAL_MS);
  }
  return SEARCH_FALLBACK_COOLDOWN_MS;
}

function applyRateLimitCooldown(retryAfterHeader: string | null): void {
  const cooldownMs = parseRetryAfterMs(retryAfterHeader);
  nextSearchAllowedAt = Math.max(nextSearchAllowedAt, Date.now() + cooldownMs);
}

async function runWithSearchThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const previous = searchQueue;
  let release: (() => void) | undefined;
  searchQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    const waitMs = nextSearchAllowedAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    const result = await fn();
    nextSearchAllowedAt = Math.max(nextSearchAllowedAt, Date.now() + SEARCH_MIN_INTERVAL_MS);
    return result;
  } finally {
    release?.();
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status >= 500;
}

async function braveSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < SEARCH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = SEARCH_INITIAL_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      await sleep(delay);
    }

    try {
      const html = await runWithSearchThrottle(async () => {
        const res = await fetch(url, {
          headers: {
            "User-Agent": SEARCH_UA,
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!res.ok) {
          if (res.status === 429) {
            applyRateLimitCooldown(res.headers.get("retry-after"));
          }
          const error = new Error(`Search request failed (${res.status} ${res.statusText})`);
          if (isRetryableStatus(res.status)) {
            throw error;
          }
          // Non-retryable status: surface immediately.
          (error as Error & { retryable?: boolean }).retryable = false;
          throw error;
        }

        return await res.text();
      });

      return parseBraveResults(html, maxResults);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if ((lastError as Error & { retryable?: boolean }).retryable === false) {
        throw lastError;
      }
      if (attempt < SEARCH_MAX_RETRIES - 1) continue;
    }
  }

  throw lastError ?? new Error("Search failed after retries");
}

function parseBraveResults(html: string, max: number): SearchResult[] {
  const $ = cheerioLoad(html);
  const results: SearchResult[] = [];

  $('div.snippet[data-type="web"]').each((_i, el) => {
    if (results.length >= max) return false;

    const $el = $(el);
    const anchor = $el.find(".result-content a").first();
    const href = anchor.attr("href") ?? "";
    if (!href.startsWith("http")) return;

    const title = $el.find(".title").first().text().trim();
    const snippet = $el.find(".generic-snippet .content").first().text().trim();

    if (title) {
      results.push({ title, url: href, snippet });
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// web_fetch — fetch a URL and extract readable text via cheerio
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 16_000;

function extractReadableText($: CheerioAPI, maxLength: number): { title: string; content: string } {
  const title = $("title").first().text().trim();

  $("script, style, noscript, nav, footer, header, aside, [role='navigation'], [role='banner'], [role='contentinfo']").remove();
  $("svg, iframe, form, button, input, select, textarea").remove();

  let root = $("article").first();
  if (!root.length) root = $("main").first();
  if (!root.length) root = $("[role='main']").first();
  if (!root.length) root = $("body").first();

  const text = root
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const content =
    text.length > maxLength ? text.slice(0, maxLength) + "\n…(truncated)" : text;

  return { title, content };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const createSearchTools = (): ToolDefinition[] => [
  defineTool({
    name: "web_search",
    description:
      "Search the web and return a list of results (title, URL, snippet). " +
      "Use this instead of opening a browser when you need to find information online.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (1-10, default 5)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return { error: "A non-empty query string is required." };
      }
      const max = Math.min(Math.max(Number(input.max_results) || 5, 1), 10);
      try {
        const results = await braveSearch(query, max);
        if (results.length === 0) {
          return { query, results: [], note: "No results found. Try rephrasing your query." };
        }
        return { query, results };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          error: `Search failed: ${msg}`,
          hint: "The search provider may be rate-limiting requests. Try again shortly, or use browser tools as a fallback.",
        };
      }
    },
  }),

  defineTool({
    name: "web_fetch",
    description:
      "Fetch a web page and return its text content (HTML tags stripped). " +
      "Useful for reading articles, documentation, or any web page without opening a browser.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        max_length: {
          type: "number",
          description: `Maximum character length of returned content (default ${DEFAULT_MAX_LENGTH})`,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const url = typeof input.url === "string" ? input.url.trim() : "";
      if (!url) {
        return { error: 'A "url" string is required.' };
      }
      const maxLength = Math.max(Number(input.max_length) || DEFAULT_MAX_LENGTH, 1_000);

      try {
        const res = await fetch(url, {
          headers: { "User-Agent": SEARCH_UA, Accept: "text/html,application/xhtml+xml" },
          redirect: "follow",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { url, status: res.status, error: res.statusText };
        }
        const html = await res.text();
        const $ = cheerioLoad(html);
        const { title, content } = extractReadableText($, maxLength);
        return { url, status: res.status, title, content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { url, error: `Fetch failed: ${msg}` };
      }
    },
  }),
];
