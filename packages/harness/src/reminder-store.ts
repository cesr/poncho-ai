import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { StateConfig } from "./state.js";
import {
  ensureAgentIdentity,
  getAgentStoreDirectory,
  slugifyStorageComponent,
  STORAGE_SCHEMA_VERSION,
} from "./agent-identity.js";
import { createRawKVStore, type RawKVStore } from "./kv-store.js";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type ReminderStatus = "pending" | "fired" | "cancelled";

export interface Reminder {
  id: string;
  task: string;
  scheduledAt: number;
  timezone?: string;
  status: ReminderStatus;
  createdAt: number;
  conversationId: string;
  ownerId?: string;
}

export interface ReminderStore {
  list(): Promise<Reminder[]>;
  create(input: {
    task: string;
    scheduledAt: number;
    timezone?: string;
    conversationId: string;
    ownerId?: string;
  }): Promise<Reminder>;
  cancel(id: string): Promise<Reminder>;
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REMINDERS_FILE = "reminders.json";
const STALE_CANCELLED_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const writeJsonAtomic = async (filePath: string, payload: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpPath, filePath);
};

const isValidReminder = (item: unknown): item is Reminder =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as Record<string, unknown>).id === "string" &&
  typeof (item as Record<string, unknown>).task === "string" &&
  typeof (item as Record<string, unknown>).scheduledAt === "number" &&
  typeof (item as Record<string, unknown>).status === "string";

const parseReminderList = (raw: unknown): Reminder[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidReminder);
};

/** Remove cancelled reminders older than 7 days. Fired reminders are deleted immediately on fire. */
const pruneStale = (reminders: Reminder[]): Reminder[] => {
  const cutoff = Date.now() - STALE_CANCELLED_MS;
  return reminders.filter(
    (r) => r.status === "pending" || r.createdAt > cutoff,
  );
};

const generateId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 8);

// ---------------------------------------------------------------------------
// InMemoryReminderStore
// ---------------------------------------------------------------------------

class InMemoryReminderStore implements ReminderStore {
  private reminders: Reminder[] = [];

  async list(): Promise<Reminder[]> {
    return [...this.reminders];
  }

  async create(input: {
    task: string;
    scheduledAt: number;
    timezone?: string;
    conversationId: string;
    ownerId?: string;
  }): Promise<Reminder> {
    const reminder: Reminder = {
      id: generateId(),
      task: input.task,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone,
      status: "pending",
      createdAt: Date.now(),
      conversationId: input.conversationId,
      ownerId: input.ownerId,
    };
    this.reminders = pruneStale(this.reminders);
    this.reminders.push(reminder);
    return reminder;
  }

  async cancel(id: string): Promise<Reminder> {
    const reminder = this.reminders.find((r) => r.id === id);
    if (!reminder) throw new Error(`Reminder "${id}" not found`);
    if (reminder.status !== "pending") {
      throw new Error(`Reminder "${id}" is already ${reminder.status}`);
    }
    reminder.status = "cancelled";
    return reminder;
  }

  async delete(id: string): Promise<void> {
    this.reminders = this.reminders.filter((r) => r.id !== id);
  }
}

// ---------------------------------------------------------------------------
// FileReminderStore — single JSON file for all reminders
// ---------------------------------------------------------------------------

class FileReminderStore implements ReminderStore {
  private readonly workingDir: string;
  private filePath = "";

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  private async ensureFilePath(): Promise<string> {
    if (this.filePath) return this.filePath;
    const identity = await ensureAgentIdentity(this.workingDir);
    this.filePath = resolve(getAgentStoreDirectory(identity), REMINDERS_FILE);
    return this.filePath;
  }

  private async readAll(): Promise<Reminder[]> {
    try {
      const fp = await this.ensureFilePath();
      const raw = await readFile(fp, "utf8");
      return parseReminderList(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  private async writeAll(reminders: Reminder[]): Promise<void> {
    const fp = await this.ensureFilePath();
    await writeJsonAtomic(fp, reminders);
  }

  async list(): Promise<Reminder[]> {
    return this.readAll();
  }

  async create(input: {
    task: string;
    scheduledAt: number;
    timezone?: string;
    conversationId: string;
    ownerId?: string;
  }): Promise<Reminder> {
    const reminder: Reminder = {
      id: generateId(),
      task: input.task,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone,
      status: "pending",
      createdAt: Date.now(),
      conversationId: input.conversationId,
      ownerId: input.ownerId,
    };
    let reminders = await this.readAll();
    reminders = pruneStale(reminders);
    reminders.push(reminder);
    await this.writeAll(reminders);
    return reminder;
  }

  async cancel(id: string): Promise<Reminder> {
    const reminders = await this.readAll();
    const reminder = reminders.find((r) => r.id === id);
    if (!reminder) throw new Error(`Reminder "${id}" not found`);
    if (reminder.status !== "pending") {
      throw new Error(`Reminder "${id}" is already ${reminder.status}`);
    }
    reminder.status = "cancelled";
    await this.writeAll(reminders);
    return reminder;
  }

  async delete(id: string): Promise<void> {
    const reminders = await this.readAll();
    await this.writeAll(reminders.filter((r) => r.id !== id));
  }
}

// ---------------------------------------------------------------------------
// KVBackedReminderStore — wraps any RawKVStore (Upstash, Redis, DynamoDB)
// ---------------------------------------------------------------------------

class KVBackedReminderStore implements ReminderStore {
  private readonly kv: RawKVStore;
  private readonly key: string;
  private readonly ttl?: number;
  private readonly memoryFallback = new InMemoryReminderStore();

  constructor(kv: RawKVStore, key: string, ttl?: number) {
    this.kv = kv;
    this.key = key;
    this.ttl = ttl;
  }

  private async readAll(): Promise<Reminder[]> {
    try {
      const raw = await this.kv.get(this.key);
      if (!raw) return [];
      return parseReminderList(JSON.parse(raw));
    } catch {
      return this.memoryFallback.list();
    }
  }

  private async writeAll(reminders: Reminder[]): Promise<void> {
    try {
      const serialized = JSON.stringify(reminders);
      if (typeof this.ttl === "number") {
        await this.kv.setWithTtl(this.key, serialized, Math.max(1, this.ttl));
      } else {
        await this.kv.set(this.key, serialized);
      }
    } catch {
      // KV write failed; operations already applied in-memory via caller
    }
  }

  async list(): Promise<Reminder[]> {
    return this.readAll();
  }

  async create(input: {
    task: string;
    scheduledAt: number;
    timezone?: string;
    conversationId: string;
    ownerId?: string;
  }): Promise<Reminder> {
    let reminders: Reminder[];
    try {
      reminders = await this.readAll();
    } catch {
      return this.memoryFallback.create(input);
    }
    const reminder: Reminder = {
      id: generateId(),
      task: input.task,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone,
      status: "pending",
      createdAt: Date.now(),
      conversationId: input.conversationId,
      ownerId: input.ownerId,
    };
    reminders = pruneStale(reminders);
    reminders.push(reminder);
    await this.writeAll(reminders);
    return reminder;
  }

  async cancel(id: string): Promise<Reminder> {
    let reminders: Reminder[];
    try {
      reminders = await this.readAll();
    } catch {
      return this.memoryFallback.cancel(id);
    }
    const reminder = reminders.find((r) => r.id === id);
    if (!reminder) throw new Error(`Reminder "${id}" not found`);
    if (reminder.status !== "pending") {
      throw new Error(`Reminder "${id}" is already ${reminder.status}`);
    }
    reminder.status = "cancelled";
    await this.writeAll(reminders);
    return reminder;
  }

  async delete(id: string): Promise<void> {
    let reminders: Reminder[];
    try {
      reminders = await this.readAll();
    } catch {
      return this.memoryFallback.delete(id);
    }
    await this.writeAll(reminders.filter((r) => r.id !== id));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createReminderStore = (
  agentId: string,
  config?: StateConfig,
  options?: { workingDir?: string },
): ReminderStore => {
  const provider = config?.provider ?? "local";
  const ttl = config?.ttl;
  const workingDir = options?.workingDir ?? process.cwd();

  if (provider === "local") {
    return new FileReminderStore(workingDir);
  }
  if (provider === "memory") {
    return new InMemoryReminderStore();
  }

  const kv = createRawKVStore(config);
  if (kv) {
    const key = `poncho:${STORAGE_SCHEMA_VERSION}:${slugifyStorageComponent(agentId)}:reminders`;
    return new KVBackedReminderStore(kv, key, ttl);
  }
  return new InMemoryReminderStore();
};
