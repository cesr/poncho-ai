import { jwtVerify, type JWTPayload } from "jose";

export interface TenantTokenPayload {
  tenantId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Verify a tenant JWT (HS256) signed with the given key.
 * Returns the decoded payload on success, or undefined on any failure.
 */
export async function verifyTenantToken(
  signingKey: string,
  token: string,
): Promise<TenantTokenPayload | undefined> {
  try {
    const secret = new TextEncoder().encode(signingKey);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    const tenantId = payload.sub;
    if (!tenantId || typeof tenantId !== "string") {
      return undefined;
    }

    const metadata = extractMetadata(payload);
    return { tenantId, metadata };
  } catch {
    return undefined;
  }
}

function extractMetadata(
  payload: JWTPayload,
): Record<string, unknown> | undefined {
  const meta = payload.meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return undefined;
}
