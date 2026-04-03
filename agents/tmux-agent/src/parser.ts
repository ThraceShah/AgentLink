export type BridgeProfile = "generic" | "codex";

export type PromptHint = {
  eventType: "need_approval" | "need_user_input";
  body: string;
};

export type CaptureDelta = {
  emittedText?: string;
  promptHint?: PromptHint;
  latestSummary?: string;
};

type ParseCaptureOptions = {
  profile: BridgeProfile;
  previousCapture: string;
  currentCapture: string;
  lastSentText?: string;
};

const ansiPattern = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

const codexNoisePatterns = [
  /^tokens?\b/i,
  /^model:\s*/i,
  /^context:\s*/i,
  /^session:\s*/i,
  /^workspace:\s*/i,
  /^press enter to continue/i,
  /^esc to interrupt/i,
  /^ctrl[-+ ]c/i,
  /^use arrows to/i,
  /^approved?\b/i
];

const approvalPattern = /\b(approve|approval|allow|y\/n|yes\/no|confirm)\b/i;
const inputPattern = /\b(need input|press enter|continue\?|select an option|enter your choice|confirm\?)\b/i;

export function parseCaptureDelta(options: ParseCaptureOptions): CaptureDelta {
  const normalizedCurrent = normalizeCapture(options.currentCapture);
  const normalizedPrevious = normalizeCapture(options.previousCapture);

  const currentLines = normalizedCurrent.split("\n").filter(Boolean);
  const previousLines = normalizedPrevious.split("\n").filter(Boolean);
  const deltaLines = computeDeltaLines(previousLines, currentLines);
  const promptHint = detectPromptHint(currentLines.slice(-6).join(" | "));

  if (options.profile === "codex") {
    const meaningfulLines = filterCodexLines(deltaLines, options.lastSentText);
    const emittedText = joinMeaningfulLines(meaningfulLines);
    return {
      emittedText,
      promptHint,
      latestSummary: summarizeLines(filterCodexLines(currentLines.slice(-24), options.lastSentText))
    };
  }

  return {
    emittedText: summarizeLines(deltaLines.slice(-8)),
    promptHint,
    latestSummary: summarizeLines(currentLines.slice(-8))
  };
}

function normalizeCapture(capture: string): string {
  return capture
    .replace(ansiPattern, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n");
}

function computeDeltaLines(previousLines: string[], currentLines: string[]): string[] {
  let prefix = 0;
  const max = Math.min(previousLines.length, currentLines.length);

  while (prefix < max && previousLines[prefix] === currentLines[prefix]) {
    prefix += 1;
  }

  return currentLines.slice(prefix);
}

function filterCodexLines(lines: string[], lastSentText?: string): string[] {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isShellPrompt(line))
    .filter((line) => !codexNoisePatterns.some((pattern) => pattern.test(line)))
    .filter((line) => !isEchoOfLastInput(line, lastSentText))
    .filter((line) => !line.startsWith("AGENT_EVENT "));
}

function isShellPrompt(line: string): boolean {
  return /^([A-Za-z0-9_.-]+@[\w.-]+[:~]|[\w./-]+\s*[$#>])/.test(line);
}

function isEchoOfLastInput(line: string, lastSentText?: string): boolean {
  if (!lastSentText) {
    return false;
  }

  return line === lastSentText.trim();
}

function summarizeLines(lines: string[]): string | undefined {
  const text = joinMeaningfulLines(lines);
  return text || undefined;
}

function joinMeaningfulLines(lines: string[]): string {
  return lines.join("\n").trim();
}

function detectPromptHint(joined: string): PromptHint | undefined {
  const compact = joined.trim();
  if (!compact) {
    return undefined;
  }

  if (approvalPattern.test(compact)) {
    return {
      eventType: "need_approval",
      body: compact
    };
  }

  if (inputPattern.test(compact)) {
    return {
      eventType: "need_user_input",
      body: compact
    };
  }

  return undefined;
}
