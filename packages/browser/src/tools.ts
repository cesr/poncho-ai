import type { ToolDefinition, FileContentPart } from "@poncho-ai/sdk";
import type { BrowserSession } from "./session.js";

type BrowserToolInput = Record<string, unknown>;

export function createBrowserTools(
  getSession: () => BrowserSession,
  getConversationId: () => string,
): ToolDefinition[] {
  return [
    {
      name: "browser_open",
      description:
        "Open a URL in a headless browser. Returns the page title. Use this to navigate to websites and web applications.",
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
      handler: async (input: BrowserToolInput) => {
        const session = getSession();
        const cid = getConversationId();
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
      handler: async () => {
        const session = getSession();
        const snapshot = await session.snapshot(getConversationId());
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
      handler: async (input: BrowserToolInput) => {
        const session = getSession();
        const ref = String(input.ref ?? "");
        if (!ref) throw new Error("ref is required");
        await session.click(getConversationId(), ref);
        return { clicked: ref };
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
      handler: async (input: BrowserToolInput) => {
        const session = getSession();
        const ref = String(input.ref ?? "");
        const text = String(input.text ?? "");
        if (!ref) throw new Error("ref is required");
        await session.type(getConversationId(), ref, text);
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
      handler: async () => {
        const session = getSession();
        const result = await session.content(getConversationId());
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
      handler: async () => {
        const session = getSession();
        const base64 = await session.screenshot(getConversationId());
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
      handler: async (input: BrowserToolInput) => {
        const session = getSession();
        const direction = String(input.direction ?? "down") as "up" | "down";
        const amount = typeof input.amount === "number" ? input.amount : undefined;
        await session.scroll(getConversationId(), direction, amount);
        return { scrolled: direction, amount: amount ?? "viewport" };
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
      handler: async () => {
        const session = getSession();
        await session.closeTab(getConversationId());
        return { closed: true };
      },
    },
  ] as ToolDefinition[];
}
