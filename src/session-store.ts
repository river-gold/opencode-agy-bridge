import { readFile, writeFile, rename, mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface StoreEntry {
  conversationId: string | null;
  prevOutput: string;
}

interface StoreFile {
  sessions: Record<string, StoreEntry>;
}

function defaultStateFile(): string {
  return join(homedir(), ".opencode-agy-plugin", "sessions.json");
}

function defaultBindingLockPath(): string {
  return join(homedir(), ".opencode-agy-plugin", "binding.lock");
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const lockDir = dirname(lockPath);
  await mkdir(lockDir, { recursive: true });

  const startTime = Date.now();
  const staleTimeoutMs = 30_000;
  let backoff = 1;
  const maxBackoff = 500;

  while (true) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      return () => releaseLock(lockPath);
    } catch {
      if (Date.now() - startTime > staleTimeoutMs) {
        try {
          const stats = await stat(lockPath);
          if (Date.now() - stats.mtimeMs > staleTimeoutMs) {
            await releaseLock(lockPath);
            continue;
          }
        } catch {
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(lockPath);
  } catch {
    // best effort
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
  static acquireBindingLock(): Promise<() => Promise<void>> {
    return acquireLock(defaultBindingLockPath());
  }

  async getEntry(sessionId: string): Promise<StoreEntry | null> {
    const store = await this.loadStore();
    return store.sessions[sessionId] ?? null;
  }

  async set(
    sessionId: string,
    conversationId: string | null,
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
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: {} };
      }
      throw err;
    }

    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { sessions?: unknown }).sessions !== "object" ||
      (parsed as { sessions?: unknown }).sessions === null ||
      Array.isArray((parsed as { sessions?: unknown }).sessions)
    ) {
      throw new Error("Invalid session store state format");
    }

    const sessions = (parsed as { sessions: Record<string, unknown> }).sessions;
    for (const [key, entry] of Object.entries(sessions)) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry)
      ) {
        throw new Error(`Invalid session store state format: entry "${key}" must be an object`);
      }
      const { conversationId, processedMessages, prevOutput } = entry as Record<string, unknown>;
      if (typeof conversationId !== "string" && conversationId !== null) {
        throw new Error(`Invalid session store state format: entry "${key}" conversationId must be a string or null`);
      }
      if (
        typeof processedMessages !== "number" ||
        !Number.isInteger(processedMessages) ||
        processedMessages < 0
      ) {
        throw new Error(
          `Invalid session store state format: entry "${key}" processedMessages must be a non-negative integer`,
        );
      }
      if (typeof prevOutput !== "string") {
        throw new Error(`Invalid session store state format: entry "${key}" prevOutput must be a string`);
      }
    }

    return { sessions: sessions as Record<string, StoreEntry> };
  }
}
