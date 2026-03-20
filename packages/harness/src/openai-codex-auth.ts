import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, chmod, writeFile, rm } from "node:fs/promises";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
const REFRESH_TOKEN_GRACE_MS = 5 * 60 * 1000;
const DEVICE_POLLING_SAFETY_MARGIN_MS = 3000;
const DEVICE_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const REQUIRED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.responses.write",
  "model.request",
  "api.model.read",
];

export interface OpenAICodexAuthConfig {
  refreshTokenEnv?: string;
  accessTokenEnv?: string;
  accessTokenExpiresAtEnv?: string;
  accountIdEnv?: string;
  authFilePathEnv?: string;
}

export interface OpenAICodexSession {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  accountId?: string;
}

interface OpenAICodexStoredSession extends OpenAICodexSession {
  updatedAt: string;
}

type SessionSource = "env" | "file";

const defaultedConfig = (
  config?: OpenAICodexAuthConfig,
): Required<OpenAICodexAuthConfig> => ({
  refreshTokenEnv: config?.refreshTokenEnv ?? "OPENAI_CODEX_REFRESH_TOKEN",
  accessTokenEnv: config?.accessTokenEnv ?? "OPENAI_CODEX_ACCESS_TOKEN",
  accessTokenExpiresAtEnv:
    config?.accessTokenExpiresAtEnv ?? "OPENAI_CODEX_ACCESS_TOKEN_EXPIRES_AT",
  accountIdEnv: config?.accountIdEnv ?? "OPENAI_CODEX_ACCOUNT_ID",
  authFilePathEnv: config?.authFilePathEnv ?? "OPENAI_CODEX_AUTH_FILE",
});

const parseEpochMillis = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
};

export const getOpenAICodexAuthFilePath = (config?: OpenAICodexAuthConfig): string => {
  const env = defaultedConfig(config);
  const fromEnv = process.env[env.authFilePathEnv];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  return resolve(homedir(), ".poncho", "auth", "openai-codex.json");
};

export const readOpenAICodexSession = async (
  config?: OpenAICodexAuthConfig,
): Promise<OpenAICodexSession | undefined> => {
  const filePath = getOpenAICodexAuthFilePath(config);
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as Partial<OpenAICodexStoredSession>;
    if (typeof parsed.refreshToken !== "string" || parsed.refreshToken.length === 0) {
      return undefined;
    }
    return {
      refreshToken: parsed.refreshToken,
      accessToken:
        typeof parsed.accessToken === "string" && parsed.accessToken.length > 0
          ? parsed.accessToken
          : undefined,
      accessTokenExpiresAt:
        typeof parsed.accessTokenExpiresAt === "number" && parsed.accessTokenExpiresAt > 0
          ? parsed.accessTokenExpiresAt
          : undefined,
      accountId:
        typeof parsed.accountId === "string" && parsed.accountId.length > 0
          ? parsed.accountId
          : undefined,
    };
  } catch {
    return undefined;
  }
};

export const writeOpenAICodexSession = async (
  session: OpenAICodexSession,
  config?: OpenAICodexAuthConfig,
): Promise<void> => {
  const filePath = getOpenAICodexAuthFilePath(config);
  await mkdir(dirname(filePath), { recursive: true });
  const payload: OpenAICodexStoredSession = {
    ...session,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await chmod(filePath, 0o600);
};

export const deleteOpenAICodexSession = async (
  config?: OpenAICodexAuthConfig,
): Promise<void> => {
  const filePath = getOpenAICodexAuthFilePath(config);
  await rm(filePath, { force: true });
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

interface DeviceStartResponse {
  device_auth_id: string;
  user_code: string;
  interval?: string | number;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_verifier: string;
}

const parseAccountIdFromJwt = (token: string | undefined): string | undefined => {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      chatgpt_account_id?: string;
      "https://api.openai.com/auth"?: {
        chatgpt_account_id?: string;
      };
      organizations?: Array<{ id?: string }>;
    };
    return (
      claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id
    );
  } catch {
    return undefined;
  }
};

const exchangeRefreshToken = async (refreshToken: string): Promise<TokenResponse> => {
  const response = await fetch(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI Codex token refresh failed (${response.status}). Re-run \`poncho auth login --provider openai-codex --device\`, export the new token, and update deployment secrets. Details: ${body.slice(0, 240)}`,
    );
  }

  return (await response.json()) as TokenResponse;
};

const exchangeAuthorizationCode = async (
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> => {
  const response = await fetch(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${OPENAI_AUTH_ISSUER}/deviceauth/callback`,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI Codex device token exchange failed (${response.status}): ${body.slice(0, 240)}`,
    );
  }
  return (await response.json()) as TokenResponse;
};

const readSessionFromEnv = (config?: OpenAICodexAuthConfig): OpenAICodexSession | undefined => {
  const env = defaultedConfig(config);
  const refreshToken = process.env[env.refreshTokenEnv];
  if (!refreshToken || refreshToken.trim().length === 0) return undefined;
  return {
    refreshToken: refreshToken.trim(),
    accessToken: process.env[env.accessTokenEnv]?.trim() || undefined,
    accessTokenExpiresAt: parseEpochMillis(process.env[env.accessTokenExpiresAtEnv]),
    accountId: process.env[env.accountIdEnv]?.trim() || undefined,
  };
};

const shouldRefresh = (expiresAt: number | undefined): boolean =>
  !expiresAt || Date.now() + REFRESH_TOKEN_GRACE_MS >= expiresAt;

let runtimeCachedSession: OpenAICodexSession | undefined;

const readSession = async (
  config?: OpenAICodexAuthConfig,
): Promise<{ session: OpenAICodexSession; source: SessionSource }> => {
  const envSession = readSessionFromEnv(config);
  if (envSession) return { session: envSession, source: "env" };

  if (runtimeCachedSession) {
    return { session: runtimeCachedSession, source: "file" };
  }

  const fileSession = await readOpenAICodexSession(config);
  if (!fileSession) {
    throw new Error(
      "OpenAI Codex credentials not found. Run `poncho auth login --provider openai-codex --device` locally, or set OPENAI_CODEX_REFRESH_TOKEN in your environment.",
    );
  }
  runtimeCachedSession = fileSession;
  return { session: fileSession, source: "file" };
};

export const getOpenAICodexAccessToken = async (
  config?: OpenAICodexAuthConfig,
): Promise<{ accessToken: string; accountId?: string }> => {
  const { session, source } = await readSession(config);
  if (session.accessToken && !shouldRefresh(session.accessTokenExpiresAt)) {
    return { accessToken: session.accessToken, accountId: session.accountId };
  }

  const refreshed = await exchangeRefreshToken(session.refreshToken);
  const nextSession: OpenAICodexSession = {
    refreshToken: refreshed.refresh_token ?? session.refreshToken,
    accessToken: refreshed.access_token,
    accessTokenExpiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    accountId:
      session.accountId ??
      parseAccountIdFromJwt(refreshed.id_token) ??
      parseAccountIdFromJwt(refreshed.access_token),
  };

  runtimeCachedSession = nextSession;
  if (source === "file") {
    await writeOpenAICodexSession(nextSession, config);
  }

  return {
    accessToken: nextSession.accessToken!,
    accountId: nextSession.accountId,
  };
};

export interface OpenAICodexDeviceAuthRequest {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
}

export const getOpenAICodexRequiredScopes = (): string[] => [...REQUIRED_SCOPES];

export const startOpenAICodexDeviceAuth = async (): Promise<OpenAICodexDeviceAuthRequest> => {
  const response = await fetch(`${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "poncho/1.0",
    },
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
      scope: REQUIRED_SCOPES.join(" "),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI Codex device authorization start failed (${response.status}): ${body.slice(0, 240)}`,
    );
  }
  const data = (await response.json()) as DeviceStartResponse;
  const intervalRaw =
    typeof data.interval === "number"
      ? data.interval
      : Number.parseInt(String(data.interval ?? "5"), 10);
  const intervalMs = Math.max(Number.isNaN(intervalRaw) ? 5 : intervalRaw, 1) * 1000;
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: `${OPENAI_AUTH_ISSUER}/codex/device`,
    intervalMs,
  };
};

export const completeOpenAICodexDeviceAuth = async (
  request: OpenAICodexDeviceAuthRequest,
): Promise<OpenAICodexSession> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEVICE_FLOW_TIMEOUT_MS) {
    const response = await fetch(`${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "poncho/1.0",
      },
      body: JSON.stringify({
        device_auth_id: request.deviceAuthId,
        user_code: request.userCode,
      }),
    });
    if (response.ok) {
      const data = (await response.json()) as DeviceTokenResponse;
      const tokens = await exchangeAuthorizationCode(
        data.authorization_code,
        data.code_verifier,
      );
      if (!tokens.refresh_token || tokens.refresh_token.length === 0) {
        throw new Error("OpenAI Codex device auth succeeded but no refresh token was returned.");
      }
      return {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId:
          parseAccountIdFromJwt(tokens.id_token) ??
          parseAccountIdFromJwt(tokens.access_token),
      };
    }

    if (response.status !== 403 && response.status !== 404) {
      const body = await response.text();
      throw new Error(
        `OpenAI Codex device authorization polling failed (${response.status}): ${body.slice(0, 240)}`,
      );
    }

    await new Promise((resolveWait) => {
      setTimeout(resolveWait, request.intervalMs + DEVICE_POLLING_SAFETY_MARGIN_MS);
    });
  }

  throw new Error(
    "OpenAI Codex device authorization timed out. Re-run `poncho auth login --provider openai-codex --device`.",
  );
};
