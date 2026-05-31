import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";
import type { SlashCommandNode, TuiMenuSelect } from "../../../packages/protocol/src/index.js";
import { buildExecCompletionResult, latestExecPreview } from "./exec-delivery.js";
import { CodexAppServerClient, type CodexModelOption, type CodexOfficialStatus, type CodexPendingRequest, type ReasoningEffort } from "./codex-app-server.js";
import { resolveProviderModel } from "./model-resolver.js";
import { parseInteractiveCapture } from "./provider-interactive.js";
import { parseCaptureDelta, type BridgeProfile } from "./parser.js";
import { parseProviderStream } from "./stream-parser.js";
import { buildTmuxKeySendSpec } from "./tmux-keys.js";

const execFileAsync = promisify(execFile);

type CodexMode = "exec" | "interactive";
type ActiveExecTask = {
  id: string;
  prompt: string;
  workingDir: string;
  promptPath: string;
  outputPath: string;
  stderrPath: string;
  statusPath: string;
  eventId: string;
  commandPromptPath: string;
  commandOutputPath: string;
  commandStatusPath: string;
  emittedText: string;
  model?: string;
};

type ActiveInteractiveTask = {
  id: string;
  prompt: string;
  startedAt: number;
  model?: string;
  promptBody?: string;
  sawBusy: boolean;
  ignoredMenuId?: string;
  ignoredMenuHash?: string;
};

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const profile = (process.env.TMUX_BRIDGE_PROFILE ?? "generic") as BridgeProfile;
const codexMode = ((process.env.TMUX_CODEX_MODE ?? "interactive") as CodexMode);
const sessionName = process.env.TMUX_SESSION ?? "iris-agent";
const managedCommand = process.argv.slice(2).join(" ") || process.env.TMUX_COMMAND || defaultManagedCommand(profile, codexMode);
const pollIntervalMs = Number(process.env.TMUX_POLL_MS ?? 1000);
const approveText = process.env.TMUX_APPROVE_TEXT ?? "y";
const codexResumeThreadId = process.env.IRIS_CODEX_RESUME_THREAD_ID?.trim();
const codexForkFromThreadId = process.env.IRIS_CODEX_FORK_FROM_THREAD_ID?.trim();
const codexImportedModel = process.env.IRIS_CODEX_IMPORTED_MODEL?.trim();
const codexImportedReasoningEffort = parseReasoningEffort(process.env.IRIS_CODEX_IMPORTED_REASONING_EFFORT?.trim() ?? "");

const opencodeNativeCommands: SlashCommandNode[] = [
  { id: "agents", label: "agents", description: "Switch agent", commandType: "send_text" },
  { id: "code", label: "code", description: "Code mode", commandType: "send_text" },
  { id: "connect", label: "connect", description: "Connect provider", commandType: "send_text" },
  { id: "editor", label: "editor", description: "Open editor", commandType: "send_text" },
  { id: "exit", label: "exit", description: "Exit the app", commandType: "send_text" },
  { id: "help", label: "help", description: "Help", commandType: "send_text" },
  { id: "init", label: "init", description: "Guided AGENTS.md setup", commandType: "send_text" },
  { id: "mcps", label: "mcps", description: "Toggle MCPs", commandType: "send_text" },
  { id: "models", label: "models", description: "Switch model", commandType: "send_text" },
  { id: "new", label: "new", description: "New session", commandType: "send_text" },
  { id: "project", label: "project", description: "Project settings", commandType: "send_text" },
  { id: "review", label: "review", description: "Review changes (commit|branch|pr)", commandType: "send_text" },
  { id: "sessions", label: "sessions", description: "Manage sessions", commandType: "send_text" },
  { id: "skills", label: "skills", description: "Manage skills", commandType: "send_text" },
  { id: "status", label: "status", description: "View status", commandType: "send_text" },
  { id: "themes", label: "themes", description: "Switch theme", commandType: "send_text" },
  { id: "tui", label: "tui", description: "TUI settings", commandType: "send_text" }
];

const qwenNativeCommands: SlashCommandNode[] = [
  { id: "model", label: "model", description: "Switch model", commandType: "send_text" },
  { id: "hooks", label: "hooks", description: "Manage hooks", commandType: "send_text" },
  { id: "compress", label: "compress", description: "Compress conversation", commandType: "send_text" },
  { id: "clear", label: "clear", description: "Clear the session", commandType: "send_text" },
  { id: "help", label: "help", description: "Show slash command help", commandType: "send_text" },
  { id: "status", label: "status", description: "Show version and status info", commandType: "send_text" }
];

const codexNativeCommands: SlashCommandNode[] = [
  {
    id: "model",
    label: "model",
    description: "Switch model and reasoning effort",
    commandType: "custom",
    args: { codexCommand: "model.select" },
    ui: { kind: "codexModel" }
  },
  {
    id: "goal",
    label: "goal",
    description: "View, set, replace, or clear the active goal",
    commandType: "custom",
    args: { codexCommand: "goal" },
    ui: { kind: "codexGoal" }
  },
  {
    id: "rename",
    label: "rename",
    description: "Rename the current Codex thread",
    commandType: "custom",
    args: { codexCommand: "thread.rename" },
    ui: { kind: "textInput", title: "Rename Thread", label: "Thread name", placeholder: "New thread name" }
  },
  {
    id: "compact",
    label: "compact",
    description: "Compact the current Codex context",
    commandType: "custom",
    args: { codexCommand: "thread.compact" },
    ui: { kind: "confirm", title: "Compact Context", body: "Compact the current Codex context now?" }
  },
  {
    id: "memory",
    label: "memory",
    description: "Manage Codex memory for this thread",
    commandType: "custom",
    args: { codexCommand: "memory" },
    ui: { kind: "codexMemory" }
  },
  {
    id: "mcp",
    label: "mcp",
    description: "Show MCP server status",
    commandType: "custom",
    args: { codexCommand: "mcp.status" },
    ui: { kind: "direct" }
  },
  {
    id: "status",
    label: "status",
    description: "Show Codex status",
    commandType: "custom",
    args: { codexCommand: "status" },
    ui: { kind: "direct" }
  },
  { id: "iris-status", label: "iris-status", description: "Show bridge session status", commandType: "send_text" },
  { id: "iris_status", label: "iris_status", description: "Show bridge session status", commandType: "send_text" },
  { id: "iris-new-thread", label: "iris-new-thread", description: "Start a new Codex thread", commandType: "send_text" },
  { id: "iris-clear-history", label: "iris-clear-history", description: "Clear this Hub timeline", commandType: "send_text" },
  { id: "iris-help", label: "iris-help", description: "Show AgentLink mobile commands", commandType: "send_text" }
];

const copilotNativeCommands: SlashCommandNode[] = [
  { id: "model", label: "model", description: "Switch model", commandType: "send_text" },
  { id: "compact", label: "compact", description: "Compress context", commandType: "send_text" },
  { id: "context", label: "context", description: "View context usage", commandType: "send_text" },
  { id: "session", label: "session", description: "Session management", commandType: "send_text" },
  { id: "tasks", label: "tasks", description: "View background tasks", commandType: "send_text" },
  { id: "init", label: "init", description: "Initialize Copilot instructions", commandType: "send_text" },
  { id: "help", label: "help", description: "Show interactive command help", commandType: "send_text" }
];

function buildSlashCommands(currentProfile: BridgeProfile): SlashCommandNode[] {
  return currentProfile === "opencode"
    ? opencodeNativeCommands
    : currentProfile === "qwen"
      ? qwenNativeCommands
      : currentProfile === "codex"
        ? (codexMode === "interactive" ? codexNativeCommands : [])
        : currentProfile === "copilot"
          ? copilotNativeCommands
          : [];
}

const runtime = new AgentRuntime({
  hubUrl,
  agentId: process.env.AGENT_ID ?? defaultAgentId(profile, sessionName),
  displayName: process.env.AGENT_DISPLAY_NAME ?? defaultDisplayName(sessionName),
  kind: process.env.AGENT_KIND ?? defaultKind(profile),
  sessionHint: sessionName,
  capabilities: ["status", "stop", "retry", "approve", "send_text", "send_key"],
  quickCommands: ["status", "approve", "retry", "stop"],
  slashCommands: buildSlashCommands(profile)
});

let paneId = process.env.IRIS_TMUX_PANE;
let lastCapture = "";
let lastPromptKey = "";
let lastDeadState = "0";
let lastSentText = "";
let lastUserPrompt = "";
let latestReply = "";
let poller: NodeJS.Timeout | undefined;
let activeExecTask: ActiveExecTask | undefined;
let activeInteractiveTask: ActiveInteractiveTask | undefined;
let activeMenuId: string | undefined;
let lastMenuItemsHash: string | undefined;
let activeMenuSelectedIndex: number | undefined;
let codexAppClient: CodexAppServerClient | undefined;
let codexModelMenuItems: CodexModelOption[] = [];
let pendingCodexModelSelection: CodexModelOption | undefined;
let activeCodexProcessId: string | undefined;
let activeCodexProcessStartedAt = 0;
let activeCodexProcessStepCount = 0;
let activeCodexLastAssistantDraft = "";

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { encoding: "utf8" });
  return stdout.trim();
}

async function tmuxExists(target: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", target], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function resolvePane(): Promise<string> {
  if (paneId) {
    return paneId;
  }

  if (await tmuxExists(sessionName)) {
    paneId = await tmux(["list-panes", "-t", sessionName, "-F", "#{pane_id}"]);
    return paneId;
  }

  if (!managedCommand) {
    throw new Error(`tmux session '${sessionName}' not found and no TMUX_COMMAND provided`);
  }

  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "sh", "-lc", managedCommand], { encoding: "utf8" });
  paneId = await tmux(["list-panes", "-t", sessionName, "-F", "#{pane_id}"]);
  return paneId;
}

async function sendLiteral(text: string): Promise<void> {
  const targetPane = await resolvePane();
  await execFileAsync("tmux", ["send-keys", "-t", targetPane, "-l", text], { encoding: "utf8" });
  await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Enter"], { encoding: "utf8" });
}

async function sendKey(input: { key?: unknown; modifiers?: unknown }): Promise<void> {
  const targetPane = await resolvePane();
  const spec = buildTmuxKeySendSpec(input);
  if (spec.mode === "literal") {
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "-l", spec.value], { encoding: "utf8" });
    return;
  }

  await execFileAsync("tmux", ["send-keys", "-t", targetPane, spec.value], { encoding: "utf8" });
}

async function tmuxPanePath(targetPane: string): Promise<string> {
  return tmux(["display-message", "-p", "-t", targetPane, "#{pane_current_path}"]);
}

async function emitPromptHint(body: string, eventType: "need_approval" | "need_user_input"): Promise<void> {
  if (!body || body === lastPromptKey) {
    return;
  }

  lastPromptKey = body;
  await runtime.emitEvent({
    eventType,
    body,
    status: "waiting_input"
  });
}

async function emitCompletionIfNeeded(targetPane: string): Promise<void> {
  const state = await tmux(["display-message", "-p", "-t", targetPane, "#{pane_dead}:#{pane_dead_status}"]);
  if (state === lastDeadState) {
    return;
  }
  lastDeadState = state;

  const [dead, codeText] = state.split(":");
  if (dead !== "1") {
    return;
  }

  const exitCode = Number(codeText ?? "0");
  await runtime.emitEvent({
    eventType: exitCode === 0 ? "task_completed" : "task_failed",
    body: exitCode === 0 ? "Session finished." : `Session exited with code ${exitCode}.`,
    status: exitCode === 0 ? "completed" : "failed"
  });
}

async function capturePane(): Promise<void> {
  const targetPane = await resolvePane();
  const capture = await tmux(["capture-pane", "-p", "-t", targetPane, "-S", "-120"]);
  if (capture !== lastCapture) {
    const previousCapture = lastCapture;
    lastCapture = capture;

    if (!isInteractiveProfile(profile) && !isExecProfile(profile)) {
      const parsed = parseCaptureDelta({
        profile,
        previousCapture,
        currentCapture: capture,
        lastSentText
      });

      if (parsed.latestSummary) {
        latestReply = parsed.latestSummary;
      }

      if (profile !== "codex" || codexMode === "interactive") {
        if (parsed.emittedText) {
          await runtime.sendText(undefined, parsed.emittedText);
        }
      }

      if (parsed.promptHint) {
        await emitPromptHint(parsed.promptHint.body, parsed.promptHint.eventType);
      }
    }
  }

  if (isInteractiveProfile(profile)) {
    await pollInteractiveTask(capture);
  }

  if (isExecProfile(profile)) {
    await pollExecTask();
  }

  await emitCompletionIfNeeded(targetPane);
}

async function ensureSessionBound(): Promise<void> {
  const targetPane = await resolvePane();
  await runtime.emitEvent({
    eventType: "task_running",
    body: `Attached to ${sessionName} (${targetPane}).`,
    status: "busy",
    metadata: {
      sessionName,
      paneId: targetPane,
      managed: Boolean(managedCommand),
      profile,
      codexMode: profile === "codex" ? codexMode : undefined
    }
  });
}

async function stopManagedSession(): Promise<void> {
  if (await tmuxExists(sessionName)) {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName], { encoding: "utf8" });
  }
}

function codexBridgeDir(): string {
  return path.join("temp_docs", "codex_bridge", sessionName);
}

async function createExecTask(prompt: string): Promise<ActiveExecTask> {
  const dir = codexBridgeDir();
  await mkdir(dir, { recursive: true });
  const id = `task_${Date.now()}`;
  const promptPath = path.join(dir, `${id}.prompt.txt`);
  const outputPath = path.join(dir, `${id}.reply.txt`);
  const stderrPath = path.join(dir, `${id}.stderr.txt`);
  const statusPath = path.join(dir, `${id}.status.txt`);
  await rm(outputPath, { force: true });
  await rm(stderrPath, { force: true });
  await rm(statusPath, { force: true });
  await writeFile(promptPath, `${prompt}\n`, "utf8");
  const targetPane = await resolvePane();
  const panePath = await tmuxPanePath(targetPane);
  return {
    id,
    prompt,
    workingDir: panePath,
    promptPath,
    outputPath,
    stderrPath,
    statusPath,
    eventId: `stream_${id}`,
    commandPromptPath: relativeShellPath(panePath, promptPath),
    commandOutputPath: relativeShellPath(panePath, outputPath),
    commandStatusPath: relativeShellPath(panePath, statusPath),
    emittedText: "",
    model: await resolveProviderModel(profile)
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function relativeShellPath(fromDir: string, toPath: string): string {
  const relative = path.relative(fromDir, toPath).replaceAll(path.sep, "/");
  return relative || ".";
}

async function dispatchExecPrompt(prompt: string): Promise<void> {
  if (activeExecTask) {
    await runtime.sendText(undefined, `${providerDisplayName(profile)} is still working on the previous request.`);
    return;
  }

  const task = await createExecTask(prompt);
  activeExecTask = task;
  lastUserPrompt = prompt;
  lastSentText = prompt;
  lastPromptKey = "";

  const command = providerExecCommand(profile, task);

  await runtime.emitEvent({
    eventType: "task_running",
    body: `${providerDisplayName(profile)} is working on your request.`,
    status: "busy",
    metadata: {
      model: task.model,
      provider: profile
    }
  });

  try {
    if (profile === "codex" && codexMode === "exec") {
      await startCodexExecTask(task);
      return;
    }

    await sendLiteral(command);
  } catch (error) {
    activeExecTask = undefined;
    throw error;
  }
}

async function dispatchInteractivePrompt(prompt: string): Promise<void> {
  if (activeInteractiveTask) {
    await runtime.sendText(undefined, `${providerDisplayName(profile)} is still working on the previous request.`);
    return;
  }

  activeInteractiveTask = {
    id: `${profile}_${Date.now()}`,
    prompt,
    startedAt: Date.now(),
    model: await resolveProviderModel(profile),
    sawBusy: false
  };
  lastUserPrompt = prompt;
  lastSentText = prompt;
  lastPromptKey = "";

  await runtime.emitEvent({
    eventType: "task_running",
    body: `${providerDisplayName(profile)} is working on your request.`,
    status: "busy",
    metadata: {
      model: activeInteractiveTask.model,
      provider: profile,
      interactive: true
    }
  });

  await sendInteractiveText(prompt);
}

async function sendInteractiveText(prompt: string): Promise<void> {
  const targetPane = await resolvePane();
  if (profile === "qwen" && prompt.startsWith("/")) {
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "-l", prompt], { encoding: "utf8" });
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Tab"], { encoding: "utf8" });
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Enter"], { encoding: "utf8" });
    return;
  }

  await sendLiteral(prompt);
}

async function pollExecTask(): Promise<void> {
  const task = activeExecTask;
  if (!task) {
    return;
  }

  let outputContent = "";
  try {
    outputContent = await readFile(task.outputPath, "utf8");
  } catch {
    outputContent = "";
  }

  const streamSnapshot = parseProviderStream(profile, outputContent);
  if (streamSnapshot.model && streamSnapshot.model != task.model) {
    task.model = streamSnapshot.model;
  }
  const candidateText = latestExecPreview(streamSnapshot);
  if (candidateText) {
    latestReply = candidateText;
  }

  let statusText: string | undefined;
  try {
    statusText = (await readFile(task.statusPath, "utf8")).trim();
  } catch {
    return;
  }

  const exitCode = Number(statusText || "1");
  if (exitCode !== 0 && !latestReply && profile === "codex") {
    try {
      const stderrContent = (await readFile(task.stderrPath, "utf8")).trim();
      if (stderrContent) {
        latestReply = stderrContent;
      }
    } catch {
      // Ignore missing stderr output.
    }
  }
  const metadata = streamMetadata(task, streamSnapshot);
  const completion = buildExecCompletionResult({
    providerName: providerDisplayName(profile),
    eventId: task.eventId,
    emittedText: task.emittedText,
    latestReply,
    prompt: task.prompt,
    exitCode,
    snapshot: streamSnapshot,
    metadata
  });
  task.emittedText = completion.emittedText;
  latestReply = completion.latestReply;

  for (const event of completion.events) {
    await runtime.emitEvent(event);
  }

  activeExecTask = undefined;
}

async function startCodexExecTask(task: ActiveExecTask): Promise<void> {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    ".",
    "--sandbox",
    "workspace-write"
  ];
  if (task.model) {
    args.push("-m", task.model);
  }
  args.push("--json", "-");

  const outputStream = fs.createWriteStream(task.outputPath, { flags: "a" });
  const errorStream = fs.createWriteStream(task.stderrPath, { flags: "a" });
  const child = spawn("codex", args, {
    cwd: task.workingDir,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let finalized = false;
  const finalize = async (code: number): Promise<void> => {
    if (finalized) {
      return;
    }
    finalized = true;
    outputStream.end();
    errorStream.end();
    await Promise.all([
      once(outputStream, "finish"),
      once(errorStream, "finish")
    ]);
    await writeFile(task.statusPath, `${code}\n`, "utf8");
  };

  child.stdout.on("data", (chunk) => {
    outputStream.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errorStream.write(chunk);
  });
  child.once("error", (error) => {
    errorStream.write(`${error.message}\n`);
    void finalize(1);
  });
  child.once("close", (code) => {
    void finalize(code ?? 1);
  });

  child.stdin.end(`${task.prompt}\n`);
}

async function pollInteractiveTask(capture: string): Promise<void> {
  const task = activeInteractiveTask;
  if (!task) {
    return;
  }

  const snapshot = parseInteractiveCapture(profile, capture);
  if (snapshot.model) {
    task.model = snapshot.model;
  }
  let ignoredTransientUi = false;

  // Emit TUI menu if menu items are detected (highest priority)
  if (snapshot.menuItems && snapshot.menuItems.length > 0) {
    const menuId = snapshot.menuId ?? `menu_${Date.now()}`;
    const itemsHash = snapshot.menuItems.map((item) => item.label).join("|");
    if (task.ignoredMenuId === menuId && task.ignoredMenuHash === itemsHash) {
      // Ignore one stale capture after dismiss/select so ready state can surface.
      ignoredTransientUi = true;
    } else {
      const menuTitle = snapshot.menuTitle ?? "Select option";
      const selectedIndex = snapshot.menuItems.findIndex((item) => item.isSelected);
      activeMenuSelectedIndex = selectedIndex >= 0 ? selectedIndex : 0;

      // Only emit if menu changed or new menu
      if (menuId !== activeMenuId || itemsHash !== lastMenuItemsHash) {
        activeMenuId = menuId;
        lastMenuItemsHash = itemsHash;
        latestReply = `${menuTitle}: ${snapshot.menuItems.length} options`;

        await runtime.emitTuiMenu(menuId, menuTitle, snapshot.menuItems.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description
        })));
      }

      activeInteractiveTask = undefined;
      return;
    }
  }

  if (snapshot.dialog) {
    const dialogId = snapshot.dialog.id || `dialog_${Date.now()}`;
    const itemsHash = [
      snapshot.dialog.body ?? "",
      ...snapshot.dialog.actions.map((item) => `${item.id}:${item.label}`)
    ].join("|");
    if (task.ignoredMenuId === dialogId && task.ignoredMenuHash === itemsHash) {
      // Ignore one stale capture after dismiss/select so ready state can surface.
      ignoredTransientUi = true;
    } else {
      if (dialogId !== activeMenuId || itemsHash !== lastMenuItemsHash) {
        activeMenuId = dialogId;
        lastMenuItemsHash = itemsHash;
        activeMenuSelectedIndex = undefined;
        latestReply = snapshot.promptBody ?? snapshot.dialog.title;

        await runtime.emitTuiMenu(
          dialogId,
          snapshot.dialog.title,
          snapshot.dialog.actions.map((item) => ({
            id: item.id,
            label: item.label,
            description: item.description,
            isInput: item.isInput,
            inputPlaceholder: item.inputPlaceholder
          })),
          snapshot.dialog.body
        );
      }

      activeInteractiveTask = undefined;
      return;
    }
  }

  // Only set promptBody if no menu items (menu takes priority)
  if (!ignoredTransientUi && snapshot.promptBody && !snapshot.menuItems?.length) {
    task.promptBody = snapshot.promptBody;
  }

  if (snapshot.busy) {
    task.sawBusy = true;
    return;
  }

  if (!task.sawBusy && Date.now() - task.startedAt < 800) {
    return;
  }

  if (snapshot.finalText) {
    latestReply = snapshot.finalText;
    activeMenuId = undefined;
    lastMenuItemsHash = undefined;
    activeMenuSelectedIndex = undefined;
    await runtime.emitEvent({
      id: task.id,
      eventType: "text_output",
      body: snapshot.finalText,
      metadata: interactiveMetadata(task, snapshot)
    });
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: interactiveMetadata(task, snapshot)
    });
    activeInteractiveTask = undefined;
    return;
  }

  if (task.promptBody) {
    latestReply = task.promptBody;
    activeMenuId = undefined;
    lastMenuItemsHash = undefined;
    activeMenuSelectedIndex = undefined;
    await runtime.emitEvent({
      eventType: "need_user_input",
      body: task.promptBody,
      status: "waiting_input",
      metadata: {
        ...interactiveMetadata(task, snapshot),
        inputMode: "tui",
        supportsSpecialKeys: true,
        keyHints: snapshot.keyHints ?? []
      }
    });
    activeInteractiveTask = undefined;
    return;
  }

  if (snapshot.readyForInput) {
    const completionText = buildCommandCompletionText(providerDisplayName(profile), task.prompt);
    activeMenuId = undefined;
    lastMenuItemsHash = undefined;
    activeMenuSelectedIndex = undefined;
    if (completionText && !task.promptBody) {
      latestReply = completionText;
      await runtime.emitEvent({
        id: task.id,
        eventType: "text_output",
        body: completionText,
        metadata: interactiveMetadata(task, snapshot)
      });
    }
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: {
        ...interactiveMetadata(task, snapshot),
        inputMode: "tui",
        supportsSpecialKeys: true,
        keyHints: snapshot.keyHints ?? []
      }
    });
    activeInteractiveTask = undefined;
    return;
  }

  if (task.sawBusy) {
    const completionText = buildCommandCompletionText(providerDisplayName(profile), task.prompt);
    activeMenuId = undefined;
    lastMenuItemsHash = undefined;
    activeMenuSelectedIndex = undefined;
    if (completionText) {
      latestReply = completionText;
      await runtime.emitEvent({
        id: task.id,
        eventType: "text_output",
        body: completionText,
        metadata: interactiveMetadata(task, snapshot)
      });
    }
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: interactiveMetadata(task, snapshot)
    });
    activeInteractiveTask = undefined;
  }
}

function usesCodexAppServer(): boolean {
  return profile === "codex" && codexMode === "interactive";
}

async function ensureCodexAppClient(): Promise<CodexAppServerClient> {
  if (!usesCodexAppServer()) {
    throw new Error("Codex app-server mode is not enabled.");
  }

  if (!codexAppClient) {
    const targetPane = await resolvePane();
    const panePath = await tmuxPanePath(targetPane);
    const preferredModel = codexImportedModel || await resolveProviderModel(profile);
    codexAppClient = new CodexAppServerClient({
      sessionName,
      workingDir: panePath,
      bridgeDir: codexBridgeDir(),
      preferredModel,
      callbacks: {
        onPendingRequest: async (request) => {
          await emitCodexProcessDelta(request.title, request.body, {
            pendingRequestKind: request.kind
          });
          await emitCodexPendingRequest(request);
        },
        onProcessUpdate: async (update) => {
          await emitCodexProcessDelta(update.title, update.body);
        },
        onAssistantDelta: async (_delta, fullText) => {
          await emitCodexAssistantDelta(fullText);
        },
        onTurnCompleted: async (update) => {
          resetActiveMenuState();
          const processId = activeCodexProcessId;
          const metadata = codexMetadata();
          if (update.status === "failed") {
            latestReply = update.error ?? "Codex request failed.";
            await finishCodexProcess("failed", latestReply);
            await runtime.emitEvent({
              eventType: "task_failed",
              body: latestReply,
              status: "failed",
              metadata: {
                ...metadata,
                processId
              }
            });
          } else {
            const body = update.text || (update.status === "interrupted" ? "Codex stopped the current turn." : undefined);
            await finishCodexProcess(update.status);
            if (body) {
              latestReply = body;
              await runtime.emitEvent({
                eventType: "text_output",
                body,
                metadata: {
                  ...metadata,
                  final: true,
                  processId
                }
              });
            }
          }
          await runtime.emitEvent({
            eventType: "need_user_input",
            status: "waiting_input",
            metadata
          });
        },
        onError: async (message) => {
          latestReply = message;
          await finishCodexProcess("failed", message);
          await runtime.sendText(undefined, message);
        }
      }
    });
    if (codexResumeThreadId || codexForkFromThreadId) {
      await codexAppClient.seedThreadState({
        threadId: codexResumeThreadId,
        forkFromThreadId: codexForkFromThreadId,
        preferredModel,
        currentModel: preferredModel,
        reasoningEffort: codexImportedReasoningEffort,
        approvalPolicy: "on-request"
      });
    }
  }

  await codexAppClient.start();
  return codexAppClient;
}

function codexMetadata(): Record<string, unknown> {
  const status = codexAppClient?.status;
  return {
    provider: "codex",
    interactive: true,
    transport: "app-server",
    model: status?.currentModel ?? status?.preferredModel,
    reasoningEffort: status?.reasoningEffort,
    contextUsedTokens: status?.contextUsedTokens,
    contextWindowTokens: status?.contextWindowTokens,
    threadId: status?.threadId
  };
}

function codexProcessMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...codexMetadata(),
    processId: activeCodexProcessId,
    ...extra
  };
}

async function startCodexProcess(prompt: string): Promise<void> {
  activeCodexProcessId = `codex_process_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeCodexProcessStartedAt = Date.now();
  activeCodexProcessStepCount = 0;
  activeCodexLastAssistantDraft = "";
  await runtime.emitEvent({
    id: `${activeCodexProcessId}_start`,
    eventType: "process_started",
    title: "Codex started",
    body: prompt,
    status: "busy",
    metadata: codexProcessMetadata({
      transient: true,
      phase: "started"
    })
  });
}

async function emitCodexProcessDelta(title: string, body?: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!activeCodexProcessId) {
    return;
  }
  activeCodexProcessStepCount += 1;
  await runtime.emitEvent({
    id: `${activeCodexProcessId}_step_${activeCodexProcessStepCount}`,
    eventType: "process_delta",
    title,
    body,
    status: "busy",
    metadata: codexProcessMetadata({
      transient: true,
      phase: "delta",
      step: activeCodexProcessStepCount,
      ...extra
    })
  });
}

async function emitCodexAssistantDelta(fullText: string): Promise<void> {
  if (!activeCodexProcessId || fullText === activeCodexLastAssistantDraft) {
    return;
  }
  activeCodexLastAssistantDraft = fullText;
  await runtime.emitEvent({
    id: `${activeCodexProcessId}_assistant`,
    eventType: "assistant_delta",
    title: "Draft reply",
    body: fullText,
    status: "busy",
    metadata: codexProcessMetadata({
      transient: true,
      phase: "assistant_delta"
    })
  });
}

async function finishCodexProcess(status: "completed" | "interrupted" | "failed", body?: string): Promise<void> {
  const processId = activeCodexProcessId;
  if (!processId) {
    return;
  }
  const elapsedMs = Math.max(0, Date.now() - activeCodexProcessStartedAt);
  const summary = body ?? [
    status === "completed"
      ? "Codex completed the request."
      : status === "interrupted"
        ? "Codex stopped the request."
        : "Codex failed the request.",
    activeCodexProcessStepCount > 0 ? `${activeCodexProcessStepCount} updates` : undefined,
    `${Math.round(elapsedMs / 1000)}s`
  ].filter(Boolean).join(" · ");

  await runtime.emitEvent({
    id: `${processId}_done`,
    eventType: "process_completed",
    title: status === "failed" ? "Process failed" : "Process completed",
    body: summary,
    status: status === "failed" ? "failed" : "completed",
    metadata: codexProcessMetadata({
      processId,
      phase: "completed",
      processStatus: status,
      elapsedMs,
      stepCount: activeCodexProcessStepCount
    })
  });
  activeCodexProcessId = undefined;
  activeCodexProcessStartedAt = 0;
  activeCodexProcessStepCount = 0;
  activeCodexLastAssistantDraft = "";
}

function formatCodexStatus(): string {
  const status = codexAppClient?.status;
  const goal = status?.goal;
  return [
    `Session: ${sessionName}`,
    `Transport: app-server`,
    status?.threadId ? `Thread: ${status.threadId}` : "Thread: not ready",
    status?.currentModel || status?.preferredModel ? `Model: ${status.currentModel ?? status.preferredModel}` : undefined,
    status?.reasoningEffort ? `Reasoning: ${formatReasoningEffort(status.reasoningEffort)}` : undefined,
    goal ? `Goal: ${goal.objective}` : undefined,
    goal?.status ? `Goal status: ${goal.status}` : undefined,
    goal?.tokenBudget != null ? `Goal token budget: ${goal.tokenBudget}` : undefined,
    `Working directory: ${status?.cwd ?? "unknown"}`,
    status?.approvalPolicy ? `Approval policy: ${status.approvalPolicy}` : undefined,
    status?.contextUsedTokens != null && status?.contextWindowTokens != null
      ? `Context: ${status.contextUsedTokens}/${status.contextWindowTokens}`
      : undefined
  ].filter(Boolean).join("\n");
}

function formatOfficialCodexStatus(status: CodexOfficialStatus): string {
  const account = status.account;
  const rateLimits = status.rateLimits;
  const config = status.config;
  const authMode = stringValue(account?.authMode)
    ?? stringValue(account?.mode)
    ?? stringValue(account?.type)
    ?? stringValue(objectValue(account?.account)?.type);
  const accountEmail = stringValue(account?.email)
    ?? stringValue(account?.userEmail)
    ?? stringValue(account?.accountEmail);
  const plan = stringValue(account?.planType)
    ?? stringValue(account?.chatgptPlanType)
    ?? stringValue(account?.plan);
  const serviceTier = stringValue(config?.serviceTier)
    ?? stringValue(config?.service_tier);
  const rateLimitSummary = formatRateLimitSummary(rateLimits);
  const modelText = [
    status.model,
    status.reasoningEffort ? `reasoning ${status.reasoningEffort}` : undefined
  ].filter(Boolean).join(" (").replace(/\(([^)]*)$/, "($1)");
  const providerText = [
    status.modelProvider,
    status.modelProviderBaseUrl
  ].filter(Boolean).join(" - ");
  const tokenUsage = formatTokenUsage(status);
  const contextWindow = formatContextWindow(status);
  return [
    "Visit https://chatgpt.com/codex/settings/usage for up-to-date information on rate limits and credits",
    modelText ? `Model: ${modelText}` : undefined,
    providerText ? `Model provider: ${providerText}` : undefined,
    `Directory: ${status.cwd}`,
    `Permissions: ${formatPermissions(status)}`,
    status.agentsFile ? `Agents.md: ${status.agentsFile}` : undefined,
    `Account: ${formatAccountStatus(accountEmail, plan, authMode)}`,
    status.collaborationMode ? `Collaboration mode: ${formatStatusValue(status.collaborationMode)}` : undefined,
    status.threadId ? `Session: ${status.threadId}` : undefined,
    tokenUsage ? `Token usage: ${tokenUsage}` : undefined,
    contextWindow ? `Context window: ${contextWindow}` : undefined,
    rateLimitSummary ? `Limits: ${rateLimitSummary}` : "Limits: not available for this account",
    status.approvalPolicy ? `Approval policy: ${status.approvalPolicy}` : undefined,
    status.sandboxPolicy ? `Sandbox: ${status.sandboxPolicy}` : undefined,
    serviceTier ? `Service tier: ${serviceTier}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatPermissions(status: CodexOfficialStatus): string {
  const value = status.permissions ?? status.sandboxPolicy ?? status.approvalPolicy;
  if (status.sandboxPolicy === "danger-full-access" || value === "danger-full-access" || value === "full-access") {
    return "Full Access";
  }
  if (status.sandboxPolicy === "workspace-write") {
    return "Workspace Write";
  }
  if (status.sandboxPolicy === "read-only") {
    return "Read Only";
  }
  return value ? formatStatusValue(value) : "not available";
}

function formatTokenUsage(status: CodexOfficialStatus): string | undefined {
  if (status.contextUsedTokens == null) {
    return undefined;
  }
  return `${formatTokenCount(status.contextUsedTokens)} total`;
}

function formatAccountStatus(accountEmail: string | undefined, plan: string | undefined, authMode: string | undefined): string {
  if (authMode === "apiKey") {
    return "API key configured";
  }
  if (authMode || accountEmail || plan) {
    return [accountEmail, plan, authMode].filter(Boolean).join(" · ");
  }
  return "not available";
}

function formatContextWindow(status: CodexOfficialStatus): string | undefined {
  if (status.contextUsedTokens == null || status.contextWindowTokens == null || status.contextWindowTokens <= 0) {
    return undefined;
  }
  const left = Math.max(0, status.contextWindowTokens - status.contextUsedTokens);
  const percent = Math.round((left / status.contextWindowTokens) * 100);
  return `${percent}% left (${formatTokenCount(status.contextUsedTokens)} used / ${formatTokenCount(status.contextWindowTokens)})`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
}

function formatStatusValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatRateLimitSummary(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const snapshots = [
    ...arrayValue(value.rateLimits),
    ...arrayValue(value.limits),
    ...arrayValue(value.data)
  ].map(objectValue).filter(Boolean);
  if (snapshots.length > 0) {
    return snapshots.slice(0, 3).map((item) => {
      const name = stringValue(item?.limitName) ?? stringValue(item?.name) ?? stringValue(item?.type) ?? "limit";
      const used = numberValue(item?.usedPercent);
      const resetsAt = stringValue(item?.resetsAt) ?? stringValue(item?.resetAt);
      return [
        name,
        used != null ? `${Math.round(used)}% used` : undefined,
        resetsAt ? `resets ${resetsAt}` : undefined
      ].filter(Boolean).join(" ");
    }).join("; ");
  }
  const used = numberValue(value.usedPercent);
  const balance = numberValue(value.balance);
  const hasCredits = typeof value.hasCredits === "boolean" ? value.hasCredits : undefined;
  return [
    used != null ? `${Math.round(used)}% used` : undefined,
    balance != null ? `balance ${balance}` : undefined,
    hasCredits != null ? `credits ${hasCredits ? "available" : "unavailable"}` : undefined
  ].filter(Boolean).join(" · ") || undefined;
}

function formatCodexGoal(goal: { objective: string; status?: string; tokenBudget?: number | null; tokensUsed?: number; timeUsedSeconds?: number } | null): string {
  if (!goal) {
    return "No goal is currently set.";
  }
  return [
    `Objective: ${goal.objective}`,
    goal.status ? `Status: ${goal.status}` : undefined,
    goal.tokensUsed != null ? `Tokens used: ${goal.tokensUsed}` : undefined,
    goal.tokenBudget != null ? `Token budget: ${goal.tokenBudget}` : undefined,
    goal.timeUsedSeconds != null ? `Time used: ${goal.timeUsedSeconds}s` : undefined
  ].filter(Boolean).join("\n");
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Token budget must be a positive integer.");
  }
  return number;
}

function argString(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function clearHubTimeline(): Promise<void> {
  const endpoint = hubUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "/api/sessions/clear-events");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: runtimeAgentId() })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to clear Hub timeline: HTTP ${response.status}`);
  }
}

function runtimeAgentId(): string {
  return process.env.AGENT_ID ?? defaultAgentId(profile, sessionName);
}

async function showCodexReasoningMenu(model: CodexModelOption): Promise<void> {
  pendingCodexModelSelection = model;
  const efforts = model.supportedReasoningEfforts.length > 0
    ? model.supportedReasoningEfforts
    : defaultReasoningEfforts();
  const items = [
    {
      id: "__default__",
      label: model.defaultReasoningEffort
        ? `Default (${formatReasoningEffort(model.defaultReasoningEffort)})`
        : "Default",
      description: "Use Codex default reasoning effort for this model."
    },
    ...efforts.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description
    })),
    {
      id: "__cancel__",
      label: "Cancel"
    }
  ];
  activeMenuId = "codex_reasoning";
  lastMenuItemsHash = items.map((item) => item.id).join("|");
  activeMenuSelectedIndex = undefined;
  latestReply = "Select Codex reasoning effort";
  await runtime.emitTuiMenu(
    "codex_reasoning",
    "Select Reasoning Effort",
    items,
    `Model: ${model.label}`
  );
}

function defaultReasoningEfforts(): Array<{ id: ReasoningEffort; label: string; description?: string }> {
  return ["none", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({
    id: value as ReasoningEffort,
    label: formatReasoningEffort(value as ReasoningEffort)
  }));
}

function parseReasoningEffort(value: string): ReasoningEffort | undefined {
  return value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    ? value
    : undefined;
}

function formatReasoningEffort(value: ReasoningEffort): string {
  return value === "xhigh" ? "X High" : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

async function emitCodexPendingRequest(request: CodexPendingRequest): Promise<void> {
  const menuId = request.requestId;
  if (request.kind === "toolInput") {
    const items: Array<{
      id: string;
      label: string;
      description?: string;
      isInput?: boolean;
      inputPlaceholder?: string;
    }> = request.options.length > 0
      ? request.options.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description
        }))
      : [
          {
            id: "__submit__",
            label: "Submit",
            isInput: true,
            inputPlaceholder: "Enter your response"
          }
        ];
    items.push({
      id: "__cancel__",
      label: "Cancel"
    });
    activeMenuId = menuId;
    lastMenuItemsHash = items.map((item) => item.id).join("|");
    activeMenuSelectedIndex = undefined;
    latestReply = request.body;
    await runtime.emitTuiMenu(menuId, request.title, items, request.body);
    return;
  }

  const items = [
    {
      id: "__allow__",
      label: "Allow"
    },
    ...(request.allowForSession
      ? [{
          id: "__allow_session__",
          label: "Allow for session"
        }]
      : []),
    {
      id: "__cancel__",
      label: "Cancel"
    }
  ];
  activeMenuId = menuId;
  lastMenuItemsHash = items.map((item) => item.id).join("|");
  activeMenuSelectedIndex = undefined;
  latestReply = request.body;
  await runtime.emitTuiMenu(menuId, request.title, items, request.body);
}

async function dispatchCodexAppPrompt(prompt: string): Promise<void> {
  const client = await ensureCodexAppClient();
  if (client.isTurnActive) {
    await runtime.sendText(undefined, "Codex is still working on the previous request.");
    return;
  }

  if (prompt.startsWith("/")) {
    await dispatchCodexSlashCommand(prompt);
    return;
  }

  lastUserPrompt = prompt;
  lastSentText = prompt;
  lastPromptKey = "";
  await startCodexProcess(prompt);
  await runtime.emitEvent({
    eventType: "task_running",
    body: "Codex is working on your request.",
    status: "busy",
    metadata: codexMetadata()
  });
  await client.startTurn(prompt);
}

async function dispatchCodexSlashCommand(prompt: string): Promise<void> {
  const normalized = prompt.trim();
  const client = await ensureCodexAppClient();
  if (normalized === "/status") {
    latestReply = formatOfficialCodexStatus(await client.getOfficialStatus());
    await runtime.sendText("Codex status", latestReply);
    return;
  }

  if (normalized === "/iris-status" || normalized === "/iris_status") {
    await client.getGoal().catch(() => null);
    latestReply = formatCodexStatus();
    await runtime.sendText("AgentLink Codex status", latestReply);
    return;
  }

  if (normalized === "/iris-help") {
    latestReply = [
      "Supported AgentLink Codex commands:",
      "/model - switch Codex model and reasoning effort",
      "/goal <objective> - set or replace the active goal",
      "/goal status - show the active goal",
      "/goal clear - clear the active goal",
      "/rename <name> - rename the current thread",
      "/compact - compact current context",
      "/memory off|on|reset - manage Codex memory",
      "/mcp - show MCP server status",
      "/status - show Codex status",
      "/iris-status - show AgentLink bridge session, thread, model, cwd and context",
      "/iris_status - alias of /iris-status",
      "/iris-new-thread - start a new Codex thread",
      "/iris-clear-history - clear this Hub timeline",
      "/iris-help - show this help"
    ].join("\n");
    await runtime.sendText("Codex commands", latestReply);
    return;
  }

  if (normalized === "/iris-new-thread") {
    await client.startNewThread();
    latestReply = "Started a new Codex thread.";
    await runtime.sendText("Codex thread", latestReply);
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: codexMetadata()
    });
    return;
  }

  if (normalized === "/iris-clear-history") {
    await clearHubTimeline();
    latestReply = "Cleared this Hub timeline. Codex thread context was not reset.";
    await runtime.sendText("Timeline cleared", latestReply);
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: codexMetadata()
    });
    return;
  }

  const goalMatch = normalized.match(/^\/goal(?:\s+(.*))?$/);
  if (goalMatch) {
    const value = (goalMatch[1] ?? "").trim();
    if (!value || value === "status") {
      const goal = await client.getGoal();
      latestReply = formatCodexGoal(goal);
      await runtime.sendText("Codex goal", latestReply);
      return;
    }
    if (value === "clear") {
      const cleared = await client.clearGoal();
      latestReply = cleared ? "Cleared Codex goal." : "No goal was set.";
      await runtime.emitEvent({
        eventType: "text_output",
        body: latestReply,
        metadata: codexMetadata()
      });
      await runtime.emitEvent({
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: codexMetadata()
      });
      return;
    }
    const goal = await client.setGoal(value);
    latestReply = formatCodexGoal(goal);
    await runtime.emitEvent({
      eventType: "text_output",
      body: latestReply,
      metadata: codexMetadata()
    });
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: codexMetadata()
    });
    return;
  }

  const renameMatch = normalized.match(/^\/rename(?:\s+(.*))?$/);
  if (renameMatch) {
    const name = (renameMatch[1] ?? "").trim();
    if (!name) {
      await runtime.sendText(undefined, "Usage: /rename <thread name>");
      return;
    }
    await client.setThreadName(name);
    latestReply = `Renamed Codex thread to ${name}.`;
    await runtime.sendText("Codex thread", latestReply);
    return;
  }

  if (normalized === "/compact") {
    await client.compactThread();
    latestReply = "Started Codex context compaction.";
    await runtime.emitEvent({
      eventType: "task_running",
      body: latestReply,
      status: "busy",
      metadata: codexMetadata()
    });
    return;
  }

  const memoryMatch = normalized.match(/^\/memory(?:\s+(.*))?$/);
  if (memoryMatch) {
    const action = (memoryMatch[1] ?? "").trim();
    if (action === "reset") {
      await client.resetMemory();
      latestReply = "Reset Codex local memories.";
    } else if (action === "on" || action === "enable") {
      await client.setMemoryMode(true);
      latestReply = "Enabled Codex memory for this thread.";
    } else if (action === "off" || action === "disable") {
      await client.setMemoryMode(false);
      latestReply = "Disabled Codex memory for this thread.";
    } else {
      await runtime.sendText(undefined, "Usage: /memory on|off|reset");
      return;
    }
    await runtime.emitEvent({
      eventType: "text_output",
      body: latestReply,
      metadata: codexMetadata()
    });
    return;
  }

  if (normalized === "/mcp" || normalized === "/mcp status") {
    const servers = await client.listMcpServerStatus();
    latestReply = servers.length > 0
      ? servers.map((item) => [item.name, item.status, item.details].filter(Boolean).join(" · ")).join("\n")
      : "No MCP servers reported by Codex.";
    await runtime.sendText("Codex MCP status", latestReply);
    return;
  }

  if (normalized !== "/model") {
    await runtime.sendText(undefined, "Unsupported Codex command. Use /iris-help for the mobile command list.");
    return;
  }

  const models = await client.listModels();
  if (models.length === 0) {
    await runtime.sendText(undefined, "Codex did not return any selectable models.");
    return;
  }

  codexModelMenuItems = models;
  pendingCodexModelSelection = undefined;
  activeMenuId = "codex_model";
  lastMenuItemsHash = codexModelMenuItems.map((item) => item.id).join("|");
  activeMenuSelectedIndex = models.findIndex((item) =>
    item.id === client.status.currentModel || item.id === client.status.preferredModel
  );
  latestReply = "Select Codex model";
  await runtime.emitTuiMenu(
    "codex_model",
    "Select Model",
    codexModelMenuItems.map((item) => ({
      id: item.id,
      label: item.label,
      description: [
        item.description,
        item.defaultReasoningEffort ? `Default reasoning: ${formatReasoningEffort(item.defaultReasoningEffort)}` : undefined
      ].filter(Boolean).join("\n") || undefined
    }))
  );
}

async function dispatchCodexStructuredCommand(args: Record<string, unknown>): Promise<void> {
  const client = await ensureCodexAppClient();
  const name = typeof args.codexCommand === "string" ? args.codexCommand : "";
  switch (name) {
    case "status":
      latestReply = formatOfficialCodexStatus(await client.getOfficialStatus());
      await runtime.sendText("Codex status", latestReply);
      return;
    case "model.list": {
      const models = await client.listModels();
      await runtime.emitEvent({
        eventType: "text_output",
        body: JSON.stringify({
          models,
          currentModel: client.status.currentModel ?? client.status.preferredModel,
          reasoningEffort: client.status.reasoningEffort
        }),
        metadata: {
          ...codexMetadata(),
          structured: true,
          codexCommand: name
        }
      });
      return;
    }
    case "model.set": {
      const model = argString(args, "model");
      if (!model) {
        throw new Error("Model is required.");
      }
      const effort = parseReasoningEffort(argString(args, "reasoningEffort"));
      await client.setPreferredModel(model);
      await client.setReasoningEffort(effort);
      latestReply = [
        `Codex model set to ${model}.`,
        effort ? `Reasoning effort set to ${formatReasoningEffort(effort)}.` : "Reasoning effort set to model default."
      ].join("\n");
      await runtime.emitEvent({
        eventType: "text_output",
        body: latestReply,
        metadata: codexMetadata()
      });
      await runtime.emitEvent({
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: codexMetadata()
      });
      return;
    }
    case "model.select":
      await dispatchCodexSlashCommand("/model");
      return;
    case "goal.get": {
      const goal = await client.getGoal();
      latestReply = formatCodexGoal(goal);
      await runtime.sendText("Codex goal", latestReply);
      return;
    }
    case "goal.set": {
      const objective = argString(args, "objective");
      const goal = await client.setGoal(objective, parsePositiveInteger(args.tokenBudget));
      latestReply = formatCodexGoal(goal);
      await runtime.emitEvent({
        eventType: "text_output",
        body: latestReply,
        metadata: codexMetadata()
      });
      await runtime.emitEvent({
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: codexMetadata()
      });
      return;
    }
    case "goal.clear": {
      const cleared = await client.clearGoal();
      latestReply = cleared ? "Cleared Codex goal." : "No goal was set.";
      await runtime.emitEvent({
        eventType: "text_output",
        body: latestReply,
        metadata: codexMetadata()
      });
      await runtime.emitEvent({
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: codexMetadata()
      });
      return;
    }
    case "goal":
      await dispatchCodexSlashCommand("/goal status");
      return;
    case "thread.rename": {
      const nameValue = argString(args, "name");
      await client.setThreadName(nameValue);
      latestReply = `Renamed Codex thread to ${nameValue}.`;
      await runtime.sendText("Codex thread", latestReply);
      return;
    }
    case "thread.compact":
      await client.compactThread();
      latestReply = "Started Codex context compaction.";
      await runtime.emitEvent({
        eventType: "task_running",
        body: latestReply,
        status: "busy",
        metadata: codexMetadata()
      });
      return;
    case "memory.mode": {
      const enabled = args.enabled === true;
      await client.setMemoryMode(enabled);
      latestReply = enabled ? "Enabled Codex memory for this thread." : "Disabled Codex memory for this thread.";
      await runtime.emitEvent({
        eventType: "text_output",
        body: latestReply,
        metadata: codexMetadata()
      });
      return;
    }
    case "memory.reset":
      await client.resetMemory();
      latestReply = "Reset Codex local memories.";
      await runtime.emitEvent({
        eventType: "text_output",
        body: latestReply,
        metadata: codexMetadata()
      });
      return;
    case "memory":
      await runtime.sendText("Codex memory", "Use /memory on, /memory off, or /memory reset.");
      return;
    case "mcp.status": {
      const servers = await client.listMcpServerStatus();
      latestReply = servers.length > 0
        ? servers.map((item) => [item.name, item.status, item.details].filter(Boolean).join(" · ")).join("\n")
        : "No MCP servers reported by Codex.";
      await runtime.sendText("Codex MCP status", latestReply);
      return;
    }
    default:
      await runtime.sendText(undefined, "Unsupported Codex structured command.");
  }
}

runtime.onCommand(async (command) => {
  if (usesCodexAppServer()) {
    const client = await ensureCodexAppClient();
    switch (command.type) {
      case "status": {
        const status = client.status;
        await runtime.sendText(
          undefined,
          latestReply || [
            `Attached to ${sessionName}.`,
            status.threadId ? `Thread: ${status.threadId}` : undefined,
            status.currentModel || status.preferredModel ? `Model: ${status.currentModel ?? status.preferredModel}` : undefined,
            status.contextUsedTokens && status.contextWindowTokens
              ? `Context: ${status.contextUsedTokens}/${status.contextWindowTokens}`
              : undefined
          ].filter(Boolean).join("\n")
        );
        return;
      }
      case "stop":
        if (await client.interruptActiveTurn()) {
          await runtime.emitEvent({
            eventType: "task_running",
            body: "Stopping Codex turn.",
            status: "busy",
            metadata: codexMetadata()
          });
        } else {
          await runtime.sendText(undefined, "Codex is already idle.");
        }
        return;
      case "retry":
        if (!lastUserPrompt) {
          await runtime.sendText(undefined, "Nothing to retry yet.");
          return;
        }
        await dispatchCodexAppPrompt(lastUserPrompt);
        return;
      case "approve":
        if (await client.approvePendingRequest(command.text?.trim() === "session" ? "session" : "turn")) {
          resetActiveMenuState();
          await runtime.emitEvent({
            eventType: "task_running",
            body: "Codex is continuing the current request.",
            status: "busy",
            metadata: codexMetadata()
          });
        } else {
          await runtime.sendText(undefined, "No pending Codex approval request.");
        }
        return;
      case "send_text":
        if (!command.text?.trim()) {
          await runtime.sendText(undefined, "Please send a non-empty instruction.");
          return;
        }
        await dispatchCodexAppPrompt(command.text.trim());
        return;
      case "send_key":
        await runtime.sendText(undefined, "Special keys are not used in Codex app-server mode.");
        return;
      case "custom":
        await dispatchCodexStructuredCommand(command.args ?? {});
        return;
    }
  }

  const targetPane = await resolvePane();

  if (isInteractiveProfile(profile)) {
    switch (command.type) {
      case "status":
        await runtime.sendText(
          undefined,
          latestReply || (activeInteractiveTask
            ? `${providerDisplayName(profile)} is still working on the current request.`
            : `Attached to ${sessionName} (${targetPane}). Waiting for a prompt.`)
        );
        return;
      case "stop":
        await execFileAsync("tmux", ["send-keys", "-t", targetPane, "C-c"], { encoding: "utf8" });
        activeInteractiveTask = undefined;
        await runtime.emitEvent({
          eventType: "need_user_input",
          status: "waiting_input",
          metadata: {
            provider: profile,
            interactive: true
          }
        });
        return;
      case "retry":
        if (!lastUserPrompt) {
          await runtime.sendText(undefined, "Nothing to retry yet.");
          return;
        }
        await dispatchInteractivePrompt(lastUserPrompt);
        return;
      case "approve": {
        const text = command.text ?? approveText;
        lastSentText = text;
        await sendLiteral(text);
        return;
      }
      case "send_text":
        if (!command.text?.trim()) {
          await runtime.sendText(undefined, "Please send a non-empty instruction.");
          return;
        }
        await dispatchInteractivePrompt(command.text.trim());
        return;
      case "send_key":
        try {
          await sendKey(command.args ?? {});
          if (!activeInteractiveTask) {
            beginInteractiveFollowUp(`Special key: ${JSON.stringify(command.args ?? {})}`);
          }
        } catch (error) {
          await runtime.sendText(
            undefined,
            error instanceof Error ? error.message : "Failed to send special key."
          );
        }
        return;
    }
  }

  if (isExecProfile(profile)) {
    switch (command.type) {
      case "status":
        await runtime.sendText(
          undefined,
          latestReply || (activeExecTask
            ? `${providerDisplayName(profile)} is still working on the current request.`
            : `Attached to ${sessionName} (${targetPane}). Waiting for a prompt.`)
        );
        return;
      case "stop":
        if (activeExecTask) {
          await execFileAsync("tmux", ["send-keys", "-t", targetPane, "C-c"], { encoding: "utf8" });
          activeExecTask = undefined;
        } else if (managedCommand) {
          await stopManagedSession();
        }
        return;
      case "retry":
        if (!lastUserPrompt) {
          await runtime.sendText(undefined, "Nothing to retry yet.");
          return;
        }
        await dispatchExecPrompt(lastUserPrompt);
        return;
      case "approve":
        await runtime.sendText(undefined, `Approve is not used in ${providerDisplayName(profile)} prompt mode.`);
        return;
      case "send_text":
        if (!command.text?.trim()) {
          await runtime.sendText(undefined, "Please send a non-empty instruction.");
          return;
        }
        await dispatchExecPrompt(command.text.trim());
        return;
      case "send_key":
        try {
          await sendKey(command.args ?? {});
        } catch (error) {
          await runtime.sendText(
            undefined,
            error instanceof Error ? error.message : "Failed to send special key."
          );
        }
        return;
    }
  }

  switch (command.type) {
    case "status":
      await runtime.sendText(
        undefined,
        latestReply || `Attached to ${sessionName} (${targetPane}). Waiting for new output.`
      );
      break;
    case "stop":
      if (managedCommand) {
        await stopManagedSession();
      } else {
        await execFileAsync("tmux", ["send-keys", "-t", targetPane, "C-c"], { encoding: "utf8" });
      }
      break;
    case "retry":
      if (!managedCommand) {
        await runtime.sendText(undefined, "Retry requires a managed TMUX_COMMAND session.");
        break;
      }
      await stopManagedSession();
      paneId = undefined;
      lastCapture = "";
      lastPromptKey = "";
      lastDeadState = "0";
      latestReply = "";
      await ensureSessionBound();
      break;
    case "approve": {
      const text = command.text ?? approveText;
      lastSentText = text;
      await sendLiteral(text);
      break;
    }
    case "send_text": {
      const text = command.text ?? "";
      lastSentText = text;
      await sendLiteral(text);
      break;
    }
    case "send_key":
      try {
        await sendKey(command.args ?? {});
      } catch (error) {
        await runtime.sendText(
          undefined,
          error instanceof Error ? error.message : "Failed to send special key."
        );
      }
      break;
  }
});

runtime.onTuiMenuSelect(async (select) => {
  if (usesCodexAppServer()) {
    const client = await ensureCodexAppClient();
    if (select.menuId !== activeMenuId) {
      await runtime.sendText(undefined, "Menu selection timed out or menu changed.");
      return;
    }

    if (select.menuId === "codex_model") {
      if (select.itemId === "__cancel__") {
        resetActiveMenuState();
        await runtime.emitEvent({
          eventType: "need_user_input",
          status: "waiting_input",
          metadata: codexMetadata()
        });
        return;
      }
      const selected = codexModelMenuItems.find((item) => item.id === select.itemId);
      if (!selected) {
        await runtime.sendText(undefined, "Invalid Codex model selected.");
        return;
      }
      await showCodexReasoningMenu(selected);
      return;
    }

    if (select.menuId === "codex_reasoning") {
      if (select.itemId === "__cancel__") {
        pendingCodexModelSelection = undefined;
        resetActiveMenuState();
        await runtime.emitEvent({
          eventType: "need_user_input",
          status: "waiting_input",
          metadata: codexMetadata()
        });
        return;
      }
      const selected = pendingCodexModelSelection;
      if (!selected) {
        await runtime.sendText(undefined, "Model selection timed out or menu changed.");
        return;
      }
      const effort = select.itemId === "__default__"
        ? selected.defaultReasoningEffort
        : parseReasoningEffort(select.itemId);
      if (select.itemId !== "__default__" && !effort) {
        await runtime.sendText(undefined, "Invalid Codex reasoning effort selected.");
        return;
      }
      await client.setPreferredModel(selected.id);
      await client.setReasoningEffort(effort);
      latestReply = [
        `Codex model set to ${selected.label}.`,
        effort ? `Reasoning effort set to ${formatReasoningEffort(effort)}.` : "Reasoning effort set to model default."
      ].join("\n");
      pendingCodexModelSelection = undefined;
      resetActiveMenuState();
      await runtime.emitEvent({
        eventType: "text_output",
        body: latestReply,
        metadata: codexMetadata()
      });
      await runtime.emitEvent({
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: codexMetadata()
      });
      return;
    }

    const pendingRequest = client.getPendingRequest();
    if (!pendingRequest || pendingRequest.requestId !== select.menuId) {
      await runtime.sendText(undefined, "Codex request is no longer pending.");
      return;
    }

    if (pendingRequest.kind === "toolInput") {
      if (select.itemId === "__cancel__") {
        await client.declinePendingRequest();
        resetActiveMenuState();
        await runtime.emitEvent({
          eventType: "task_running",
          body: "Codex is continuing the current request.",
          status: "busy",
          metadata: codexMetadata()
        });
        return;
      }
      if (select.itemId === "__submit__") {
        await client.answerPendingInput(select.inputValue ?? "");
      } else {
        await client.selectPendingOption(select.itemId);
      }
      resetActiveMenuState();
      await runtime.emitEvent({
        eventType: "task_running",
        body: "Codex is continuing the current request.",
        status: "busy",
        metadata: codexMetadata()
      });
      return;
    }

    if (select.itemId === "__cancel__") {
      await client.declinePendingRequest();
    } else if (select.itemId === "__allow_session__") {
      await client.approvePendingRequest("session");
    } else if (select.itemId === "__allow__") {
      await client.approvePendingRequest("turn");
    } else {
      await runtime.sendText(undefined, "Invalid Codex approval action.");
      return;
    }
    resetActiveMenuState();
    await runtime.emitEvent({
      eventType: "task_running",
      body: "Codex is continuing the current request.",
      status: "busy",
      metadata: codexMetadata()
    });
    return;
  }

  const targetPane = await resolvePane();

  if (select.menuId !== activeMenuId) {
    await runtime.sendText(undefined, "Menu selection timed out or menu changed.");
    return;
  }

  if (select.itemId === "__cancel__") {
    const ignoredMenuHash = lastMenuItemsHash;
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Escape"], { encoding: "utf8" });
    resetActiveMenuState();
    beginInteractiveFollowUp(`Dialog cancel: ${select.menuId}`, select.menuId, ignoredMenuHash);
    return;
  }

  if (select.itemId === "__confirm__") {
    const ignoredMenuHash = lastMenuItemsHash;
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Enter"], { encoding: "utf8" });
    resetActiveMenuState();
    beginInteractiveFollowUp(`Dialog confirm: ${select.menuId}`, select.menuId, ignoredMenuHash);
    return;
  }

  if (select.itemId === "__submit__") {
    const ignoredMenuHash = lastMenuItemsHash;
    const inputValue = select.inputValue?.trim();
    if (!inputValue) {
      await runtime.sendText(undefined, "Please enter a value before submitting.");
      return;
    }
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "-l", inputValue], { encoding: "utf8" });
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Enter"], { encoding: "utf8" });
    resetActiveMenuState();
    beginInteractiveFollowUp(`Dialog submit: ${select.menuId}`, select.menuId, ignoredMenuHash);
    return;
  }

  // Find selected item index and navigate to it
  const itemIndex = parseInt(select.itemId.replace("item_", ""), 10);
  if (itemIndex < 0) {
    await runtime.sendText(undefined, "Invalid menu item selected.");
    return;
  }

  const currentIndex = activeMenuSelectedIndex ?? 0;
  const moveKey = itemIndex >= currentIndex ? "Down" : "Up";
  for (let step = 0; step < Math.abs(itemIndex - currentIndex); step += 1) {
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, moveKey], { encoding: "utf8" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Press Enter to select
  await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Enter"], { encoding: "utf8" });

  // Clear menu state
  const ignoredMenuHash = lastMenuItemsHash;
  resetActiveMenuState();
  beginInteractiveFollowUp(`Menu selection: ${select.itemId}`, select.menuId, ignoredMenuHash);
});

runtime.connect()
  .then(async () => {
    if (usesCodexAppServer()) {
      await ensureCodexAppClient();
      await runtime.emitEvent({
        eventType: "task_running",
        body: `Attached to ${sessionName}.`,
        status: "busy",
        metadata: {
          sessionName,
          profile,
          codexMode,
          transport: "app-server"
        }
      });
      await runtime.emitEvent({
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: codexMetadata()
      });
      return;
    }
    await ensureSessionBound();
    await capturePane();
    poller = setInterval(() => {
      capturePane().catch((error) => {
        console.error("tmux poll failed", error);
      });
    }, pollIntervalMs);
  })
  .catch((error) => {
    console.error("tmux agent failed", error);
    process.exit(1);
  });

async function shutdown(): Promise<void> {
  if (poller) {
    clearInterval(poller);
  }
  if (codexAppClient) {
    await codexAppClient.close();
    codexAppClient = undefined;
  }
  await runtime.close();
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

function defaultDisplayName(currentSessionName: string): string {
  return currentSessionName;
}

function defaultKind(currentProfile: BridgeProfile): string {
  if (currentProfile === "opencode" || currentProfile === "codex" || currentProfile === "copilot" || currentProfile === "qwen") {
    return currentProfile;
  }
  return "tmux";
}

function defaultAgentId(currentProfile: BridgeProfile, currentSessionName: string): string {
  if (currentProfile === "opencode" || currentProfile === "codex" || currentProfile === "copilot" || currentProfile === "qwen") {
    return currentSessionName;
  }
  return `tmux-${currentSessionName}`;
}

function defaultManagedCommand(currentProfile: BridgeProfile, currentCodexMode: CodexMode): string | undefined {
  if (currentProfile === "opencode") {
    return buildOpenCodeInteractiveCommand();
  }
  if (currentProfile === "codex") {
    return "sh";
  }
  if (currentProfile === "copilot") {
    return "copilot --allow-all";
  }
  if (currentProfile === "qwen") {
    return "qwen";
  }
  return undefined;
}

function isExecProfile(currentProfile: BridgeProfile): boolean {
  return currentProfile === "codex" && codexMode === "exec";
}

function isInteractiveProfile(currentProfile: BridgeProfile): boolean {
  return currentProfile === "opencode"
    || currentProfile === "copilot"
    || currentProfile === "qwen"
    || (currentProfile === "codex" && codexMode === "interactive");
}

function providerDisplayName(currentProfile: BridgeProfile): string {
  return currentProfile === "opencode"
    ? "OpenCode"
    : currentProfile === "codex"
      ? "Codex"
      : currentProfile === "copilot"
        ? "Copilot"
        : currentProfile === "qwen"
          ? "Qwen"
          : "Agent";
}

function providerExecCommand(currentProfile: BridgeProfile, task: ActiveExecTask): string {
  if (currentProfile === "opencode") {
    const userHome = process.env.IRIS_USER_HOME?.trim();
    if (!userHome) {
      throw new Error("opencode home is not configured");
    }
    const preferredExecutable = path.join(userHome, ".opencode", "bin", "opencode");
    const executable = fs.existsSync(preferredExecutable) ? preferredExecutable : "opencode";
    return [
      `prompt=$(cat ${shellQuote(task.commandPromptPath)})`,
      [
        `HOME=${shellQuote(userHome)}`,
        shellQuote(executable),
        "run \"$prompt\"",
        task.model ? `--model ${shellQuote(task.model)}` : "",
        "--format json",
        "--dir .",
        "--print-logs"
      ].join(" ") + ` > ${shellQuote(task.commandOutputPath)} 2>&1`,
      `printf '%s\\n' $? > ${shellQuote(task.commandStatusPath)}`
    ].join("; ");
  }

  if (currentProfile === "codex") {
    return [
      [
        "codex exec",
        "--skip-git-repo-check",
        "-C .",
        "--sandbox workspace-write",
        task.model ? `-m ${shellQuote(task.model)}` : "",
        "--json -"
      ].filter(Boolean).join(" ") + ` < ${shellQuote(task.commandPromptPath)} > ${shellQuote(task.commandOutputPath)}`,
      `printf '%s\\n' $? > ${shellQuote(task.commandStatusPath)}`
    ].join("; ");
  }

  if (currentProfile === "copilot") {
    return [
      `prompt=$(cat ${shellQuote(task.commandPromptPath)})`,
      [
        "copilot",
        task.model ? `--model ${shellQuote(task.model)}` : "",
        "-p \"$prompt\"",
        "--allow-all",
        "--add-dir .",
        "--output-format json",
        "--stream on"
      ].filter(Boolean).join(" ") + ` > ${shellQuote(task.commandOutputPath)}`,
      `printf '%s\\n' $? > ${shellQuote(task.commandStatusPath)}`
    ].join("; ");
  }

  if (currentProfile === "qwen") {
    return [
      `prompt=$(cat ${shellQuote(task.commandPromptPath)})`,
      [
        "qwen",
        task.model ? `-m ${shellQuote(task.model)}` : "",
        "-p \"$prompt\"",
        "--yolo",
        "--add-dir .",
        "-o stream-json",
        "--include-partial-messages"
      ].filter(Boolean).join(" ") + ` > ${shellQuote(task.commandOutputPath)}`,
      `printf '%s\\n' $? > ${shellQuote(task.commandStatusPath)}`
    ].join("; ");
  }

  throw new Error(`unsupported exec profile: ${currentProfile}`);
}

function streamMetadata(task: ActiveExecTask, snapshot: ReturnType<typeof parseProviderStream>): Record<string, unknown> {
  return {
    model: snapshot.model ?? task.model,
    provider: profile,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    totalTokens: snapshot.totalTokens,
    cachedInputTokens: snapshot.cachedInputTokens,
    reasoningTokens: snapshot.reasoningTokens,
    contextUsedTokens: snapshot.contextUsedTokens,
    contextWindowTokens: snapshot.contextWindowTokens
  };
}

function buildOpenCodeInteractiveCommand(): string {
  const explicitModel = process.env.TMUX_PROVIDER_MODEL?.trim() || process.env.OPENCODE_MODEL?.trim();
  const userHome = process.env.IRIS_USER_HOME?.trim() || process.env.HOME?.trim() || homedir();
  const preferredExecutable = path.join(userHome, ".opencode", "bin", "opencode");
  const executable = fs.existsSync(preferredExecutable) ? preferredExecutable : "opencode";
  return [
    `HOME=${shellQuote(userHome)}`,
    shellQuote(executable),
    ".",
    explicitModel ? `--model ${shellQuote(explicitModel)}` : ""
  ].filter(Boolean).join(" ");
}

function interactiveMetadata(
  task: ActiveInteractiveTask,
  capture: ReturnType<typeof parseInteractiveCapture>
): Record<string, unknown> {
  return {
    model: capture.model ?? task.model,
    provider: profile,
    contextUsedTokens: capture.contextUsedTokens,
    contextWindowTokens: capture.contextWindowTokens,
    interactive: true
  };
}

function resetActiveMenuState(): void {
  activeMenuId = undefined;
  lastMenuItemsHash = undefined;
  activeMenuSelectedIndex = undefined;
}

function beginInteractiveFollowUp(prompt: string, ignoredMenuId?: string, ignoredMenuHash?: string): void {
  activeInteractiveTask = {
    id: `menu_select_${Date.now()}`,
    prompt,
    startedAt: Date.now(),
    sawBusy: false,
    ignoredMenuId,
    ignoredMenuHash
  };
}

function buildCommandCompletionText(providerName: string, prompt: string): string | undefined {
  const normalized = prompt.trim();
  if (!normalized.startsWith("/")) {
    return undefined;
  }
  return `${providerName} finished ${normalized}.`;
}
