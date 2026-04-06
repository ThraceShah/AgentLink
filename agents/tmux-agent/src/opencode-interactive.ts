export type TuiMenuItem = {
  id: string;
  label: string;
  description?: string;
  isSelected?: boolean;
};

export type OpenCodeInteractiveCapture = {
  busy: boolean;
  model?: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  promptBody?: string;
  keyHints?: string[];
  finalText?: string;
  menuItems?: TuiMenuItem[];
  menuTitle?: string;
  menuId?: string;
};

export type OpenCodeSessionExport = {
  sessionId?: string;
  directory?: string;
  latestUserText?: string;
  finalText?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  contextUsedTokens?: number;
};

const ansiPattern = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const trailingFramePattern = /[█▌▐▕▏▀▄▖▗▘▝▚▞]+$/g;
const leadingFramePattern = /^[\s┃│┌└┘─╷╵╹╺╸╭╮╰╯]+/g;

export function parseOpenCodeInteractiveCapture(content: string): OpenCodeInteractiveCapture {
  const normalized = normalizeCapture(content);
  if (!normalized) {
    return { busy: false };
  }

  const lines = normalized.split("\n").map(sanitizeLine);
  const joined = lines.join("\n");
  const model = extractModel(joined);
  const usage = extractUsage(joined);
  const menuInfo = extractMenuInfo(lines);

  // Detect busy state: esc hint usually means TUI is waiting for input
  const isBusy = /esc\s*(interrupt|to\s*cancel)?/i.test(joined) || /Select\s+(model|provider|agent)/i.test(joined);

  return {
    busy: isBusy,
    model,
    contextUsedTokens: usage?.used,
    contextWindowTokens: usage?.window,
    promptBody: extractPromptBody(lines),
    keyHints: extractKeyHints(joined),
    finalText: extractFinalText(lines),
    menuItems: menuInfo?.items,
    menuTitle: menuInfo?.title,
    menuId: menuInfo?.id
  };
}

export function parseOpenCodeSessionList(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ses_"))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

export function parseOpenCodeExport(content: string): OpenCodeSessionExport | undefined {
  const jsonStart = content.indexOf("{");
  if (jsonStart < 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content.slice(jsonStart)) as {
      info?: {
        id?: string;
        directory?: string;
      };
      messages?: Array<{
        info?: {
          role?: string;
          modelID?: string;
          model?: {
            modelID?: string;
          };
          tokens?: {
            input?: number;
            output?: number;
            reasoning?: number;
            cache?: {
              read?: number;
            };
          };
        };
        parts?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    };

    const messages = parsed.messages ?? [];
    const latestUser = [...messages].reverse().find((message) => message.info?.role === "user");
    const latestAssistant = [...messages].reverse().find((message) => message.info?.role === "assistant");
    const finalText = latestAssistant?.parts
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim() || undefined;
    const latestUserText = latestUser?.parts
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim() || undefined;
    const inputTokens = asNumber(latestAssistant?.info?.tokens?.input);
    const outputTokens = asNumber(latestAssistant?.info?.tokens?.output);
    const reasoningTokens = asNumber(latestAssistant?.info?.tokens?.reasoning);
    const totalTokens = [inputTokens, outputTokens, reasoningTokens]
      .reduce<number>((sum, value) => sum + (value ?? 0), 0);

    return {
      sessionId: parsed.info?.id,
      directory: parsed.info?.directory,
      latestUserText,
      finalText,
      model: latestAssistant?.info?.modelID?.trim()
        || latestUser?.info?.model?.modelID?.trim()
        || undefined,
      inputTokens,
      outputTokens,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      reasoningTokens,
      contextUsedTokens: inputTokens ?? asNumber(latestAssistant?.info?.tokens?.cache?.read)
    };
  } catch {
    return undefined;
  }
}

function normalizeCapture(content: string): string {
  return content
    .replace(ansiPattern, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

function sanitizeLine(line: string): string {
  return line
    .replace(leadingFramePattern, "")
    .replace(trailingFramePattern, "")
    .trim();
}

function extractModel(content: string): string | undefined {
  const statusMatch = content.match(/(?:^|\n)▣?\s*Build\s*·\s*([A-Za-z0-9._/-]+)/);
  if (statusMatch?.[1]) {
    return statusMatch[1].trim();
  }

  return undefined;
}

function extractUsage(content: string): { used?: number; window?: number } | undefined {
  const match = content.match(/(\d+(?:\.\d+)?[KMB]?)\s*\((\d+)%\)/i);
  if (!match) {
    return undefined;
  }

  const used = parseCompactNumber(match[1]);
  const percentage = Number(match[2]);
  if (!used) {
    return undefined;
  }

  if (!Number.isFinite(percentage) || percentage <= 0) {
    return { used };
  }

  return {
    used,
    window: Math.round(used / (percentage / 100))
  };
}

function extractPromptBody(lines: string[]): string | undefined {
  const meaningful = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Build\s+Qwen/i.test(line))
    .filter((line) => !/^tab agents\b/i.test(line))
    .filter((line) => !/^ctrl\+p commands\b/i.test(line))
    .filter((line) => !/^View all providers\b/i.test(line))
    .filter((line) => !/^● Tip\b/i.test(line))
    .filter((line) => !/^~\//.test(line))
    .filter((line) => !/^Ask\b/i.test(line))
    .filter((line) => !/^Buil\b/i.test(line))
    .filter((line) => !/^OPENC/i.test(line))
    .filter((line) => !/^▣?\s*Bu$/i.test(line))
    .filter((line) => !/^\d+(?:\.\d+)?[KMB]?\s*\(\d+%\)$/.test(line));

  const selectIndex = meaningful.findIndex((line) => /^Select\b/i.test(line));
  if (selectIndex >= 0) {
    return meaningful.slice(selectIndex, selectIndex + 6).join("\n").trim() || undefined;
  }

  const searchIndex = meaningful.findIndex((line) => /^Search:?$/i.test(line));
  if (searchIndex >= 0) {
    return meaningful.slice(searchIndex, searchIndex + 6).join("\n").trim() || undefined;
  }

  return undefined;
}

function extractFinalText(lines: string[]): string | undefined {
  const sanitized = lines.map((line) => line.trimEnd());
  let statusIndex = -1;
  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    if (/(?:^|\s)▣?\s*Build\s*·\s*[A-Za-z0-9._/-]+/.test(sanitized[index] ?? "")) {
      statusIndex = index;
      break;
    }
  }
  if (statusIndex <= 0) {
    return undefined;
  }

  for (let end = statusIndex - 1; end >= 0; end -= 1) {
    const line = sanitized[end]?.trim();
    if (!line) {
      continue;
    }

    let start = end;
    while (start > 0 && sanitized[start - 1]?.trim()) {
      start -= 1;
    }

    const block = sanitized
      .slice(start, end + 1)
      .map((item) => item.trim())
      .filter(Boolean);
    if (block.length === 0) {
      continue;
    }
    if (block.every((item) => item.startsWith("Thinking:") || item.startsWith("The user "))) {
      end = start;
      continue;
    }
    if (block.some((item) => /^Ask anything/i.test(item))) {
      continue;
    }
    if (block.some((item) => /^Build\s+Qwen/i.test(item))) {
      continue;
    }
    return block.join("\n").trim() || undefined;
  }

  return undefined;
}

function extractKeyHints(content: string): string[] | undefined {
  const hints = new Set<string>();
  const normalized = content.toLowerCase();

  for (const match of normalized.matchAll(/\bctrl\+([a-z])\b/g)) {
    hints.add(match[1] ?? "");
  }

  for (const match of normalized.matchAll(/\b([ynjk])\/([ynjk])\b/g)) {
    hints.add(match[1] ?? "");
    hints.add(match[2] ?? "");
  }

  for (const match of normalized.matchAll(/\b([jkyn])\b/g)) {
    if (/^\s*[jkyn]\s*$/.test(match[0] ?? "")) {
      hints.add(match[1] ?? "");
    }
  }

  if (/\besc\b/.test(normalized)) {
    hints.add("esc");
  }
  if (/\btab\b/.test(normalized)) {
    hints.add("tab");
  }
  if (/\benter\b/.test(normalized)) {
    hints.add("enter");
  }

  const values = [...hints].filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseCompactNumber(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) {
    return undefined;
  }

  const base = Number(match[1]);
  if (!Number.isFinite(base)) {
    return undefined;
  }

  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K"
    ? 1_000
    : suffix === "M"
      ? 1_000_000
      : suffix === "B"
        ? 1_000_000_000
        : 1;
  return Math.round(base * multiplier);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractMenuInfo(lines: string[]): { id: string; title: string; items: TuiMenuItem[] } | undefined {
  // Detect menu by title patterns
  const menuPatterns = [
    { id: "model", patterns: [/^Select\s+model/i, /^Models\b/i] },
    { id: "agent", patterns: [/^Agents\b/i, /^Select\s+agent/i] },
    { id: "provider", patterns: [/^Select\s+provider/i, /^Provider/i, /^Connect/i] },
    { id: "variant", patterns: [/^Variants/i] }
  ];

  let detectedId: string | undefined;
  let detectedTitle: string | undefined;
  let menuStartIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    for (const { id, patterns } of menuPatterns) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          detectedId = id;
          // Clean up title: remove trailing UI hints like "esc", "enter", etc.
          let cleanTitle = line;
          // Remove common TUI hints that appear after the menu title
          const titleParts = cleanTitle.split(/\s{2,}/);
          cleanTitle = titleParts[0]?.trim() ?? cleanTitle;
          // Remove trailing single-word hints
          cleanTitle = cleanTitle.replace(/\s+(esc|enter|tab|ctrl\+[a-z])\s*$/gi, "").trim();
          detectedTitle = cleanTitle || line;
          menuStartIndex = index;
          break;
        }
      }
      if (detectedId) {
        break;
      }
    }
    if (detectedId) {
      break;
    }
  }

  if (!detectedId || menuStartIndex < 0) {
    return undefined;
  }

  const items: TuiMenuItem[] = [];
  let pastSearch = false;

  for (let index = menuStartIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    // Skip UI hints at the top
    if (/^(esc|tab|enter|ctrl\+[a-z])$/i.test(line)) {
      continue;
    }

    // Detect Search box - real items follow after
    if (/^Search$/i.test(line)) {
      pastSearch = true;
      continue;
    }

    // Stop conditions
    if (/^View all providers/i.test(line)) {
      break;
    }
    if (/^Popular providers/i.test(line)) {
      break;
    }
    if (/^commands$/i.test(line)) {
      break;
    }
    if (/^Ask\s+anything/i.test(line)) {
      break;
    }
    if (/^Build\s+·/i.test(line)) {
      break;
    }
    if (/^Tip\b/i.test(line)) {
      break;
    }
    if (/^~\//.test(line)) {
      break;
    }
    if (/^\d+\.\d+\.\d+$/.test(line)) {
      break;
    }
    if (/^Free$/i.test(line)) {
      continue;
    }

    // Skip short lines that are likely UI elements
    if (line.length < 3) {
      continue;
    }

    // Skip lines that look like status bar content
    if (/^[▄▀▄▀]+$/.test(line)) {
      continue;
    }
    if (/^[┃│╹╺╸╭╮╰╯]+$/.test(line)) {
      continue;
    }

    // Skip partial UI text like "Ask" or "Buil" (from "Build")
    if (/^(Ask|Buil|Build)$/i.test(line)) {
      continue;
    }

    // Only process items after Search box
    if (!pastSearch) {
      continue;
    }

    // This looks like a menu item
    // Remove leading selector characters and box drawing chars
    let label = line.replace(/^[▸▶►●*┃│╭╮╰╯╹╺╸]+\s*/, "").trim();

    // Handle lines that contain UI elements mixed with menu items
    // Pattern: "Ask     MiniMax M2.5 Free" or "Buil  ● Qwen3.6 Plus Free"
    // The actual menu item is usually after the UI element
    const uiElementPatterns = [
      /^(Ask|Buil|Build)\s*[*●]?\s*/i,
      /^[*●]\s*/
    ];

    for (const pattern of uiElementPatterns) {
      const match = label.match(pattern);
      if (match) {
        // Extract the part after the UI element
        const afterUi = label.slice(match[0]?.length ?? 0).trim();
        if (afterUi.length >= 3) {
          label = afterUi;
          break;
        }
      }
    }

    // Skip if too short after cleanup
    if (label.length < 3) {
      continue;
    }

    // Skip pure UI elements
    if (/^(Ask|Buil|Build)$/i.test(label)) {
      continue;
    }

    // Check for description (model name followed by status like "Free")
    let description: string | undefined;
    const parts = label.split(/\s{2,}/);
    if (parts.length > 1) {
      label = parts[0]?.trim() ?? label;
      description = parts.slice(1).join("  ").trim();
      // Remove "Free" and similar status from description
      if (description === "Free" || description === "Pro") {
        description = undefined;
      }
    }

    // Skip duplicates
    if (items.some((item) => item.label === label)) {
      continue;
    }

    items.push({
      id: `item_${items.length}`,
      label,
      description
    });

    // Limit items
    if (items.length >= 15) {
      break;
    }
  }

  if (items.length === 0) {
    return undefined;
  }

  return {
    id: detectedId,
    title: detectedTitle ?? detectedId,
    items
  };
}
