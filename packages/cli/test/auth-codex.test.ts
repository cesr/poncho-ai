import { describe, expect, it, vi, afterEach } from "vitest";
import { exportOpenAICodex, statusOpenAICodex } from "../src/auth-codex.js";

describe("openai-codex auth CLI helpers", () => {
  afterEach(() => {
    delete process.env.OPENAI_CODEX_REFRESH_TOKEN;
    delete process.env.OPENAI_CODEX_ACCOUNT_ID;
    delete process.env.OPENAI_CODEX_ACCESS_TOKEN;
    delete process.env.OPENAI_CODEX_ACCESS_TOKEN_EXPIRES_AT;
    vi.restoreAllMocks();
  });

  it("exports env format from environment variables", async () => {
    process.env.OPENAI_CODEX_REFRESH_TOKEN = "rt_test";
    process.env.OPENAI_CODEX_ACCOUNT_ID = "acct_test";

    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await exportOpenAICodex("env");
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("OPENAI_CODEX_REFRESH_TOKEN=rt_test");
    expect(output).toContain("OPENAI_CODEX_ACCOUNT_ID=acct_test");
  });

  it("prints helpful status when credentials are missing", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await statusOpenAICodex();
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("No OpenAI Codex credentials found");
  });
});
