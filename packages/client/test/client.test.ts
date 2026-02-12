import { describe, expect, it } from "vitest";
import { AgentClient } from "../src/index.js";

describe("AgentClient", () => {
  it("calls /run/sync for run()", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            runId: "run_1",
            status: "completed",
            result: {
              status: "completed",
              response: "ok",
              steps: 1,
              tokens: { input: 1, output: 1, cached: 0 },
              duration: 1,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });

    const result = await client.run({ task: "hello" });
    expect(result.runId).toBe("run_1");
    expect(result.result.response).toBe("ok");
  });

  it("supports continue()", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { runId?: string; message?: string };
        return new Response(
          JSON.stringify({
            runId: body.runId ?? "run_2",
            status: "completed",
            result: {
              status: "completed",
              response: body.message ?? "next",
              steps: 1,
              tokens: { input: 1, output: 1, cached: 0 },
              duration: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const result = await client.continue({ runId: "run_1", message: "next" });
    expect(result.runId).toBe("run_1");
    expect(result.result.response).toBe("next");
  });
});
