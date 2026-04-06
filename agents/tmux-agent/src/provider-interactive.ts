import type { BridgeProfile } from "./parser.js";
import {
  parseOpenCodeInteractiveCapture,
  type OpenCodeInteractiveCapture,
  type OpenCodeInteractiveDialog,
  type TuiMenuItem
} from "./opencode-interactive.js";

const ansiPattern = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const qwenSpinnerPattern = /^[⠁-⣿].*esc to cancel/i;
const copilotSpinnerPattern = /^[◐◓◑◒].+/;
const dividerPattern = /^[─-]{10,}$/;
const qwenReasoningPattern = /^(The user|Let me|I should|I need to|Simple enough\.?$)/i;

export type InteractiveCapture = OpenCodeInteractiveCapture;

export function parseInteractiveCapture(profile: BridgeProfile, content: string): InteractiveCapture {
  if (profile === "opencode") {
    return parseOpenCodeInteractiveCapture(content);
  }

  if (profile === "qwen") {
    return parseQwenInteractiveCapture(content);
  }

  if (profile === "copilot") {
    return parseCopilotInteractiveCapture(content);
  }

  if (profile === "codex") {
    return parseCodexInteractiveCapture(content);
  }

  return { busy: false };
}

function parseQwenInteractiveCapture(content: string): InteractiveCapture {
  const lines = normalizeLines(content);
  if (lines.length === 0) {
    return { busy: false };
  }

  const joined = lines.join("\n");
  const menu = extractQwenMenu(lines);
  const dialog = menu ? undefined : extractQwenTextDialog(content);
  const finalText = menu || dialog ? undefined : extractQwenFinalText(lines);
  const busy = lines.some((line) => qwenSpinnerPattern.test(line.trim()));
  const readyForInput = !busy && lines.some((line) =>
    /^\*\s+Type your message or @path\/to\/file$/i.test(line.trim())
  );

  return {
    busy,
    model: extractQwenModel(joined),
    promptBody: buildPromptBody(menu, dialog),
    readyForInput,
    keyHints: menu ? ["enter", "up", "down", "esc", "tab"] : busy ? ["esc"] : undefined,
    finalText,
    menuItems: menu?.items,
    menuTitle: menu?.title,
    menuId: menu?.id,
    dialog
  };
}

function parseCopilotInteractiveCapture(content: string): InteractiveCapture {
  const lines = normalizeLines(content);
  if (lines.length === 0) {
    return { busy: false };
  }

  const joined = lines.join("\n");
  const menu = extractCopilotMenu(lines);
  const usage = extractCopilotUsage(joined);
  const model = usage?.model ?? extractCopilotFooterModel(lines);
  const busy = lines.some((line) => copilotSpinnerPattern.test(line.trim()));
  const readyForInput = !menu && !busy && lines.some((line) =>
    /^❯\s+Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for$/i.test(line.trim())
  );

  return {
    busy,
    model,
    contextUsedTokens: usage?.used,
    contextWindowTokens: usage?.window,
    promptBody: buildPromptBody(menu),
    readyForInput,
    keyHints: menu ? extractCopilotKeyHints(joined) : undefined,
    finalText: menu ? undefined : extractCopilotFinalText(lines),
    menuItems: menu?.items,
    menuTitle: menu?.title,
    menuId: menu?.id
  };
}

function parseCodexInteractiveCapture(content: string): InteractiveCapture {
  const lines = normalizeLines(content);
  if (lines.length === 0) {
    return { busy: false };
  }

  const joined = lines.join("\n");
  const menu = extractCodexModelMenu(lines);
  const busy = /esc to interrupt/i.test(joined);
  const readyForInput = !menu && !busy && lines.some((line) => line.trim().startsWith("›"));

  return {
    busy,
    model: extractCodexModel(joined),
    promptBody: buildPromptBody(menu),
    readyForInput,
    keyHints: menu ? ["enter", "up", "down", "esc"] : busy ? ["esc"] : undefined,
    finalText: menu ? undefined : extractCodexFinalText(lines),
    menuItems: menu?.items,
    menuTitle: menu?.title,
    menuId: menu?.id
  };
}

function normalizeLines(content: string): string[] {
  return content
    .replace(ansiPattern, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\u200B/g, "").replace(/\s+$/g, ""))
    .map(stripBorders)
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""));
}

function stripBorders(line: string): string {
  return line
    .replace(/^[\s│┃]+/g, "")
    .replace(/[│┃\s]+$/g, "")
    .trimEnd();
}

function buildPromptBody(
  menu?: { title: string; items: TuiMenuItem[] },
  dialog?: OpenCodeInteractiveDialog
): string | undefined {
  if (menu) {
    return [
      menu.title,
      ...menu.items.slice(0, 5).map((item) => item.label)
    ].join("\n").trim() || undefined;
  }

  if (!dialog) {
    return undefined;
  }

  return [
    dialog.title,
    dialog.body
  ].filter(Boolean).join("\n").trim() || undefined;
}

function extractQwenModel(content: string): string | undefined {
  return content.match(/Coding Plan\s+\|\s+(.+?)\s+\(\/model to change\)/)?.[1]?.trim();
}

function extractQwenMenu(lines: string[]): { id: string; title: string; items: TuiMenuItem[] } | undefined {
  const titleIndex = lines.findIndex((line) => /^Select [A-Za-z]/.test(line.trim()));
  if (titleIndex < 0) {
    return undefined;
  }

  const title = lines[titleIndex]?.trim();
  if (!title) {
    return undefined;
  }

  const items: TuiMenuItem[] = [];
  let current: TuiMenuItem | undefined;
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      continue;
    }
    if (/^Enter to select/i.test(line) || /^Modality:/i.test(line) || dividerPattern.test(line)) {
      continue;
    }

    const itemMatch = line.match(/^(›\s*)?(\d+)\.\s+(.+)$/);
    if (itemMatch) {
      current = {
        id: `item_${Number(itemMatch[2]) - 1}`,
        label: itemMatch[3]?.trim() ?? "",
        isSelected: Boolean(itemMatch[1])
      };
      items.push(current);
      continue;
    }

    if (current && !/^[A-Za-z][^:]+:/.test(line)) {
      current.description = [current.description, line].filter(Boolean).join(" ").trim();
    }
  }

  return items.length > 0
    ? {
        id: slug(title),
        title,
        items
      }
    : undefined;
}

function extractQwenFinalText(lines: string[]): string | undefined {
  const promptIndex = lastIndex(lines, (line) => /^\*\s+Type your message or @path\/to\/file$/i.test(line.trim()));
  if (promptIndex < 0) {
    return undefined;
  }

  const blocks = collectMeaningfulBlocks(lines.slice(0, promptIndex), {
    skipPatterns: [
      /^>\s+/,
      /^Tips:/,
      /^Coding Plan\s+\|/,
      /^YOLO mode/,
      /^>_\s+Qwen Code/,
      dividerPattern
    ]
  });
  const qwenBlocks = blocks
    .map((block) => stripBlockPrefixes(block, ["✦", "●", "✕", "✓"]))
    .map((block) => block.filter((line) => !qwenReasoningPattern.test(line)))
    .filter((block) => block.length > 0);

  return qwenBlocks.at(-1)?.join("\n").trim() || undefined;
}

function extractQwenTextDialog(content: string): OpenCodeInteractiveDialog | undefined {
  const rawLines = normalizeRawLines(content);
  const promptIndex = lastIndex(rawLines, (line) => /^\s*>\s+\//.test(line));
  if (promptIndex < 0) {
    return undefined;
  }

  const frame = [...extractFramedBlocks(rawLines)]
    .reverse()
    .find((block) => block.start > promptIndex);
  if (!frame) {
    return undefined;
  }

  const contentLines = normalizeDialogLines(frame.content);
  const title = contentLines[0];
  if (!title || /^Select [A-Za-z]/.test(title) || contentLines.some((line) => /^(›\s*)?\d+\.\s+/.test(line))) {
    return undefined;
  }

  const hintLine = contentLines.find((line) => /\b(esc|enter)\b/i.test(line));
  const bodyLines = normalizeDialogLines(
    contentLines
      .slice(1)
      .filter((line) => line !== hintLine)
      .filter((line) => !dividerPattern.test(line))
  );

  const actions = [];
  if (hintLine && /\benter\b/i.test(hintLine) && !/\bselect\b/i.test(hintLine)) {
    actions.push({
      id: "__confirm__",
      label: "OK"
    });
  }
  actions.push({
    id: "__cancel__",
    label: "Cancel"
  });

  if (bodyLines.length === 0) {
    return undefined;
  }

  return {
    id: slug(title),
    title,
    body: bodyLines.join("\n"),
    actions
  };
}

function extractCopilotMenu(lines: string[]): { id: string; title: string; items: TuiMenuItem[] } | undefined {
  const titleIndex = lines.findIndex((line) =>
    /^(Select Model|Sessions)$/i.test(line.trim())
  );
  if (titleIndex < 0) {
    return undefined;
  }

  const title = lines[titleIndex]?.trim();
  if (!title) {
    return undefined;
  }

  const footerIndex = lines.findIndex((line, index) =>
    index > titleIndex && /(Esc (to )?(cancel|close)|Enter (to )?(select|switch))/i.test(line)
  );
  const endIndex = footerIndex >= 0 ? footerIndex : lines.length;
  const items: TuiMenuItem[] = [];
  for (let index = titleIndex + 1; index < endIndex; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line || /^Choose the AI model/i.test(line) || /^Search /i.test(line) || /^\[Available]/i.test(line)) {
      continue;
    }

    const itemMatch = line.match(/^(❯\s*)?(.+?)(?:\s{2,}([0-9.]+x))?$/);
    if (!itemMatch) {
      continue;
    }

    const label = itemMatch[2]?.replace(/\s+\(default\)\s+✓/i, " (default)").trim() ?? "";
    if (!label || /(Esc (to )?(cancel|close)|Enter (to )?(select|switch)|Navigate)/i.test(label)) {
      continue;
    }

    items.push({
      id: `item_${items.length}`,
      label,
      description: itemMatch[3]?.trim(),
      isSelected: Boolean(itemMatch[1])
    });
  }

  return items.length > 0
    ? {
        id: slug(title),
        title,
        items
      }
    : undefined;
}

function extractCopilotUsage(content: string): { model?: string; used?: number; window?: number } | undefined {
  const match = content.match(/([A-Za-z0-9 .+-]+)\s+·\s+([0-9.]+[kKmM]?)\/([0-9.]+[kKmM]?) tokens/i);
  if (!match) {
    return undefined;
  }

  return {
    model: match[1]?.trim(),
    used: parseCompactNumber(match[2]),
    window: parseCompactNumber(match[3])
  };
}

function extractCopilotFooterModel(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/\]\s+(.+?)$/);
    if (match?.[1] && !/^shift\+tab/i.test(match[1])) {
      return match[1].trim();
    }
  }

  return undefined;
}

function extractCopilotFinalText(lines: string[]): string | undefined {
  const promptIndex = lastIndex(lines, (line) =>
    /^❯\s+Type @ to mention files, # for issues\/PRs, \/ for commands, or \? for$/i.test(line.trim())
  );
  if (promptIndex < 0) {
    return undefined;
  }

  const blocks = collectMeaningfulBlocks(lines.slice(0, promptIndex), {
    skipPatterns: [
      /^Environment loaded:/i,
      /^Loading environment:/i,
      /^GitHub Copilot v/i,
      /^Copilot uses AI/i,
      /^Tip:/,
      /^[_~\/].+\]\s+.+$/,
      dividerPattern
    ]
  });
  const normalized = blocks
    .map((block) => stripBlockPrefixes(block, ["●", "✗", "✓"]))
    .filter((block) => block.length > 0);

  return normalized.at(-1)?.join("\n").trim() || undefined;
}

function extractCopilotKeyHints(content: string): string[] | undefined {
  const hints = new Set<string>();
  if (/↑↓/u.test(content)) {
    hints.add("up");
    hints.add("down");
  }
  if (/\bTab\b/i.test(content)) {
    hints.add("tab");
  }
  if (/\bEnter\b/i.test(content)) {
    hints.add("enter");
  }
  if (/\bEsc\b/i.test(content)) {
    hints.add("esc");
  }
  const values = [...hints];
  return values.length > 0 ? values : undefined;
}

function extractCodexModel(content: string): string | undefined {
  return content.match(/model:\s+(.+?)\s+\/model to change/i)?.[1]?.trim();
}

function extractCodexModelMenu(lines: string[]): { id: string; title: string; items: TuiMenuItem[] } | undefined {
  const titleIndex = lines.findIndex((line) => /^Select Model and Effort$/i.test(line.trim()));
  if (titleIndex < 0) {
    return undefined;
  }

  const items: TuiMenuItem[] = [];
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line || /^Access legacy models/i.test(line) || /^Press enter to select/i.test(line)) {
      continue;
    }

    const itemMatch = line.match(/^(›\s*)?(\d+)\.\s*(.+)$/);
    if (!itemMatch) {
      continue;
    }

    items.push({
      id: `item_${Number(itemMatch[2]) - 1}`,
      label: itemMatch[3]?.trim() ?? "",
      isSelected: Boolean(itemMatch[1])
    });
  }

  return items.length > 0
    ? {
        id: "model",
        title: "Select Model and Effort",
        items
      }
    : undefined;
}

function extractCodexFinalText(lines: string[]): string | undefined {
  const promptIndex = lastIndex(lines, (line) => line.trim().startsWith("›"));
  if (promptIndex < 0) {
    return undefined;
  }

  const blocks = collectMeaningfulBlocks(lines.slice(0, promptIndex), {
    skipPatterns: [
      /^Heads up/i,
      /^model:\s+/i,
      /^directory:\s+/i,
      /^Tip:/i,
      dividerPattern
    ]
  });
  return blocks.at(-1)?.join("\n").trim() || undefined;
}

function collectMeaningfulBlocks(
  lines: string[],
  options: { skipPatterns: RegExp[] }
): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];

  const pushCurrent = () => {
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      pushCurrent();
      continue;
    }
    if (options.skipPatterns.some((pattern) => pattern.test(line))) {
      pushCurrent();
      continue;
    }
    current.push(line);
  }
  pushCurrent();

  return blocks;
}

function normalizeRawLines(content: string): string[] {
  return content
    .replace(ansiPattern, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\u200B/g, "").replace(/\s+$/g, ""));
}

function extractFramedBlocks(lines: string[]): Array<{ start: number; end: number; content: string[] }> {
  const blocks: Array<{ start: number; end: number; content: string[] }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/╭.*─/.test(lines[index] ?? "")) {
      continue;
    }

    const content: string[] = [];
    let end = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (/╰.*─/.test(line)) {
        end = cursor;
        break;
      }

      const inner = line.match(/^[\s│┃]*(.*?)[\s│┃]*$/)?.[1] ?? "";
      content.push(inner);
      end = cursor;
    }

    if (end > index) {
      blocks.push({ start: index, end, content });
      index = end;
    }
  }

  return blocks;
}

function normalizeDialogLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const normalized = stripBorders(line).trim();
    if (!normalized) {
      if (result[result.length - 1] !== "") {
        result.push("");
      }
      continue;
    }
    result.push(normalized);
  }

  while (result[0] === "") {
    result.shift();
  }
  while (result[result.length - 1] === "") {
    result.pop();
  }

  return result;
}

function stripBlockPrefixes(block: string[], prefixes: string[]): string[] {
  return block
    .map((line) => {
      for (const prefix of prefixes) {
        if (line.startsWith(`${prefix} `)) {
          return line.slice(prefix.length + 1).trim();
        }
      }
      return line;
    })
    .filter(Boolean);
}

function parseCompactNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
  if (!match) {
    return undefined;
  }

  const base = Number(match[1]);
  if (!Number.isFinite(base)) {
    return undefined;
  }

  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "k"
    ? 1_000
    : suffix === "m"
      ? 1_000_000
      : 1;
  return Math.round(base * multiplier);
}

function lastIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index] ?? "")) {
      return index;
    }
  }

  return -1;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
