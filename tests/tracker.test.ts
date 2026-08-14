import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshot, findNewConversation } from "../src/conversation-tracker";

describe("conversation-tracker", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("snapshot returns empty set for empty dir", async () => {
    const s = await snapshot(dir);
    expect(s.size).toBe(0);
  });

  test("snapshot returns pb file stems", async () => {
    await writeFile(join(dir, "conv-abc.pb"), "");
    await writeFile(join(dir, "conv-def.pb"), "");
    await writeFile(join(dir, "not-conv.txt"), "");

    const s = await snapshot(dir);
    expect(s.size).toBe(2);
    expect(s.has("conv-abc")).toBe(true);
    expect(s.has("conv-def")).toBe(true);
    expect(s.has("not-conv")).toBe(false);
  });

  test("snapshot returns empty set for non-existent dir", async () => {
    const s = await snapshot(join(dir, "nonexistent"));
    expect(s.size).toBe(0);
  });

  test("findNewConversation returns null when no new files", async () => {
    const before = await snapshot(dir);
    const result = await findNewConversation(before, dir);
    expect(result).toBeNull();
  });

  test("findNewConversation returns new conversation id", async () => {
    const before = await snapshot(dir);
    await writeFile(join(dir, "new-conv.pb"), "");

    const result = await findNewConversation(before, dir);
    expect(result).toBe("new-conv");
  });

  test("findNewConversation returns null when multiple new files", async () => {
    const before = await snapshot(dir);
    await writeFile(join(dir, "a.pb"), "");
    await writeFile(join(dir, "b.pb"), "");

    const result = await findNewConversation(before, dir);
    expect(result).toBeNull();
  });

  test("findNewConversation detects single new file among existing ones", async () => {
    await writeFile(join(dir, "existing.pb"), "old");

    const before = await snapshot(dir);
    await writeFile(join(dir, "new-one.pb"), "new");

    const result = await findNewConversation(before, dir);
    expect(result).toBe("new-one");
  });
});
