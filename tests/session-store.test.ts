import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/session-store";

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
    await store.set("sess-1", "conv-abc");
    const entry = await store.getEntry("sess-1");
    expect(entry).not.toBeNull();
    expect(entry!.conversationId).toBe("conv-abc");
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
    await store.set("a", "conv-a");
    await store.set("b", "conv-b");

    expect((await store.getEntry("a"))!.conversationId).toBe("conv-a");
    expect((await store.getEntry("b"))!.conversationId).toBe("conv-b");
  });

  test("persists across store instances", async () => {
    const store1 = new SessionStore(stateFile);
    await store1.set("sess-1", "conv-xyz");

    const store2 = new SessionStore(stateFile);
    const entry = await store2.getEntry("sess-1");
    expect(entry).not.toBeNull();
    expect(entry!.conversationId).toBe("conv-xyz");
  });

  test("ignores legacy processedMessages and omits it on write", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({
        sessions: {
          old: {
            conversationId: "conv-old",
            processedMessages: 9,
            prevOutput: "legacy-out",
          },
        },
      }),
    );

    const store = new SessionStore(stateFile);
    const loaded = await store.getEntry("old");
    expect(loaded!.conversationId).toBe("conv-old");
    expect(loaded!.prevOutput).toBe("legacy-out");

    await store.set("old", "conv-old", "legacy-out");
    const raw = JSON.parse(await readFile(stateFile, "utf-8"));
    expect(raw.sessions.old.processedMessages).toBeUndefined();
    expect(raw.sessions.old.conversationId).toBe("conv-old");
    expect(raw.sessions.old.prevOutput).toBe("legacy-out");
  });

  test("persists and restores prevOutput", async () => {
    const store1 = new SessionStore(stateFile);
    await store1.set("sess-1", "conv-abc", "previous agy output here");

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
    // Acquire first lock — should succeed
    const release1 = await SessionStore.acquireBindingLock();
    expect(release1).toBeInstanceOf(Function);

    // Second acquisition should time out (but we release and retry)
    const release2Promise = SessionStore.acquireBindingLock();

    // Release first lock
    await release1();

    // Now second lock should succeed
    const release2 = await release2Promise;
    expect(release2).toBeInstanceOf(Function);
    await release2();
  }, 40000);

  test("getEntry rejects on corrupt JSON and leaves file unchanged", async () => {
    const corruptContent = "{\ninvalid json syntax...";
    await writeFile(stateFile, corruptContent, "utf-8");

    const store = new SessionStore(stateFile);
    await expect(store.getEntry("sess-1")).rejects.toThrow();

    const onDisk = await readFile(stateFile, "utf-8");
    expect(onDisk).toBe(corruptContent);
  });

  test("set rejects on corrupt JSON and leaves file unchanged", async () => {
    const corruptContent = "{\ninvalid json syntax...";
    await writeFile(stateFile, corruptContent, "utf-8");

    const store = new SessionStore(stateFile);
    await expect(store.set("sess-1", "conv-abc", 1)).rejects.toThrow();

    const onDisk = await readFile(stateFile, "utf-8");
    expect(onDisk).toBe(corruptContent);
  });

  test("getEntry and set reject on invalid persisted shape and leave file unchanged", async () => {
    const invalidShapes = [
      "[]",
      JSON.stringify({ notSessions: {} }),
      JSON.stringify({ sessions: "not-an-object" }),
      JSON.stringify({ sessions: null }),
      JSON.stringify({ sessions: [1, 2, 3] }),
    ];

    for (const invalidContent of invalidShapes) {
      await writeFile(stateFile, invalidContent, "utf-8");

      const store = new SessionStore(stateFile);
      await expect(store.getEntry("sess-1")).rejects.toThrow("Invalid session store state format");
      await expect(store.set("sess-1", "conv-abc", 1)).rejects.toThrow("Invalid session store state format");

      const onDisk = await readFile(stateFile, "utf-8");
      expect(onDisk).toBe(invalidContent);
    }
  });

  test("getEntry and set reject on malformed session entries and leave file unchanged", async () => {
    const malformedEntries = [
      { s1: "not-an-object" },
      { s1: null },
      { s1: [1, 2] },
      { s1: { conversationId: 123, processedMessages: 0, prevOutput: "" } },
      { s1: { conversationId: "conv-1", processedMessages: -1, prevOutput: "" } },
      { s1: { conversationId: "conv-1", processedMessages: 1.5, prevOutput: "" } },
      { s1: { conversationId: "conv-1", processedMessages: "0", prevOutput: "" } },
      { s1: { conversationId: "conv-1", processedMessages: 0, prevOutput: null } },
      { s1: { conversationId: "conv-1", processedMessages: 0, prevOutput: 42 } },
    ];

    for (const sessions of malformedEntries) {
      const invalidContent = JSON.stringify({ sessions });
      await writeFile(stateFile, invalidContent, "utf-8");

      const store = new SessionStore(stateFile);
      await expect(store.getEntry("s1")).rejects.toThrow("Invalid session store state format");
      await expect(store.set("s2", "conv-2", 0)).rejects.toThrow("Invalid session store state format");

      const onDisk = await readFile(stateFile, "utf-8");
      expect(onDisk).toBe(invalidContent);
    }
  });
});
