import type { LanguageModelV2Prompt, LanguageModelV2Message } from "@ai-sdk/provider";

export function flattenPrompt(prompt: LanguageModelV2Prompt): string {
  const nonSystem = prompt.filter((msg) => msg.role !== "system");

  if (nonSystem.length === 0) {
    const texts = prompt.map((msg) => extractText(msg).trim()).filter(Boolean);
    return texts.join("\n");
  }

  if (nonSystem.length === 1) {
    return extractText(nonSystem[0]).trim();
  }

  const parts: string[] = [];
  const history = nonSystem.slice(0, -1);
  const current = nonSystem[nonSystem.length - 1];

  parts.push("[Previous Conversation Context]");
  for (const msg of history) {
    const text = extractText(msg);
    if (text.trim()) {
      const label = msg.role === "user" ? "User" : "Assistant";
      parts.push(`${label}: ${text}`);
    }
  }
  parts.push("[End of Context]");

  const currentText = extractText(current).trim();
  if (currentText) {
    parts.push("");
    parts.push("Current Request:");
    parts.push(currentText);
  }

  return parts.join("\n");
}

function extractText(msg: LanguageModelV2Message): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        texts.push(part.text);
      }
    }
    return texts.join("\n");
  }

  return "";
}
