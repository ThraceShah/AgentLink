import type { BridgeProfile } from "./parser.js";

export type StreamSnapshot = {
  partialText?: string;
  finalText?: string;
};

export function parseProviderStream(profile: BridgeProfile, content: string): StreamSnapshot {
  if (!content.trim()) {
    return {};
  }

  if (profile === "opencode") {
    return parseOpenCodeStream(content);
  }

  if (profile === "qwen") {
    return parseQwenStream(content);
  }

  if (profile === "copilot") {
    return parseCopilotStream(content);
  }

  if (profile === "codex") {
    return parseCodexJson(content);
  }

  return {};
}

function parseQwenStream(content: string): StreamSnapshot {
  let partial = "";
  let finalText: string | undefined;

  for (const item of parseJsonLines(content)) {
    if (item.type === "stream_event" && item.event?.type === "content_block_delta") {
      const delta = item.event?.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        partial += delta.text;
      }
    }

    if (item.type === "assistant" && item.message?.role === "assistant" && Array.isArray(item.message?.content)) {
      const textBlocks = item.message.content
        .filter((block: { type?: string; text?: string }) => block?.type === "text" && typeof block.text === "string")
        .map((block: { text: string }) => block.text);
      if (textBlocks.length > 0) {
        finalText = textBlocks.join("\n").trim() || finalText;
      }
    }

    if (item.type === "result" && typeof item.result === "string" && item.result.trim()) {
      finalText = item.result.trim();
    }
  }

  return {
    partialText: partial.trim() || finalText,
    finalText
  };
}

function parseCopilotStream(content: string): StreamSnapshot {
  let partial = "";
  let finalText: string | undefined;

  for (const item of parseJsonLines(content)) {
    if (item.type === "assistant.message_delta" && typeof item.data?.deltaContent === "string") {
      partial += item.data.deltaContent;
    }

    if (item.type === "assistant.message" && typeof item.data?.content === "string" && item.data.content.trim()) {
      finalText = item.data.content.trim();
    }
  }

  return {
    partialText: partial.trim() || finalText,
    finalText
  };
}

function parseCodexJson(content: string): StreamSnapshot {
  let finalText: string | undefined;

  for (const item of parseJsonLines(content)) {
    if (item.type === "item.completed" && item.item?.type === "agent_message" && typeof item.item?.text === "string") {
      finalText = item.item.text.trim() || finalText;
    }
  }

  return { partialText: finalText, finalText };
}

function parseOpenCodeStream(content: string): StreamSnapshot {
  let finalText: string | undefined;
  let partialText: string | undefined;

  for (const item of parseJsonLines(content)) {
    const candidate = extractOpenCodeText(item);
    if (!candidate) {
      continue;
    }

    partialText = candidate;
    finalText = candidate;
  }

  const plainText = content.trim();
  if (!finalText && plainText) {
    partialText = plainText;
    finalText = plainText;
  }

  return {
    partialText,
    finalText
  };
}

function parseJsonLines(content: string): Array<Record<string, any>> {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed: Array<Record<string, any>> = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as Record<string, any>);
    } catch {
      // Ignore partially written trailing lines while the provider is still streaming.
    }
  }
  return parsed;
}

function extractOpenCodeText(item: Record<string, any>): string | undefined {
  const directCandidates = [
    item.text,
    item.content,
    item.message,
    item.response,
    item.result,
    item.output
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const nestedCandidates = [
    item.data?.text,
    item.data?.content,
    item.data?.message,
    item.data?.response,
    item.data?.result,
    item.message?.content,
    item.message?.text
  ];
  for (const candidate of nestedCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (Array.isArray(item.message?.content)) {
    const textBlocks = item.message.content
      .filter((block: { type?: string; text?: string }) => block?.type === "text" && typeof block.text === "string")
      .map((block: { text: string }) => block.text.trim())
      .filter(Boolean);
    if (textBlocks.length > 0) {
      return textBlocks.join("\n").trim();
    }
  }

  return undefined;
}
