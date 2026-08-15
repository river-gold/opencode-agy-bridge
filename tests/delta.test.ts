import { describe, test, expect } from "bun:test";
import { extractDelta } from "../src/provider";

describe("extractDelta", () => {
  test("returns full text when not conversation bound", () => {
    expect(extractDelta("old response", "old responsenew part", false)).toBe(
      "old responsenew part",
    );
  });

  test("returns full text when prevOutput is empty", () => {
    expect(extractDelta("", "any text", true)).toBe("any text");
  });

  test("strips prefix exactly", () => {
    const prev = "turn one response\n";
    const full = "turn one response\nturn two response";
    expect(extractDelta(prev, full, true)).toBe("turn two response");
  });

  test("handles trailing newline mismatch", () => {
    const prev = "turn one response\n";
    const full = "turn one response\n\n  turn two response";
    expect(extractDelta(prev, full, true)).toBe("  turn two response");
  });

  test("handles CRLF normalization", () => {
    const prev = "line one\r\nline two";
    const full = "line one\nline two\nadded line";
    expect(extractDelta(prev, full, true)).toBe("added line");
  });

  test("finds prevOutput with prepended noise (concurrent agy)", () => {
    const prev = "previous response\n";
    const full = "WARNING: lock contention\nprevious response\nnew answer";
    expect(extractDelta(prev, full, true)).toBe("new answer");
  });

  test("finds prevOutput with prepended newlines and noise", () => {
    const prev = "previous\nresponse";
    const full = "\n\nUpdate available: v2.0\n\nprevious\nresponse\nfresh content";
    expect(extractDelta(prev, full, true)).toBe("fresh content");
  });

  test("warns and returns full when prevOutput not found", () => {
    const prev = "completely different text";
    const full = "something else entirely";
    expect(extractDelta(prev, full, true)).toBe("something else entirely");
  });

  test("handles exact match with no delta", () => {
    const prev = "same text";
    const full = "same text";
    expect(extractDelta(prev, full, true)).toBe("");
  });

  test("handles prevOutput trimmed vs full text with trailing whitespace", () => {
    const prev = "hello  ";
    const full = "hello  world";
    expect(extractDelta(prev, full, true)).toBe("world");
  });

  test("handles context truncation via last line alignment", () => {
    const prev = "Hello! I can help you with that.\nLet me build a React application for you.\n";
    const full = "Let me build a React application for you.\nSure, here is the React code.";
    expect(extractDelta(prev, full, true)).toBe("Sure, here is the React code.");
  });

  test("handles context truncation via suffix alignment when last line is short", () => {
    const prev = "Let me build a React application for you.\nOkay.\n";
    const full = "Let me build a React application for you.\nOkay.\nSure, here is the React code.";
    expect(extractDelta(prev, full, true)).toBe("Sure, here is the React code.");
  });

  test("tail matching with lastIndexOf avoids false match on repeated text", () => {
    const prev =
      "Step 1: run tests. done.\n" +
      "Step 2: build project. done.\n" +
      "Step 3: deploy. done.\n";
    const full =
      "Step 1: run tests. done.\n" +
      "Step 2: build project. done.\n" +
      "Step 3: deploy. done.\n" +
      "NEW RESPONSE: All steps completed.";
    expect(extractDelta(prev, full, true)).toBe("NEW RESPONSE: All steps completed.");
  });

  test("tail matching handles truncated beginning (conversation grew too long)", () => {
    const marker = "UNIQUE_TAIL_".repeat(20);
    const longPrefix = "X".repeat(500);
    const prev = longPrefix + marker + "\n";

    const full = "...TRUNCATED...\n" + marker + "\nHere is the new response.";
    expect(extractDelta(prev, full, true)).toBe("Here is the new response.");
  });

  test("returns full text when prev appears after a quote in the new answer", () => {
    const prev = "the old conclusion";
    const full =
      "I disagree.\n> someone said the old conclusion\nMy new conclusion is different.";
    expect(extractDelta(prev, full, true)).toBe(full);
  });

  test("returns full text when prev last line appears inside a fenced code block", () => {
    const prev =
      "Hello! I can help you with that.\nLet me build a React application for you.\n";
    const full =
      "```\nLet me build a React application for you.\nconsole.log(1);\n```\nHere is a different answer.";
    expect(extractDelta(prev, full, true)).toBe(full);
  });

  test("returns full text when prev is a non-boundary prefix of a new answer", () => {
    const prev = "same text";
    const full = "same textual prefix, but this is a new answer";
    expect(extractDelta(prev, full, true)).toBe(full);
  });

  test("returns full text when long repeated tail appears inside a fenced code block", () => {
    const marker = "UNIQUE_TAIL_".repeat(20);
    const prev = "Old conversation prefix\n" + marker;
    const full = "```\n" + marker + "\n```\nFresh analysis follows.";
    expect(extractDelta(prev, full, true)).toBe(full);
  });

  test("aligns truncated output to last 150 chars of a non-repeating spaced tail", () => {
    const prefix = "P".repeat(400);
    const suffix =
      "once upon a draft the prior reply listed unique words like amber birch cedar " +
      "dawn ember flint grove haven ivory jasper kelp lunar maple north olive pine";
    const prev = prefix + suffix;
    const tail = prev.slice(-150);
    const full = "...TRUNCATED...\n" + tail + "\nHere is the new response.";
    expect(extractDelta(prev, full, true)).toBe("Here is the new response.");
  });
});
