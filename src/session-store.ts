import { readFile, writeFile, rename, mkdir, open, stat, utimes, unlink } from "node:fs/promises";
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

export interface AcquireLockOptions {
  staleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
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

async function tryCreateLock(lockPath: string, owner: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(owner);
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

async function maybeStealStaleLock(
  lockPath: string,
  staleTimeoutMs: number,
): Promise<void> {
  try {
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs <= staleTimeoutMs) {
      return;
    }
    await unlink(lockPath);
  } catch {
    // gone or already stolen
  }
}

async function releaseOwnedLock(lockPath: string, owner: string): Promise<void> {
  try {
    const current = await readFile(lockPath, "utf-8");
    if (current !== owner) {
      return;
    }
    await unlink(lockPath);
  } catch {
    // best effort
  }
}

export async function acquireLock(
  lockPath: string,
  options: AcquireLockOptions = {},
): Promise<LockRelease> {
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(1, Math.floor(staleTimeoutMs / 3));

  const lockDir = dirname(lockPath);
  await mkdir(lockDir, { recursive: true });
  const owner = randomUUID();

  let backoff = 1;
  const maxBackoff = 500;
  for (;;) {
    if (await tryCreateLock(lockPath, owner)) {
      break;
    }
    await maybeStealStaleLock(lockPath, staleTimeoutMs);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  const heartbeat = setInterval(() => {
    void utimes(lockPath, new Date(), new Date()).catch(() => {});
  }, heartbeatIntervalMs);
  heartbeat.unref();

  const stopHeartbeat = () => {
    clearInterval(heartbeat);
  };

  const release = async () => {
    stopHeartbeat();
    await releaseOwnedLock(lockPath, owner);
  };
  release.stopHeartbeat = stopHeartbeat;
  return release;
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
