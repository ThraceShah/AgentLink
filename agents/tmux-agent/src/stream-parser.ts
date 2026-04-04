import type { BridgeProfile } from "./parser.js";

export type StreamSnapshot = {
  partialText?: string;
  finalText?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
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
  let model: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let contextWindowTokens: number | undefined;

  for (const item of parseJsonLines(content)) {
    if (item.type === "system" && typeof item.model === "string" && item.model.trim()) {
      model = item.model.trim();
    }

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
      if (typeof item.message?.model === "string" && item.message.model.trim()) {
        model = item.message.model.trim();
      }
      const usage = item.message?.usage;
      if (usage && typeof usage === "object") {
        inputTokens = asNumber(usage.input_tokens) ?? inputTokens;
        outputTokens = asNumber(usage.output_tokens) ?? outputTokens;
        totalTokens = asNumber(usage.total_tokens) ?? totalTokens;
        contextWindowTokens = asNumber(usage.context_window_tokens) ?? contextWindowTokens;
      }
    }

    if (item.type === "result" && typeof item.result === "string" && item.result.trim()) {
      finalText = item.result.trim();
      const usage = item.usage;
      if (usage && typeof usage === "object") {
        inputTokens = asNumber(usage.input_tokens) ?? inputTokens;
        outputTokens = asNumber(usage.output_tokens) ?? outputTokens;
        totalTokens = asNumber(usage.total_tokens) ?? totalTokens;
        contextWindowTokens = asNumber(usage.context_window_tokens) ?? contextWindowTokens;
      }
    }
  }

  return {
    partialText: partial.trim() || finalText,
    finalText,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    contextUsedTokens: totalTokens ?? inputTokens,
    contextWindowTokens
  };
}

function parseCopilotStream(content: string): StreamSnapshot {
  let partial = "";
  let finalText: string | undefined;
  let model: string | undefined;
  let outputTokens: number | undefined;

  for (const item of parseJsonLines(content)) {
    if (item.type === "session.tools_updated" && typeof item.data?.model === "string" && item.data.model.trim()) {
      model = item.data.model.trim();
    }

    if (item.type === "session.model_change") {
      const nextModel = item.data?.newModel ?? item.data?.currentModel ?? item.data?.model;
      if (typeof nextModel === "string" && nextModel.trim()) {
        model = nextModel.trim();
      }
    }

    if (item.type === "assistant.message_delta" && typeof item.data?.deltaContent === "string") {
      partial += item.data.deltaContent;
    }

    if (item.type === "assistant.message" && typeof item.data?.content === "string" && item.data.content.trim()) {
      finalText = item.data.content.trim();
      outputTokens = asNumber(item.data?.outputTokens) ?? outputTokens;
    }
  }

  return {
    partialText: partial.trim() || finalText,
    finalText,
    model,
    outputTokens
  };
}

function parseCodexJson(content: string): StreamSnapshot {
  let finalText: string | undefined;
  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;

  for (const item of parseJsonLines(content)) {
    if (item.type === "item.completed" && item.item?.type === "agent_message" && typeof item.item?.text === "string") {
      finalText = item.item.text.trim() || finalText;
    }

    if (item.type === "turn.completed" && item.usage && typeof item.usage === "object") {
      inputTokens = asNumber(item.usage.input_tokens) ?? inputTokens;
      cachedInputTokens = asNumber(item.usage.cached_input_tokens) ?? cachedInputTokens;
      outputTokens = asNumber(item.usage.output_tokens) ?? outputTokens;
    }
  }

  const totalTokens = [inputTokens, cachedInputTokens, outputTokens]
    .reduce<number>((sum, value) => sum + (value ?? 0), 0);

  return {
    partialText: finalText,
    finalText,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    contextUsedTokens: inputTokens != null || cachedInputTokens != null
      ? (inputTokens ?? 0) + (cachedInputTokens ?? 0)
      : undefined
  };
}

function parseOpenCodeStream(content: string): StreamSnapshot {
  let finalText: string | undefined;
  let partialText: string | undefined;
  let model: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let reasoningTokens: number | undefined;
  const parsedItems = parseJsonLines(content);
  const wholeDocument = parseWholeJson(content);
  if (wholeDocument) {
    const candidate = extractOpenCodeText(wholeDocument);
    if (candidate) {
      return {
        partialText: candidate,
        finalText: candidate
      };
    }
  }

  for (const item of parsedItems) {
    if (!model && item.type === "log" && typeof item.message === "string") {
      model = extractOpenCodeLogModel(item.message) ?? model;
    }

    if (item.type === "step_finish" && item.part?.tokens && typeof item.part.tokens === "object") {
      inputTokens = asNumber(item.part.tokens.input) ?? inputTokens;
      outputTokens = asNumber(item.part.tokens.output) ?? outputTokens;
      totalTokens = asNumber(item.part.tokens.total) ?? totalTokens;
      reasoningTokens = asNumber(item.part.tokens.reasoning) ?? reasoningTokens;
    }

    const candidate = extractOpenCodeText(item);
    if (!candidate) {
      continue;
    }

    partialText = candidate;
    finalText = candidate;
  }

  const plainText = content.trim();
  const hasOnlyLogs = parsedItems.length === 0 && extractOpenCodeLogModel(content) != null;
  if (!finalText && plainText && !hasOnlyLogs) {
    partialText = plainText;
    finalText = plainText;
  }

  if (!model) {
    model = extractOpenCodeLogModel(content);
  }

  return {
    partialText,
    finalText,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    contextUsedTokens: totalTokens !== undefined ? totalTokens : inputTokens
  };
}

function parseWholeJson(content: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, any>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    item.part?.text,
    item.part?.content,
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

function extractOpenCodeLogModel(content: string): string | undefined {
  const primaryMatches = Array.from(
    content.matchAll(/service=llm[^\n]*providerID=opencode[^\n]*modelID=([^\s]+)[^\n]*(?:small=false|agent=build)/g)
  );
  if (primaryMatches.length > 0) {
    return primaryMatches[0]?.[1]?.trim() || undefined;
  }

  const fallbackMatches = Array.from(
    content.matchAll(/service=llm[^\n]*providerID=opencode[^\n]*modelID=([^\s]+)[^\n]*mode=primary/g)
  );
  return fallbackMatches[0]?.[1]?.trim() || undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
