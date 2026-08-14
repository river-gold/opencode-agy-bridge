import { readFile, writeFile, rename, mkdir, open, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface StoreEntry {
  conversationId: string | null;
  processedMessages: number;
  prevOutput: string;
}

interface StoreFile {
  sessions: Record<string, StoreEntry>;
}

interface LockPayload {
  token: string;
  pid: number;
}

export interface AcquireLockOptions {
  staleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  isAlive?: (pid: number) => boolean;
}

export type LockRelease = (() => Promise<void>) & {
  stopHeartbeat: () => void;
};

const DEFAULT_STALE_TIMEOUT_MS = 30_000;

function defaultStateFile(): string {
  return join(homedir(), ".opencode-agy-plugin", "sessions.json");
}

function defaultBindingLockPath(): string {
  return join(homedir(), ".opencode-agy-plugin", "binding.lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errCode(error) === "EPERM";
  }
}

function parseLock(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as LockPayload).token === "string" &&
      typeof (parsed as LockPayload).pid === "number"
    ) {
      return parsed as LockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function heartbeatInterval(options: AcquireLockOptions, staleTimeoutMs: number): number {
  if (options.heartbeatIntervalMs !== undefined) {
    return options.heartbeatIntervalMs;
  }
  return Math.max(1, Math.floor((staleTimeoutMs || DEFAULT_STALE_TIMEOUT_MS) / 3));
}

async function createLockFile(lockPath: string, token: string): Promise<FileHandle | "exists"> {
  let fh: FileHandle;
  try {
    fh = await open(lockPath, "wx+");
  } catch (error) {
    if (errCode(error) === "EEXIST") {
      return "exists";
    }
    throw error;
  }
  try {
    await fh.writeFile(JSON.stringify({ token, pid: process.pid }));
    return fh;
  } catch (error) {
    await unlink(lockPath).catch(() => {});
    await fh.close().catch(() => {});
    throw error;
  }
}

async function readHandle(fh: FileHandle): Promise<string> {
  const info = await fh.stat();
  const buf = Buffer.alloc(info.size);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  return buf.subarray(0, bytesRead).toString("utf-8");
}

async function maybeStealStaleLock(
  lockPath: string,
  staleTimeoutMs: number,
  isAlive: (pid: number) => boolean,
): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf-8");
    const parsed = parseLock(raw);
    if (parsed) {
      if (isAlive(parsed.pid)) {
        return;
      }
      await unlink(lockPath);
      return;
    }
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs >= staleTimeoutMs) {
      await unlink(lockPath);
    }
  } catch {
    return;
  }
}

function holdLock(
  lockPath: string,
  fh: FileHandle,
  token: string,
  heartbeatIntervalMs: number,
): LockRelease {
  let stopped = false;
  let beats: Promise<void> = Promise.resolve();

  const runBeat = async () => {
    if (stopped) {
      return;
    }
    try {
      await fh.utimes(new Date(), new Date());
    } catch {
      return;
    }
  };

  const enqueueBeat = () => {
    beats = beats.then(runBeat, runBeat);
  };

  const heartbeat = setInterval(enqueueBeat, heartbeatIntervalMs);
  heartbeat.unref();

  const stopHeartbeat = () => {
    stopped = true;
    clearInterval(heartbeat);
  };

  const drainBeats = async () => {
    stopHeartbeat();
    for (;;) {
      const current = beats;
      await current;
      if (beats === current) {
        break;
      }
    }
  };

  const release = async () => {
    await drainBeats();
    try {
      const handleStat = await fh.stat();
      const pathStat = await stat(lockPath);
      if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
        return;
      }
      const current = parseLock(await readHandle(fh));
      if (!current || current.token !== token) {
        return;
      }
      await unlink(lockPath);
    } catch {
      return;
    } finally {
      await fh.close().catch(() => {});
    }
  };
  release.stopHeartbeat = stopHeartbeat;
  return release;
}

export async function tryAcquireLock(
  lockPath: string,
  options: AcquireLockOptions = {},
): Promise<LockRelease | null> {
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const intervalMs = heartbeatInterval(options, staleTimeoutMs);
  const token = randomUUID();

  await mkdir(dirname(lockPath), { recursive: true });

  const first = await createLockFile(lockPath, token);
  if (first !== "exists") {
    return holdLock(lockPath, first, token, intervalMs);
  }

  await maybeStealStaleLock(lockPath, staleTimeoutMs, isAlive);

  const second = await createLockFile(lockPath, token);
  if (second === "exists") {
    return null;
  }
  return holdLock(lockPath, second, token, intervalMs);
}

export async function acquireLock(
  lockPath: string,
  options: AcquireLockOptions = {},
): Promise<LockRelease> {
  let backoff = 1;
  const maxBackoff = 500;
  for (;;) {
    const got = await tryAcquireLock(lockPath, options);
    if (got) {
      return got;
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}

export class SessionStore {
  private stateFile: string;

  constructor(stateFile?: string) {
    this.stateFile = stateFile ?? defaultStateFile();
  }

  /**
   * Acquires a global lock for the bind-while-running phase.
   * Prevents concurrent agy instances from creating ambiguous .pb files.
   */
  static acquireBindingLock(): Promise<LockRelease> {
    return acquireLock(defaultBindingLockPath());
  }

  async getEntry(sessionId: string): Promise<StoreEntry | null> {
    const store = await this.loadStore();
    return store.sessions[sessionId] ?? null;
  }

  async set(
    sessionId: string,
    conversationId: string | null,
    processedMessages: number = 0,
    prevOutput: string = "",
  ): Promise<void> {
    const stateDir = dirname(this.stateFile);
    await mkdir(stateDir, { recursive: true });

    const lockPath = this.stateFile + ".lock";
    const release = await acquireLock(lockPath);

    try {
      const store = await this.loadStoreUnlocked();
      store.sessions[sessionId] = {
        conversationId,
        processedMessages,
        prevOutput,
      };

      const tmpPath = this.stateFile + ".tmp";
      await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
      await rename(tmpPath, this.stateFile);
    } finally {
      await release();
    }
  }

  private async loadStore(): Promise<StoreFile> {
    const stateDir = dirname(this.stateFile);
    await mkdir(stateDir, { recursive: true });

    const lockPath = this.stateFile + ".lock";
    const release = await acquireLock(lockPath);
    try {
      return await this.loadStoreUnlocked();
    } finally {
      await release();
    }
  }

  private async loadStoreUnlocked(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.stateFile, "utf-8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions ?? {} };
    } catch {
      return { sessions: {} };
    }
  }
}
