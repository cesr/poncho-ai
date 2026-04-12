import type { ToolContext, ToolDefinition, FileContentPart } from "@poncho-ai/sdk";
import type { BrowserSession } from "./session.js";

type BrowserToolInput = Record<string, unknown>;

export function createBrowserTools(
  getSession: () => BrowserSession,
): ToolDefinition[] {
  return [
    {
      name: "browser_open",
      description:
        "Open a URL in a headless browser. Returns the page title. Use this to navigate to websites and web applications. " +
        "To open files from the virtual filesystem, use /api/vfs/{path} (e.g. /api/vfs/downloads/report.pdf).",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to navigate to (must include protocol, e.g. https://)",
          },
        },
        required: ["url"],
      },
      handler: async (input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const cid = context.conversationId ?? "__default__";
        const url = String(input.url ?? "");
        if (!url) throw new Error("url is required");
        const result = await session.open(cid, url);
        session.startScreencast(cid).catch((err) => {
          console.error("[poncho][browser] startScreencast failed:", err?.message ?? err);
        });
        return { url, title: result.title ?? "(no title)" };
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Get the current page as a compact accessibility tree with element refs (@e1, @e2, ...). " +
        "Use refs to interact with elements via browser_click and browser_type. " +
        "Re-snapshot after each interaction since refs change when the page updates.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const snapshot = await session.snapshot(context.conversationId ?? "__default__");
        return { snapshot };
      },
    },
    {
      name: "browser_click",
      description:
        "Click an element identified by its ref from the last snapshot (e.g. @e2). " +
        "Always take a snapshot first to get current refs.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'Element ref from the snapshot (e.g. "@e2")',
          },
        },
        required: ["ref"],
      },
      handler: async (input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const ref = String(input.ref ?? "");
        if (!ref) throw new Error("ref is required");
        await session.click(context.conversationId ?? "__default__", ref);
        return { clicked: ref };
      },
    },
    {
      name: "browser_click_text",
      description:
        "Click the first visible element on the page that contains the given text. " +
        "Use this when an element doesn't appear in the snapshot — e.g. styled divs acting as buttons. " +
        "By default matches substring (case-insensitive); set exact=true for exact text match.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The visible text of the element to click",
          },
          exact: {
            type: "boolean",
            description:
              "If true, match the exact full text (case-sensitive). Default: false (substring, case-insensitive).",
          },
        },
        required: ["text"],
      },
      handler: async (input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const text = String(input.text ?? "");
        if (!text) throw new Error("text is required");
        const exact = input.exact === true;
        await session.clickText(context.conversationId ?? "__default__", text, exact);
        return { clicked: text, exact };
      },
    },
    {
      name: "browser_execute_js",
      description:
        "Execute JavaScript in the current page context and return the result. " +
        "Use this to inspect or interact with the DOM when snapshot refs aren't available — " +
        "e.g. finding elements by text content, getting bounding boxes, or clicking elements by selector. " +
        "The script is evaluated via page.evaluate(); return a value to get it back.",
      inputSchema: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description:
              "JavaScript code to evaluate in the page. Use a return statement or expression to get a result back.",
          },
        },
        required: ["script"],
      },
      handler: async (input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const script = String(input.script ?? "");
        if (!script) throw new Error("script is required");
        const result = await session.executeJs(context.conversationId ?? "__default__", script);
        return { result: result ?? null };
      },
    },
    {
      name: "browser_type",
      description:
        "Type text into a form field identified by its ref from the last snapshot. " +
        "This clears the field first, then types the new value.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'Element ref from the snapshot (e.g. "@e3")',
          },
          text: {
            type: "string",
            description: "Text to type into the field",
          },
        },
        required: ["ref", "text"],
      },
      handler: async (input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const ref = String(input.ref ?? "");
        const text = String(input.text ?? "");
        if (!ref) throw new Error("ref is required");
        await session.type(context.conversationId ?? "__default__", ref, text);
        return { typed: text, into: ref };
      },
    },
    {
      name: "browser_content",
      description:
        "Get the visible text content of the current page. Returns the page's text as a plain string (like what you'd " +
        "see if you selected all text). Use this to read articles, tables, data, or any text on the page. " +
        "Much faster and cheaper than screenshots for reading content.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const result = await session.content(context.conversationId ?? "__default__");
        return { url: result.url, title: result.title, text: result.text };
      },
    },
    {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the current page. Returns the image so you can see exactly what the page looks like. " +
        "Use this when you need to see visual layout, verify actions, or read content that isn't in the accessibility tree.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const base64 = await session.screenshot(context.conversationId ?? "__default__");
        const filePart: FileContentPart = {
          type: "file",
          data: base64,
          mediaType: "image/jpeg",
          filename: "screenshot.jpg",
        };
        return { screenshot: filePart };
      },
    },
    {
      name: "browser_scroll",
      description:
        "Scroll the page up or down. Use this to see content that's below or above the current viewport.",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down"],
            description: "Scroll direction",
          },
          amount: {
            type: "number",
            description: "Pixels to scroll (default: one viewport height)",
          },
        },
        required: ["direction"],
      },
      handler: async (input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const direction = String(input.direction ?? "down") as "up" | "down";
        const amount = typeof input.amount === "number" ? input.amount : undefined;
        await session.scroll(context.conversationId ?? "__default__", direction, amount);
        return { scrolled: direction, amount: amount ?? "viewport" };
      },
    },
    {
      name: "browser_clear_cookies",
      description:
        "Delete browser cookies. By default clears all cookies. " +
        "Pass a url to only delete cookies that would be sent to that URL " +
        "(e.g. \"https://example.com\" removes cookies for example.com and its subdomains). " +
        "Also removes them from persisted storage so they won't be restored on next launch.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Optional URL to scope deletion to (e.g. \"https://example.com\"). Omit to clear all cookies.",
          },
        },
      },
      handler: async (input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        const url = input.url ? String(input.url) : undefined;
        const { cleared } = await session.clearCookies(context.conversationId ?? "__default__", url);
        return { cleared, scope: url ?? "all" };
      },
    },
    {
      name: "browser_close",
      description:
        "Close the browser tab for this conversation. Call this when you're done with browser tasks to free resources.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_input: BrowserToolInput, context: ToolContext) => {
        const session = getSession();
        await session.closeTab(context.conversationId ?? "__default__");
        return { closed: true };
      },
    },
  ] as ToolDefinition[];
}
