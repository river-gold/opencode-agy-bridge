import { describe, test, expect } from "bun:test";
import { flattenPrompt } from "../src/prompt-mapper";

describe("flattenPrompt", () => {
  test("filters out system messages", () => {
    const result = flattenPrompt([
      { role: "system", content: "You are a helpful assistant." },
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    ]);
    expect(result).toBe("hi");
  });

  test("single user message: raw text, no role prefix", () => {
    const result = flattenPrompt([
      {
        role: "user",
        content: [{ type: "text", text: "Hello, how are you?" }],
      },
    ]);
    expect(result).toBe("Hello, how are you?");
  });

  test("single assistant message: raw text, no role prefix", () => {
    const result = flattenPrompt([
      {
        role: "assistant",
        content: [{ type: "text", text: "I am fine, thanks." }],
      },
    ]);
    expect(result).toBe("I am fine, thanks.");
  });

  test("multi-message: wraps history in context block + current at end", () => {
    const result = flattenPrompt([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "how are you?" }],
      },
    ]);
    expect(result).toContain("[Previous Conversation Context]");
    expect(result).toContain("[End of Context]");
    expect(result).toContain("Current Request:");
    expect(result).toContain("how are you?");
    expect(result).toContain("User: hello");
    expect(result).toContain("Assistant: hi there");
  });

  test("omits file parts with warning", () => {
    const result = flattenPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          { type: "file", data: new Uint8Array(), mediaType: "image/png" },
        ],
      },
    ]);
    expect(result).toBe("Look at this:");
  });

  test("handles user message with multiple text parts", () => {
    const result = flattenPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "First part." },
          { type: "text", text: "Second part." },
        ],
      },
    ]);
    expect(result).toBe("First part.\nSecond part.");
  });

  test("returns empty string or system content for system-only prompt", () => {
    const result = flattenPrompt([
      { role: "system", content: "You are an agent." },
      { role: "system", content: "Use tools carefully." },
    ]);
    expect(result).toContain("You are an agent.");
  });

  test("ignores tool-call parts in multi-message context", () => {
    const result = flattenPrompt([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "/foo" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "next" }],
      },
    ]);
    expect(result).not.toContain("[Tool call: read_file");
    expect(result).toContain("next");
  });
});
