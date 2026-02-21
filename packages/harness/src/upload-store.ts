import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { UploadsConfig } from "./config.js";

/**
 * Try to dynamically import a module, first from the harness's own
 * node_modules, then from the user's project directory. This handles
 * the case where the CLI is globally linked and optional deps are
 * installed in the user's project but not in the poncho-ai monorepo.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tryImport = async (mod: string, workingDir?: string): Promise<any> => {
  try {
    return await import(/* webpackIgnore: true */ mod);
  } catch {
    if (workingDir) {
      const require = createRequire(resolve(workingDir, "package.json"));
      const resolved = require.resolve(mod);
      return await import(/* webpackIgnore: true */ resolved);
    }
    throw new Error(`Cannot find module "${mod}"`);
  }
};

export const PONCHO_UPLOAD_SCHEME = "poncho-upload://";

export interface UploadStore {
  put(key: string, data: Buffer, mediaType: string): Promise<string>;
  get(urlOrKey: string): Promise<Buffer>;
  delete(urlOrKey: string): Promise<void>;
}

/**
 * Write-behind cache that wraps any UploadStore. `put()` caches the
 * data in memory and returns immediately with a `poncho-upload://` ref
 * while the actual cloud upload happens in the background. `get()`
 * serves from cache when available, eliminating the round-trip back
 * to the cloud store that would otherwise block the model request.
 */
class CachedUploadStore implements UploadStore {
  private readonly inner: UploadStore;
  private readonly cache = new Map<string, { data: Buffer; ts: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(inner: UploadStore, maxEntries = 64, ttlMs = 10 * 60 * 1000) {
    this.inner = inner;
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  async put(key: string, data: Buffer, mediaType: string): Promise<string> {
    const ref = `${PONCHO_UPLOAD_SCHEME}${key}`;
    const now = Date.now();
    this.cache.set(ref, { data, ts: now });
    this.cache.set(key, { data, ts: now });
    this.evict();

    // Fire off the real upload in the background — don't block the caller.
    this.inner.put(key, data, mediaType).catch((err) => {
      console.error("[poncho] background upload failed:", err instanceof Error ? err.message : err);
    });

    return ref;
  }

  async get(urlOrKey: string): Promise<Buffer> {
    const cached = this.cache.get(urlOrKey);
    if (cached && Date.now() - cached.ts < this.ttlMs) {
      return cached.data;
    }
    return this.inner.get(urlOrKey);
  }

  async delete(urlOrKey: string): Promise<void> {
    this.cache.delete(urlOrKey);
    return this.inner.delete(urlOrKey);
  }

  private evict(): void {
    if (this.cache.size <= this.maxEntries) return;
    let oldest: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of this.cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldest = k;
      }
    }
    if (oldest) this.cache.delete(oldest);
  }
}

/** Derive a content-addressed key from file data. */
export const deriveUploadKey = (
  data: Buffer,
  mediaType: string,
): string => {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 24);
  const ext = mimeToExt(mediaType);
  return `${hash}${ext}`;
};

const MIME_EXT_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/json": ".json",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
};

const mimeToExt = (mediaType: string): string =>
  MIME_EXT_MAP[mediaType] ?? `.${mediaType.split("/").pop() ?? "bin"}`;

// ---------------------------------------------------------------------------
// Local filesystem implementation
// ---------------------------------------------------------------------------

export class LocalUploadStore implements UploadStore {
  private readonly uploadsDir: string;

  constructor(workingDir: string) {
    this.uploadsDir = resolve(workingDir, ".poncho", "uploads");
  }

  async put(_key: string, data: Buffer, mediaType: string): Promise<string> {
    const key = deriveUploadKey(data, mediaType);
    const filePath = resolve(this.uploadsDir, key);
    await mkdir(this.uploadsDir, { recursive: true });
    await writeFile(filePath, data);
    return `${PONCHO_UPLOAD_SCHEME}${key}`;
  }

  async get(urlOrKey: string): Promise<Buffer> {
    const key = urlOrKey.startsWith(PONCHO_UPLOAD_SCHEME)
      ? urlOrKey.slice(PONCHO_UPLOAD_SCHEME.length)
      : urlOrKey;
    return readFile(resolve(this.uploadsDir, key));
  }

  async delete(urlOrKey: string): Promise<void> {
    const key = urlOrKey.startsWith(PONCHO_UPLOAD_SCHEME)
      ? urlOrKey.slice(PONCHO_UPLOAD_SCHEME.length)
      : urlOrKey;
    await rm(resolve(this.uploadsDir, key), { force: true });
  }
}

// ---------------------------------------------------------------------------
// Vercel Blob implementation (optional dependency)
// ---------------------------------------------------------------------------

export class VercelBlobUploadStore implements UploadStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sdk: any;
  private readonly workingDir?: string;
  private readonly access: "public" | "private";

  constructor(workingDir?: string, access: "public" | "private" = "public") {
    this.workingDir = workingDir;
    this.access = access;
  }

  async loadSdk() {
    if (this.sdk) return this.sdk;
    try {
      this.sdk = await tryImport("@vercel/blob", this.workingDir);
      return this.sdk;
    } catch {
      throw new Error(
        'uploads: vercel-blob provider requires the "@vercel/blob" package. Install it with: pnpm add @vercel/blob',
      );
    }
  }

  async put(key: string, data: Buffer, mediaType: string): Promise<string> {
    const sdk = await this.loadSdk();
    await sdk.put(key, data, {
      access: this.access,
      contentType: mediaType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return `${PONCHO_UPLOAD_SCHEME}${key}`;
  }

  async get(urlOrKey: string): Promise<Buffer> {
    let pathname = urlOrKey;
    if (urlOrKey.startsWith(PONCHO_UPLOAD_SCHEME)) {
      pathname = urlOrKey.slice(PONCHO_UPLOAD_SCHEME.length);
    } else if (urlOrKey.startsWith("https://") || urlOrKey.startsWith("http://")) {
      pathname = new URL(urlOrKey).pathname.slice(1);
    }
    if (this.access === "private") {
      const sdk = await this.loadSdk();
      const result = await sdk.get(pathname, { access: "private" });
      if (!result || result.statusCode !== 200) {
        throw new Error(`uploads: failed to fetch private blob "${pathname}": ${result?.statusCode ?? "not found"}`);
      }
      const chunks: Uint8Array[] = [];
      const reader = result.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    }
    const sdk = await this.loadSdk();
    const blob = await sdk.head(pathname);
    const response = await fetch(blob.url);
    if (!response.ok) {
      throw new Error(`uploads: failed to fetch blob "${pathname}": ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(urlOrKey: string): Promise<void> {
    const sdk = await this.loadSdk();
    await sdk.del(urlOrKey);
  }
}

// ---------------------------------------------------------------------------
// S3-compatible implementation (optional dependency)
// ---------------------------------------------------------------------------

export class S3UploadStore implements UploadStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private s3Sdk: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private presignerSdk: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private readonly bucket: string;
  private readonly region?: string;
  private readonly endpoint?: string;
  private readonly workingDir?: string;

  constructor(bucket: string, region?: string, endpoint?: string, workingDir?: string) {
    this.bucket = bucket;
    this.region = region;
    this.endpoint = endpoint;
    this.workingDir = workingDir;
  }

  async ensureClient() {
    if (this.client) return;
    try {
      this.s3Sdk = await tryImport("@aws-sdk/client-s3", this.workingDir);
      this.presignerSdk = await tryImport("@aws-sdk/s3-request-presigner", this.workingDir);
    } catch {
      throw new Error(
        'uploads: s3 provider requires "@aws-sdk/client-s3" and "@aws-sdk/s3-request-presigner". ' +
          "Install with: pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner",
      );
    }
    this.client = new this.s3Sdk.S3Client({
      region: this.region ?? process.env.AWS_REGION ?? "us-east-1",
      ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
    });
  }

  async put(key: string, data: Buffer, mediaType: string): Promise<string> {
    await this.ensureClient();
    await this.client.send(
      new this.s3Sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: mediaType,
      }),
    );
    const url: string = await this.presignerSdk.getSignedUrl(
      this.client,
      new this.s3Sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 7 * 24 * 60 * 60 },
    );
    return url;
  }

  async get(urlOrKey: string): Promise<Buffer> {
    if (urlOrKey.startsWith("https://") || urlOrKey.startsWith("http://")) {
      const response = await fetch(urlOrKey);
      if (!response.ok) {
        throw new Error(`uploads: failed to fetch S3 object at ${urlOrKey}: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    }
    await this.ensureClient();
    const result = await this.client.send(
      new this.s3Sdk.GetObjectCommand({ Bucket: this.bucket, Key: urlOrKey }),
    );
    if (!result.Body) throw new Error(`uploads: empty body for S3 key ${urlOrKey}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(urlOrKey: string): Promise<void> {
    await this.ensureClient();
    const key = urlOrKey.startsWith("https://")
      ? new URL(urlOrKey).pathname.slice(1)
      : urlOrKey;
    await this.client.send(
      new this.s3Sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

// ---------------------------------------------------------------------------
// Factory with graceful fallback
// ---------------------------------------------------------------------------

const warn = (msg: string) => {
  console.warn(`[poncho] ⚠ ${msg}`);
};

export const createUploadStore = async (
  config: UploadsConfig | undefined,
  workingDir: string,
): Promise<UploadStore> => {
  const provider = config?.provider ?? "local";

  if (provider === "vercel-blob") {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      warn(
        "uploads: vercel-blob configured but BLOB_READ_WRITE_TOKEN not found in environment. Falling back to local filesystem.\n" +
          "         Make sure BLOB_READ_WRITE_TOKEN is set in your .env file or environment.",
      );
      return new LocalUploadStore(workingDir);
    }
    const store = new VercelBlobUploadStore(workingDir, config?.access ?? "public");
    try {
      await store.loadSdk();
      console.log("[poncho] uploads: using vercel-blob store");
      return new CachedUploadStore(store);
    } catch {
      warn(
        'uploads: vercel-blob configured but "@vercel/blob" package is not installed. Falling back to local filesystem.\n' +
          "         Run `poncho build <target>` to auto-add it, or install manually: pnpm add @vercel/blob",
      );
      return new LocalUploadStore(workingDir);
    }
  }

  if (provider === "s3") {
    const bucket = config?.bucket ?? process.env.PONCHO_UPLOADS_BUCKET;
    if (!process.env.AWS_ACCESS_KEY_ID || !bucket) {
      const missing = !process.env.AWS_ACCESS_KEY_ID
        ? "AWS_ACCESS_KEY_ID"
        : "bucket (config.uploads.bucket or PONCHO_UPLOADS_BUCKET)";
      warn(
        `uploads: s3 configured but ${missing} not found in environment. Falling back to local filesystem.`,
      );
      return new LocalUploadStore(workingDir);
    }
    const store = new S3UploadStore(
      bucket,
      config?.region ?? process.env.AWS_REGION,
      config?.endpoint ?? process.env.PONCHO_UPLOADS_ENDPOINT,
      workingDir,
    );
    try {
      await store.ensureClient();
      console.log(`[poncho] uploads: using s3 store (bucket: ${bucket})`);
      return new CachedUploadStore(store);
    } catch {
      warn(
        "uploads: s3 configured but AWS SDK packages are not installed. Falling back to local filesystem.\n" +
          "         Run `poncho build <target>` to auto-add them, or install manually: pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner",
      );
      return new LocalUploadStore(workingDir);
    }
  }

  return new LocalUploadStore(workingDir);
};
