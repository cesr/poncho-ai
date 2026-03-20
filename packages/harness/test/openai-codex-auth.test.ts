import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteOpenAICodexSession,
  getOpenAICodexAccessToken,
  readOpenAICodexSession,
  writeOpenAICodexSession,
} from "../src/openai-codex-auth.js";

const encodeJwt = (payload: Record<string, unknown>): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
};

describe("openai codex auth", () => {
  afterEach(() => {
    delete process.env.OPENAI_CODEX_AUTH_FILE;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes, reads, and deletes local session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-codex-auth-"));
    process.env.OPENAI_CODEX_AUTH_FILE = join(dir, "openai-codex.json");
    await writeOpenAICodexSession({
      refreshToken: "rt_123",
      accessToken: "at_123",
      accessTokenExpiresAt: Date.now() + 60_000,
      accountId: "acct_abc",
    });

    const stored = await readOpenAICodexSession();
    expect(stored?.refreshToken).toBe("rt_123");
    expect(stored?.accessToken).toBe("at_123");
    expect(stored?.accountId).toBe("acct_abc");

    await deleteOpenAICodexSession();
    const afterDelete = await readOpenAICodexSession();
    expect(afterDelete).toBeUndefined();
  });

  it("refreshes token from stored session and persists rotated values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-codex-refresh-"));
    process.env.OPENAI_CODEX_AUTH_FILE = join(dir, "openai-codex.json");
    await writeOpenAICodexSession({
      refreshToken: "rt_old",
      accessToken: "at_expired",
      accessTokenExpiresAt: Date.now() - 1000,
    });

    const idToken = encodeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_rotated" },
    });
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          access_token: "at_new",
          refresh_token: "rt_new",
          expires_in: 3600,
          id_token: idToken,
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const access = await getOpenAICodexAccessToken();
    expect(access.accessToken).toBe("at_new");
    expect(access.accountId).toBe("acct_rotated");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = await readOpenAICodexSession();
    expect(stored?.refreshToken).toBe("rt_new");
    expect(stored?.accessToken).toBe("at_new");
    expect(stored?.accountId).toBe("acct_rotated");
  });
});
