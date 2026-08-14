import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, SessionStore } from "../src/session-store";

describe("SessionStore", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    stateFile = join(dir, "sessions.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("getEntry returns null for unknown session", async () => {
    const store = new SessionStore(stateFile);
    const result = await store.getEntry("unknown-session");
    expect(result).toBeNull();
  });

  test("set and getEntry roundtrip", async () => {
    const store = new SessionStore(stateFile);
    await store.set("sess-1", "conv-abc", 3);
    const entry = await store.getEntry("sess-1");
    expect(entry).not.toBeNull();
    expect(entry!.conversationId).toBe("conv-abc");
    expect(entry!.processedMessages).toBe(3);
  });

  test("set with null value", async () => {
    const store = new SessionStore(stateFile);
    await store.set("sess-1", "conv-abc");
    await store.set("sess-1", null);
    const entry = await store.getEntry("sess-1");
    expect(entry).not.toBeNull();
    expect(entry!.conversationId).toBeNull();
  });

  test("multiple sessions in same store", async () => {
    const store = new SessionStore(stateFile);
    await store.set("a", "conv-a", 1);
    await store.set("b", "conv-b", 2);

    expect((await store.getEntry("a"))!.conversationId).toBe("conv-a");
    expect((await store.getEntry("a"))!.processedMessages).toBe(1);
    expect((await store.getEntry("b"))!.conversationId).toBe("conv-b");
    expect((await store.getEntry("b"))!.processedMessages).toBe(2);
  });

  test("persists across store instances", async () => {
    const store1 = new SessionStore(stateFile);
    await store1.set("sess-1", "conv-xyz", 5);

    const store2 = new SessionStore(stateFile);
    const entry = await store2.getEntry("sess-1");
    expect(entry).not.toBeNull();
    expect(entry!.conversationId).toBe("conv-xyz");
    expect(entry!.processedMessages).toBe(5);
  });

  test("default processedMessages is 0", async () => {
    const store = new SessionStore(stateFile);
    await store.set("sess-1", "conv-abc");
    const entry = await store.getEntry("sess-1");
    expect(entry!.processedMessages).toBe(0);
  });

  test("persists and restores prevOutput", async () => {
    const store1 = new SessionStore(stateFile);
    await store1.set("sess-1", "conv-abc", 3, "previous agy output here");

    const store2 = new SessionStore(stateFile);
    const entry = await store2.getEntry("sess-1");
    expect(entry).not.toBeNull();
    expect(entry!.prevOutput).toBe("previous agy output here");
  });

  test("default prevOutput is empty string", async () => {
    const store = new SessionStore(stateFile);
    await store.set("sess-1", "conv-abc");
    const entry = await store.getEntry("sess-1");
    expect(entry!.prevOutput).toBe("");
  });

  test("binding lock serializes concurrent access", async () => {
    const release1 = await SessionStore.acquireBindingLock();
    expect(release1).toBeInstanceOf(Function);

    const release2Promise = SessionStore.acquireBindingLock();

    await release1();

    const release2 = await release2Promise;
    expect(release2).toBeInstanceOf(Function);
    await release2();
  }, 40000);

  test("heartbeat keeps a held lock from being stolen after the stale window", async () => {
    const lockPath = join(dir, "held.lock");
    const opts = { staleTimeoutMs: 40, heartbeatIntervalMs: 10 };
    const release1 = await acquireLock(lockPath, opts);

    let stolen = false;
    const pending = acquireLock(lockPath, opts).then((release2) => {
      stolen = true;
      return release2;
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(stolen).toBe(false);

    await release1();
    const release2 = await pending;
    await release2();
  });

  test("release removes only its own lock after a stale steal", async () => {
    const lockPath = join(dir, "owner.lock");
    const opts = { staleTimeoutMs: 40, heartbeatIntervalMs: 10 };
    const release1 = await acquireLock(lockPath, opts);
    release1.stopHeartbeat();

    await new Promise((r) => setTimeout(r, 80));
    const release2 = await acquireLock(lockPath, opts);

    await release1();
    await access(lockPath);

    await release2();
    await expect(access(lockPath)).rejects.toThrow();
  });
});
