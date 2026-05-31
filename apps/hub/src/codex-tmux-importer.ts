import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createId,
  type TimelineEvent
} from "../../../packages/protocol/src/index.js";

const execFileAsync = promisify(execFile);

export type CodexTmuxCandidate = {
  candidateId: string;
  tmuxSession: string;
  windowIndex: string;
  paneIndex: string;
  paneId: string;
  panePid: number;
  command: string;
  args: string;
  cwd: string;
  threadId: string;
  title: string;
  preview: string;
  model?: string;
  reasoningEffort?: string;
  rolloutPath?: string;
  updatedAt?: string;
  confidence: "exact" | "cwd_latest";
};

export type CodexThreadRecord = {
  id: string;
  cwd: string;
  title: string;
  preview: string;
  model?: string;
  reasoningEffort?: string;
  rolloutPath?: string;
  updatedAt?: string;
  updatedAtMs?: number;
};

export class CodexTmuxImporter {
  async listCandidates(): Promise<CodexTmuxCandidate[]> {
    const [panes, processes, threads] = await Promise.all([
      this.listTmuxPanes(),
      this.listProcesses(),
      this.listCodexThreads()
    ]);
    const processByPid = new Map(processes.map((item) => [item.pid, item]));
    const childrenByPid = new Map<number, ProcessInfo[]>();
    for (const process of processes) {
      const children = childrenByPid.get(process.ppid) ?? [];
      children.push(process);
      childrenByPid.set(process.ppid, children);
    }

    const candidates: CodexTmuxCandidate[] = [];
    for (const pane of panes) {
      const descendants = collectDescendants(pane.panePid, childrenByPid);
      const paneProcess = processByPid.get(pane.panePid);
      const processTree = paneProcess ? [paneProcess, ...descendants] : descendants;
      const codexProcess = processTree.find((process) => isCodexTuiProcess(process));
      if (!codexProcess) {
        continue;
      }

      const explicitThreadId = extractThreadId(codexProcess.args);
      const thread = explicitThreadId
        ? threads.find((item) => item.id === explicitThreadId)
        : latestThreadForCwd(threads, pane.cwd);
      if (!thread) {
        continue;
      }

      candidates.push({
        candidateId: `${pane.paneId}:${thread.id}`,
        tmuxSession: pane.tmuxSession,
        windowIndex: pane.windowIndex,
        paneIndex: pane.paneIndex,
        paneId: pane.paneId,
        panePid: pane.panePid,
        command: codexProcess.command,
        args: codexProcess.args,
        cwd: pane.cwd,
        threadId: thread.id,
        title: thread.title || thread.preview || "Codex session",
        preview: thread.preview || thread.title || "",
        model: thread.model,
        reasoningEffort: thread.reasoningEffort,
        rolloutPath: thread.rolloutPath,
        updatedAt: thread.updatedAt,
        confidence: explicitThreadId ? "exact" : "cwd_latest"
      });
    }

    return candidates.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async findCandidate(candidateId: string): Promise<CodexTmuxCandidate | undefined> {
    return (await this.listCandidates()).find((item) => item.candidateId === candidateId);
  }

  async readTimeline(thread: Pick<CodexThreadRecord, "id" | "rolloutPath">, agentId: string): Promise<TimelineEvent[]> {
    if (!thread.rolloutPath) {
      return [];
    }
    const content = await readFile(thread.rolloutPath, "utf8");
    return parseCodexRolloutTimeline(content, agentId, thread.id);
  }

  private async listTmuxPanes(): Promise<TmuxPane[]> {
    try {
      const { stdout } = await execFileAsync("tmux", [
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}"
      ], { encoding: "utf8" });
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseTmuxPane)
        .filter((value): value is TmuxPane => Boolean(value));
    } catch {
      return [];
    }
  }

  private async listProcesses(): Promise<ProcessInfo[]> {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8" });
    return stdout
      .split("\n")
      .map(parseProcessLine)
      .filter((value): value is ProcessInfo => Boolean(value));
  }

  private async listCodexThreads(): Promise<CodexThreadRecord[]> {
    const dbPath = path.join(homedir(), ".codex", "state_5.sqlite");
    const query = [
      ".mode tabs",
      ".headers off",
      "select id, cwd, title, preview, model, reasoning_effort, rollout_path, updated_at_ms from threads where archived = 0 order by updated_at_ms desc limit 200;"
    ].join("\n");
    let stdout: string;
    try {
      const result = await execFileAsync("sqlite3", [dbPath, query], { encoding: "utf8" });
      stdout = result.stdout;
    } catch {
      return [];
    }
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map(parseThreadRecord)
      .filter((value): value is CodexThreadRecord => Boolean(value));
  }
}

type TmuxPane = {
  tmuxSession: string;
  windowIndex: string;
  paneIndex: string;
  paneId: string;
  paneCommand: string;
  cwd: string;
  panePid: number;
};

type ProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
  args: string;
};

function parseTmuxPane(line: string): TmuxPane | undefined {
  const [tmuxSession, windowIndex, paneIndex, paneId, paneCommand, cwd, panePidText] = line.split("\t");
  const panePid = Number(panePidText);
  if (!tmuxSession || !paneId || !cwd || !Number.isInteger(panePid)) {
    return undefined;
  }
  return {
    tmuxSession,
    windowIndex,
    paneIndex,
    paneId,
    paneCommand,
    cwd,
    panePid
  };
}

function parseProcessLine(line: string): ProcessInfo | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) {
    return undefined;
  }
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    command: match[3],
    args: match[4] ?? ""
  };
}

function parseThreadRecord(line: string): CodexThreadRecord | undefined {
  const [id, cwd, title, preview, model, reasoningEffort, rolloutPath, updatedAtMsText] = line.split("\t");
  if (!id || !cwd) {
    return undefined;
  }
  const updatedAtMs = Number(updatedAtMsText);
  return {
    id,
    cwd,
    title: title ?? "",
    preview: preview ?? "",
    model: model || undefined,
    reasoningEffort: reasoningEffort || undefined,
    rolloutPath: rolloutPath || undefined,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : undefined,
    updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : undefined
  };
}

function collectDescendants(rootPid: number, childrenByPid: Map<number, ProcessInfo[]>): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  const stack = [...(childrenByPid.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    result.push(current);
    stack.push(...(childrenByPid.get(current.pid) ?? []));
  }
  return result;
}

function isCodexTuiProcess(process: ProcessInfo): boolean {
  const haystack = `${process.command} ${process.args}`.toLowerCase();
  return /\bcodex\b/.test(haystack)
    && !haystack.includes("app-server")
    && !haystack.includes("agents/tmux-agent/src/main.ts");
}

function extractThreadId(value: string): string | undefined {
  return value.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
}

function latestThreadForCwd(threads: CodexThreadRecord[], cwd: string): CodexThreadRecord | undefined {
  return threads.find((item) => item.cwd === cwd);
}

export function parseCodexRolloutTimeline(content: string, agentId: string, threadId: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = stringValue(item.timestamp) ?? new Date().toISOString();
    const payload = objectValue(item.payload);
    const message = payload?.type === "message" ? payload : undefined;
    const role = stringValue(message?.role);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractMessageText(message?.content);
    if (!text) {
      continue;
    }
    events.push({
      id: createId(role === "user" ? "import_user" : "import_ai"),
      agentId,
      eventType: role === "user" ? "user_command" : "text_output",
      timestamp,
      title: role === "user" ? "Imported user message" : "Imported Codex reply",
      body: text,
      metadata: {
        imported: true,
        source: "codex_rollout",
        threadId
      }
    });
  }
  return events.slice(-90);
}

function extractMessageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((item) => objectValue(item))
    .map((item) => stringValue(item?.text) ?? stringValue(item?.content))
    .filter((item): item is string => Boolean(item?.trim()));
  return parts.join("\n").trim() || undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
