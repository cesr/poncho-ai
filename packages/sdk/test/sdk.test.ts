import { describe, expect, it } from "vitest";
import { defineTool } from "../src/index.js";

describe("defineTool", () => {
  it("returns the same tool definition", () => {
    const tool = defineTool({
      name: "echo",
      description: "Echoes text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: async (input) => ({ text: input.text }),
    });

    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echoes text");
  });
});
