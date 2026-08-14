import { readFile, writeFile, rename, mkdir, open, stat } from "node:fs/promises";
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
