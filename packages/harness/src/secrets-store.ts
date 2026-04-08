import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ensureAgentIdentity,
  getAgentStoreDirectory,
  slugifyStorageComponent,
  STORAGE_SCHEMA_VERSION,
} from "./agent-identity.js";
import { createRawKVStore, type RawKVStore } from "./kv-store.js";
import type { StateConfig } from "./state.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SecretsStore {
  get(tenantId: string): Promise<Record<string, string>>;
  set(tenantId: string, key: string, value: string): Promise<void>;
  delete(tenantId: string, key: string): Promise<void>;
  list(tenantId: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------

type EncryptedBlob = { iv: string; ct: string; tag: string };

function deriveKey(signingKey: string): Buffer {
  // HKDF-like derivation: SHA-256 of fixed salt + signing key
  return createHash("sha256")
    .update("poncho-secrets-v1:" + signingKey)
    .digest();
}

function encrypt(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt(blob: EncryptedBlob, key: Buffer): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// File-based implementation
// ---------------------------------------------------------------------------

class FileSecretsStore implements SecretsStore {
  private readonly workingDir: string;
  private readonly encKey: Buffer;

  constructor(workingDir: string, signingKey: string) {
    this.workingDir = workingDir;
    this.encKey = deriveKey(signingKey);
  }

  private async filePath(tenantId: string): Promise<string> {
    const identity = await ensureAgentIdentity(this.workingDir);
    const dir = resolve(
      getAgentStoreDirectory(identity),
      "tenants",
      slugifyStorageComponent(tenantId),
    );
    return resolve(dir, "secrets.json");
  }

  private async readAll(tenantId: string): Promise<Record<string, EncryptedBlob>> {
    try {
      const raw = await readFile(await this.filePath(tenantId), "utf8");
      return JSON.parse(raw) as Record<string, EncryptedBlob>;
    } catch {
      return {};
    }
  }

  private async writeAll(
    tenantId: string,
    data: Record<string, EncryptedBlob>,
  ): Promise<void> {
    const fp = await this.filePath(tenantId);
    await mkdir(dirname(fp), { recursive: true });
    await writeFile(fp, JSON.stringify(data, null, 2), "utf8");
  }

  async get(tenantId: string): Promise<Record<string, string>> {
    const data = await this.readAll(tenantId);
    const result: Record<string, string> = {};
    for (const [k, blob] of Object.entries(data)) {
      try {
        result[k] = decrypt(blob, this.encKey);
      } catch {
        // Skip entries that can't be decrypted (key rotation)
      }
    }
    return result;
  }

  async set(tenantId: string, key: string, value: string): Promise<void> {
    const data = await this.readAll(tenantId);
    data[key] = encrypt(value, this.encKey);
    await this.writeAll(tenantId, data);
  }

  async delete(tenantId: string, key: string): Promise<void> {
    const data = await this.readAll(tenantId);
    delete data[key];
    await this.writeAll(tenantId, data);
  }

  async list(tenantId: string): Promise<string[]> {
    const data = await this.readAll(tenantId);
    return Object.keys(data);
  }
}

// ---------------------------------------------------------------------------
// KV-backed implementation
// ---------------------------------------------------------------------------

class KVSecretsStore implements SecretsStore {
  private readonly kv: RawKVStore;
  private readonly baseKey: string;
  private readonly encKey: Buffer;
  private readonly ttl?: number;

  constructor(kv: RawKVStore, baseKey: string, signingKey: string, ttl?: number) {
    this.kv = kv;
    this.baseKey = baseKey;
    this.encKey = deriveKey(signingKey);
    this.ttl = ttl;
  }

  private kvKey(tenantId: string): string {
    return `${this.baseKey}:t:${slugifyStorageComponent(tenantId)}:secrets`;
  }

  private async readAll(tenantId: string): Promise<Record<string, EncryptedBlob>> {
    try {
      const raw = await this.kv.get(this.kvKey(tenantId));
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, EncryptedBlob>;
    } catch {
      return {};
    }
  }

  private async writeAll(
    tenantId: string,
    data: Record<string, EncryptedBlob>,
  ): Promise<void> {
    const key = this.kvKey(tenantId);
    const value = JSON.stringify(data);
    if (this.ttl) {
      await this.kv.setWithTtl(key, value, this.ttl);
    } else {
      await this.kv.set(key, value);
    }
  }

  async get(tenantId: string): Promise<Record<string, string>> {
    const data = await this.readAll(tenantId);
    const result: Record<string, string> = {};
    for (const [k, blob] of Object.entries(data)) {
      try {
        result[k] = decrypt(blob, this.encKey);
      } catch {
        // Skip entries that can't be decrypted
      }
    }
    return result;
  }

  async set(tenantId: string, key: string, value: string): Promise<void> {
    const data = await this.readAll(tenantId);
    data[key] = encrypt(value, this.encKey);
    await this.writeAll(tenantId, data);
  }

  async delete(tenantId: string, key: string): Promise<void> {
    const data = await this.readAll(tenantId);
    delete data[key];
    await this.writeAll(tenantId, data);
  }

  async list(tenantId: string): Promise<string[]> {
    const data = await this.readAll(tenantId);
    return Object.keys(data);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createSecretsStore = (
  agentId: string,
  signingKey: string,
  config?: StateConfig,
  options?: { workingDir?: string },
): SecretsStore => {
  const provider = config?.provider ?? "local";
  const ttl = typeof config?.ttl === "number" ? config.ttl : undefined;
  const workingDir = options?.workingDir ?? process.cwd();

  if (provider === "local" || provider === "memory") {
    return new FileSecretsStore(workingDir, signingKey);
  }

  const kv = createRawKVStore(config);
  if (kv) {
    const baseKey = `poncho:${STORAGE_SCHEMA_VERSION}:${slugifyStorageComponent(agentId)}`;
    return new KVSecretsStore(kv, baseKey, signingKey, ttl);
  }
  return new FileSecretsStore(workingDir, signingKey);
};

// ---------------------------------------------------------------------------
// Env resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve an env var name: check tenant secrets first, then process.env.
 */
export async function resolveEnv(
  secretsStore: SecretsStore | undefined,
  tenantId: string | null | undefined,
  envName: string,
): Promise<string | undefined> {
  if (tenantId && secretsStore) {
    const secrets = await secretsStore.get(tenantId);
    if (secrets[envName]) return secrets[envName];
  }
  return process.env[envName];
}
