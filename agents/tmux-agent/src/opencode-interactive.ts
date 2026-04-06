export type TuiMenuItem = {
  id: string;
  label: string;
  description?: string;
  isSelected?: boolean;
};

export type TuiDialogAction = {
  id: string;
  label: string;
  description?: string;
  isInput?: boolean;
  inputPlaceholder?: string;
};

export type OpenCodeInteractiveDialog = {
  id: string;
  title: string;
  body?: string;
  actions: TuiDialogAction[];
};

export type OpenCodeInteractiveCapture = {
  busy: boolean;
  model?: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  promptBody?: string;
  readyForInput?: boolean;
  keyHints?: string[];
  finalText?: string;
  menuItems?: TuiMenuItem[];
  menuTitle?: string;
  menuId?: string;
  dialog?: OpenCodeInteractiveDialog;
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

type DialogTitleInfo = {
  title: string;
  index: number;
  hints: string[];
};

type ExtractedMenuInfo = {
  id: string;
  title: string;
  items: TuiMenuItem[];
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
  const titleInfo = extractDialogTitle(lines);
  const menuInfo = extractMenuInfo(lines, titleInfo);
  const dialog = menuInfo ? undefined : extractTextDialog(lines, titleInfo);
  const hasActiveDialog = Boolean(menuInfo || dialog);

  const isBusy = /esc\s*(interrupt|to\s*cancel)/i.test(joined);

  return {
    busy: isBusy,
    model,
    contextUsedTokens: usage?.used,
    contextWindowTokens: usage?.window,
    promptBody: buildPromptBody(menuInfo, dialog),
    readyForInput: !hasActiveDialog && lines.some((line) => /^Ask anything\b/i.test(line.trim())),
    keyHints: extractKeyHints(joined),
    finalText: extractFinalText(lines),
    menuItems: menuInfo?.items,
    menuTitle: menuInfo?.title,
    menuId: menuInfo?.id,
    dialog
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

function buildPromptBody(menuInfo?: ExtractedMenuInfo, dialog?: OpenCodeInteractiveDialog): string | undefined {
  if (menuInfo) {
    return [
      menuInfo.title,
      ...menuInfo.items.slice(0, 5).map((item) => item.label)
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

function extractDialogTitle(lines: string[]): DialogTitleInfo | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line || isDialogNoiseLine(line)) {
      continue;
    }

    const parsed = parseTitleLine(line);
    if (!parsed) {
      continue;
    }

    return {
      title: parsed.title,
      index,
      hints: parsed.hints
    };
  }

  return undefined;
}

function parseTitleLine(line: string): { title: string; hints: string[] } | undefined {
  const segments = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }

  const title = segments[0]?.trim();
  const trailing = segments.slice(1).join(" ");
  if (!title || !/[A-Za-z]/.test(title)) {
    return undefined;
  }

  const hints = [...trailing.matchAll(/\b(esc|enter|tab|ctrl\+[a-z])\b/gi)]
    .map((match) => match[1]?.toLowerCase() ?? "")
    .filter(Boolean);
  if (hints.length === 0) {
    return undefined;
  }

  return {
    title: title.replace(/\s+(esc|enter|tab|ctrl\+[a-z])\s*$/gi, "").trim(),
    hints: [...new Set(hints)]
  };
}

function extractMenuInfo(lines: string[], titleInfo?: DialogTitleInfo): ExtractedMenuInfo | undefined {
  if (!titleInfo) {
    return undefined;
  }

  let searchIndex = -1;
  for (let index = titleInfo.index + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    if (isDialogStopLine(line)) {
      break;
    }
    if (/^Search:?$/i.test(line)) {
      searchIndex = index;
      break;
    }
  }

  if (searchIndex < 0) {
    return undefined;
  }

  const items: TuiMenuItem[] = [];
  for (let index = searchIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    if (isDialogStopLine(line) || /^View all providers/i.test(line) || /^Popular providers/i.test(line)) {
      break;
    }
    if (/^(Today|Yesterday|This week|Last week)$/i.test(line)) {
      continue;
    }
    if (/^No results found$/i.test(line)) {
      continue;
    }
    if (/^(esc|tab|enter|ctrl\+[a-z])$/i.test(line)) {
      continue;
    }
    if (countKeyHints(line) > 0) {
      if (items.length > 0) {
        break;
      }
      continue;
    }
    if (line.length < 3 || /^[▄▀▄▀]+$/.test(line) || /^[┃│╹╺╸╭╮╰╯]+$/.test(line)) {
      continue;
    }

    const item = normalizeMenuItem(line, items.length);
    if (!item || items.some((existing) => existing.label === item.label)) {
      continue;
    }

    items.push(item);
    if (items.length >= 20) {
      break;
    }
  }

  return items.length > 0
    ? { id: normalizeDialogId(titleInfo.title), title: titleInfo.title, items }
    : undefined;
}

function extractTextDialog(lines: string[], titleInfo?: DialogTitleInfo): OpenCodeInteractiveDialog | undefined {
  if (!titleInfo) {
    return undefined;
  }

  const bodyLines: string[] = [];
  let primaryAction = titleInfo.hints.includes("enter")
    ? buildPrimaryDialogAction(titleInfo.title, "OK")
    : undefined;
  for (let index = titleInfo.index + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    if (/^Search:?$/i.test(line)) {
      return undefined;
    }
    if (isDialogStopLine(line)) {
      break;
    }
    if (/^(esc|tab|enter|ctrl\+[a-z])$/i.test(line)) {
      continue;
    }
    if (!primaryAction) {
      const inlineAction = extractInlineDialogAction(line, titleInfo.title);
      if (inlineAction) {
        primaryAction = inlineAction;
        continue;
      }
    }
    if (countKeyHints(line) > 0 && bodyLines.length > 0) {
      break;
    }

    const normalized = normalizeDialogBodyLine(line);
    if (!normalized) {
      continue;
    }
    bodyLines.push(normalized);
  }

  const actions = buildDialogActions(primaryAction);
  if (bodyLines.length === 0 && actions.length === 0) {
    return undefined;
  }

  return {
    id: normalizeDialogId(titleInfo.title),
    title: titleInfo.title,
    body: bodyLines.join("\n").trim() || undefined,
    actions
  };
}

function normalizeMenuItem(line: string, index: number): TuiMenuItem | undefined {
  const isSelected = /(?:^|\s)[●▸▶►]\s+\S/.test(line);
  let label = line
    .replace(/^[⠁-⣿]+\s*/u, "")
    .replace(/^[▸▶►●*┃│╭╮╰╯╹╺╸]+\s*/, "")
    .trim();

  const uiElementPatterns = [
    /^(Ask|Buil|Build)\s*[*●]?\s*/i,
    /^[*●]\s*/
  ];

  for (const pattern of uiElementPatterns) {
    const match = label.match(pattern);
    if (match) {
      const afterUi = label.slice(match[0]?.length ?? 0).trim();
      if (afterUi.length >= 3) {
        label = afterUi;
        break;
      }
    }
  }

  if (label.length < 3 || /^(Ask|Buil|Build|commands)$/i.test(label)) {
    return undefined;
  }

  let description: string | undefined;
  const parts = label.split(/\s{2,}/);
  if (parts.length > 1) {
    label = parts[0]?.trim() ?? label;
    description = parts.slice(1).join("  ").trim();
    if (description === "Free" || description === "Pro") {
      description = undefined;
    }
  }

  return {
    id: `item_${index}`,
    label,
    description,
    isSelected
  };
}

function normalizeDialogBodyLine(line: string): string | undefined {
  let normalized = line
    .replace(/^[⠁-⣿]+\s*/u, "")
    .replace(/^[▸▶►*┃│╭╮╰╯╹╺╸]+\s*/, "")
    .trim();
  normalized = normalized.replace(/^(Ask|Buil|Build)\s*/i, "").trim();
  if (!normalized) {
    return undefined;
  }
  if (/^(Ask|Buil|Build|Search|commands)$/i.test(normalized) || /^[▀▄█▌▐▕▏]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function buildDialogActions(primaryAction?: TuiDialogAction): TuiDialogAction[] {
  const actions: TuiDialogAction[] = [];
  if (primaryAction) {
    actions.push(primaryAction);
  }
  actions.push({
    id: "__cancel__",
    label: "Cancel"
  });
  return actions;
}

function extractInlineDialogAction(line: string, title: string): TuiDialogAction | undefined {
  const match = line.match(/\benter\s+([a-z][a-z0-9_-]*)\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  return buildPrimaryDialogAction(title, match[1]);
}

function buildPrimaryDialogAction(title: string, label: string): TuiDialogAction {
  const normalizedLabel = capitalizeActionLabel(label);
  if (/(rename|name|message|title|session|path|directory|prompt|branch)/i.test(title)) {
    return {
      id: "__submit__",
      label: normalizedLabel,
      isInput: true,
      inputPlaceholder: inferInputPlaceholder(title)
    };
  }
  return {
    id: "__confirm__",
    label: normalizedLabel
  };
}

function capitalizeActionLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) {
    return "OK";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function inferInputPlaceholder(title: string): string {
  if (/rename\s+session/i.test(title)) {
    return "New session name";
  }
  if (/rename/i.test(title)) {
    return "New value";
  }
  if (/message/i.test(title)) {
    return "Type your message";
  }
  return "Enter value...";
}

function normalizeDialogId(title: string): string {
  const normalized = title.trim().toLowerCase();
  if (/select\s+model|^models?\b/.test(normalized)) {
    return "model";
  }
  if (/select\s+agent|^agents?\b/.test(normalized)) {
    return "agent";
  }
  if (/select\s+provider|^provider\b|^connect\b/.test(normalized)) {
    return "provider";
  }
  if (/select\s+variant|^variants?\b/.test(normalized)) {
    return "variant";
  }
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "dialog";
}

function isDialogNoiseLine(line: string): boolean {
  return /^~\//.test(line)
    || /^tab agents\b/i.test(line)
    || /^ctrl\+p commands\b/i.test(line)
    || /^Ask\s+anything/i.test(line)
    || /^Build\b/i.test(line)
    || /^\d+\.\d+\.\d+$/.test(line)
    || /^[█▀▄ ]+$/.test(line)
    || /^OPENC/i.test(line);
}

function isDialogStopLine(line: string): boolean {
  return /^Ask\s+anything/i.test(line)
    || /^Build\b/i.test(line)
    || /\btab agents\b/i.test(line)
    || /\bctrl\+p commands\b/i.test(line)
    || /^Tip\b/i.test(line)
    || /^~\//.test(line)
    || /^\d+\.\d+\.\d+$/.test(line);
}

function countKeyHints(line: string): number {
  return [...line.matchAll(/\b(esc|enter|tab|ctrl\+[a-z])\b/gi)].length;
}
