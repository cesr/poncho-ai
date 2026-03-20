import {
  completeOpenAICodexDeviceAuth,
  deleteOpenAICodexSession,
  getOpenAICodexAccessToken,
  getOpenAICodexAuthFilePath,
  getOpenAICodexRequiredScopes,
  readOpenAICodexSession,
  startOpenAICodexDeviceAuth,
  writeOpenAICodexSession,
} from "@poncho-ai/harness";

type ExportFormat = "env" | "json";

const getSource = async (): Promise<"env" | "file" | "none"> => {
  if (process.env.OPENAI_CODEX_REFRESH_TOKEN) {
    return "env";
  }
  const fileSession = await readOpenAICodexSession();
  return fileSession ? "file" : "none";
};

export const loginOpenAICodex = async (options: { device?: boolean } = {}): Promise<void> => {
  if (options.device === false) {
    throw new Error("Only device auth flow is currently supported for openai-codex.");
  }
  const started = await startOpenAICodexDeviceAuth();
  process.stdout.write(
    `Open this URL in your browser: ${started.verificationUrl}\nEnter this code: ${started.userCode}\nWaiting for authorization...\n`,
  );
  const session = await completeOpenAICodexDeviceAuth(started);
  await writeOpenAICodexSession(session);
  process.stdout.write("OpenAI Codex login successful. Credentials saved to local auth store.\n");
};

export const statusOpenAICodex = async (): Promise<void> => {
  const source = await getSource();
  if (source === "none") {
    process.stdout.write(
      "No OpenAI Codex credentials found. Run `poncho auth login --provider openai-codex --device`.\n",
    );
    return;
  }
  process.stdout.write(`Credential source: ${source}\n`);
  if (source === "file") {
    process.stdout.write(`Auth file: ${getOpenAICodexAuthFilePath()}\n`);
  }
  process.stdout.write(`Required scopes: ${getOpenAICodexRequiredScopes().join(", ")}\n`);
  try {
    const token = await getOpenAICodexAccessToken();
    process.stdout.write("Token status: valid\n");
    if (token.accountId) {
      process.stdout.write(`Account ID: ${token.accountId}\n`);
    }
  } catch (error) {
    process.stdout.write(
      `Token status: invalid (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exitCode = 1;
  }
};

export const logoutOpenAICodex = async (): Promise<void> => {
  await deleteOpenAICodexSession();
  process.stdout.write("Removed local OpenAI Codex credentials.\n");
};

const readExportableSession = async (): Promise<{
  refreshToken: string;
  accountId?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}> => {
  if (process.env.OPENAI_CODEX_REFRESH_TOKEN) {
    return {
      refreshToken: process.env.OPENAI_CODEX_REFRESH_TOKEN,
      accountId: process.env.OPENAI_CODEX_ACCOUNT_ID,
      accessToken: process.env.OPENAI_CODEX_ACCESS_TOKEN,
      accessTokenExpiresAt: process.env.OPENAI_CODEX_ACCESS_TOKEN_EXPIRES_AT
        ? Number.parseInt(process.env.OPENAI_CODEX_ACCESS_TOKEN_EXPIRES_AT, 10)
        : undefined,
    };
  }

  const session = await readOpenAICodexSession();
  if (!session) {
    throw new Error(
      "No OpenAI Codex credentials available to export. Run `poncho auth login --provider openai-codex --device` first.",
    );
  }
  return session;
};

export const exportOpenAICodex = async (format: ExportFormat): Promise<void> => {
  const session = await readExportableSession();
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          provider: "openai-codex",
          refreshToken: session.refreshToken,
          accountId: session.accountId ?? null,
          accessToken: session.accessToken ?? null,
          accessTokenExpiresAt: session.accessTokenExpiresAt ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = [
    `OPENAI_CODEX_REFRESH_TOKEN=${session.refreshToken}`,
    `OPENAI_CODEX_ACCOUNT_ID=${session.accountId ?? ""}`,
  ];
  if (session.accessToken) {
    lines.push(`OPENAI_CODEX_ACCESS_TOKEN=${session.accessToken}`);
  }
  if (session.accessTokenExpiresAt) {
    lines.push(`OPENAI_CODEX_ACCESS_TOKEN_EXPIRES_AT=${session.accessTokenExpiresAt}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
};
