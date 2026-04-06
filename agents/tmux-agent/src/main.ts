import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";
import type { SlashCommandNode, TuiMenuSelect } from "../../../packages/protocol/src/index.js";
import { buildExecCompletionResult, latestExecPreview } from "./exec-delivery.js";
import { resolveProviderModel } from "./model-resolver.js";
import {
  parseOpenCodeInteractiveCapture,
} from "./opencode-interactive.js";
import { parseCaptureDelta, type BridgeProfile } from "./parser.js";
import { parseProviderStream } from "./stream-parser.js";
import { buildTmuxKeySendSpec } from "./tmux-keys.js";

const execFileAsync = promisify(execFile);

type CodexMode = "exec" | "interactive";
type ActiveExecTask = {
  id: string;
  prompt: string;
  promptPath: string;
  outputPath: string;
  statusPath: string;
  eventId: string;
  commandPromptPath: string;
  commandOutputPath: string;
  commandStatusPath: string;
  emittedText: string;
  model?: string;
};

type ActiveOpenCodeTask = {
  id: string;
  prompt: string;
  startedAt: number;
  model?: string;
  promptBody?: string;
  sawBusy: boolean;
};

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const profile = (process.env.TMUX_BRIDGE_PROFILE ?? "generic") as BridgeProfile;
const codexMode = ((process.env.TMUX_CODEX_MODE ?? "exec") as CodexMode);
const sessionName = process.env.TMUX_SESSION ?? "iris-agent";
const managedCommand = process.argv.slice(2).join(" ") || process.env.TMUX_COMMAND || defaultManagedCommand(profile, codexMode);
const pollIntervalMs = Number(process.env.TMUX_POLL_MS ?? 1000);
const approveText = process.env.TMUX_APPROVE_TEXT ?? "y";

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
  { id: "model", label: "Model", description: "Switch model", commandType: "send_text" },
  { id: "hooks", label: "Hooks", description: "Manage hooks", commandType: "send_text" }
];

const codexNativeCommands: SlashCommandNode[] = [
  { id: "model", label: "Model", description: "Switch model", commandType: "send_text" }
];

const copilotNativeCommands: SlashCommandNode[] = [
  { id: "model", label: "Model", description: "Switch model", commandType: "send_text" },
  { id: "compact", label: "Compact", description: "Compress context", commandType: "send_text" },
  { id: "context", label: "Context", description: "View context", commandType: "send_text" },
  { id: "session", label: "Session", description: "Session management", commandType: "send_text" }
];

function buildSlashCommands(currentProfile: BridgeProfile): SlashCommandNode[] {
  return currentProfile === "opencode"
    ? opencodeNativeCommands
    : currentProfile === "qwen"
      ? qwenNativeCommands
      : currentProfile === "codex"
        ? codexNativeCommands
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
let activeOpenCodeTask: ActiveOpenCodeTask | undefined;
let activeMenuId: string | undefined;
let lastMenuItemsHash: string | undefined;
let activeMenuSelectedIndex: number | undefined;

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

    if (profile !== "opencode" && !isExecProfile(profile)) {
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

  if (profile === "opencode") {
    await pollOpenCodeInteractiveTask(capture);
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
  const statusPath = path.join(dir, `${id}.status.txt`);
  await rm(outputPath, { force: true });
  await rm(statusPath, { force: true });
  await writeFile(promptPath, `${prompt}\n`, "utf8");
  const targetPane = await resolvePane();
  const panePath = await tmuxPanePath(targetPane);
  return {
    id,
    prompt,
    promptPath,
    outputPath,
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

  await sendLiteral(command);
}

async function dispatchOpenCodePrompt(prompt: string): Promise<void> {
  if (activeOpenCodeTask) {
    await runtime.sendText(undefined, "OpenCode is still working on the previous request.");
    return;
  }

  const targetPane = await resolvePane();
  activeOpenCodeTask = {
    id: `opencode_${Date.now()}`,
    prompt,
    startedAt: Date.now(),
    model: await resolveProviderModel("opencode"),
    sawBusy: false
  };
  lastUserPrompt = prompt;
  lastSentText = prompt;
  lastPromptKey = "";

  await runtime.emitEvent({
    eventType: "task_running",
    body: "OpenCode is working on your request.",
    status: "busy",
    metadata: {
      model: activeOpenCodeTask.model,
      provider: "opencode",
      interactive: true
    }
  });

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

async function pollOpenCodeInteractiveTask(capture: string): Promise<void> {
  const task = activeOpenCodeTask;
  if (!task) {
    return;
  }

  const snapshot = parseOpenCodeInteractiveCapture(capture);
  if (snapshot.model) {
    task.model = snapshot.model;
  }

  // Emit TUI menu if menu items are detected (highest priority)
  if (snapshot.menuItems && snapshot.menuItems.length > 0) {
    const menuId = snapshot.menuId ?? `menu_${Date.now()}`;
    const itemsHash = snapshot.menuItems.map((item) => item.label).join("|");
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

    activeOpenCodeTask = undefined;
    return;
  }

  if (snapshot.dialog) {
    const dialogId = snapshot.dialog.id || `dialog_${Date.now()}`;
    const itemsHash = [
      snapshot.dialog.body ?? "",
      ...snapshot.dialog.actions.map((item) => `${item.id}:${item.label}`)
    ].join("|");

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

    activeOpenCodeTask = undefined;
    return;
  }

  // Only set promptBody if no menu items (menu takes priority)
  if (snapshot.promptBody && !snapshot.menuItems?.length) {
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
      metadata: openCodeMetadata(task, snapshot)
    });
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: openCodeMetadata(task, snapshot)
    });
    activeOpenCodeTask = undefined;
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
        ...openCodeMetadata(task, snapshot),
        inputMode: "tui",
        supportsSpecialKeys: true,
        keyHints: snapshot.keyHints ?? []
      }
    });
    activeOpenCodeTask = undefined;
    return;
  }

  if (snapshot.readyForInput) {
    const completionText = buildCommandCompletionText("OpenCode", task.prompt);
    activeMenuId = undefined;
    lastMenuItemsHash = undefined;
    activeMenuSelectedIndex = undefined;
    if (completionText && !task.promptBody) {
      latestReply = completionText;
      await runtime.emitEvent({
        id: task.id,
        eventType: "text_output",
        body: completionText,
        metadata: openCodeMetadata(task, snapshot)
      });
    }
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: {
        ...openCodeMetadata(task, snapshot),
        inputMode: "tui",
        supportsSpecialKeys: true,
        keyHints: snapshot.keyHints ?? []
      }
    });
    activeOpenCodeTask = undefined;
    return;
  }

  if (task.sawBusy) {
    const completionText = buildCommandCompletionText("OpenCode", task.prompt);
    activeMenuId = undefined;
    lastMenuItemsHash = undefined;
    activeMenuSelectedIndex = undefined;
    if (completionText) {
      latestReply = completionText;
      await runtime.emitEvent({
        id: task.id,
        eventType: "text_output",
        body: completionText,
        metadata: openCodeMetadata(task, snapshot)
      });
    }
    await runtime.emitEvent({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: openCodeMetadata(task, snapshot)
    });
    activeOpenCodeTask = undefined;
  }
}

runtime.onCommand(async (command) => {
  const targetPane = await resolvePane();

  if (profile === "opencode") {
    switch (command.type) {
      case "status":
        await runtime.sendText(
          undefined,
          latestReply || (activeOpenCodeTask
            ? "OpenCode is still working on the current request."
            : `Attached to ${sessionName} (${targetPane}). Waiting for a prompt.`)
        );
        return;
      case "stop":
        await execFileAsync("tmux", ["send-keys", "-t", targetPane, "C-c"], { encoding: "utf8" });
        activeOpenCodeTask = undefined;
        await runtime.emitEvent({
          eventType: "need_user_input",
          status: "waiting_input",
          metadata: {
            provider: "opencode",
            interactive: true
          }
        });
        return;
      case "retry":
        if (!lastUserPrompt) {
          await runtime.sendText(undefined, "Nothing to retry yet.");
          return;
        }
        await dispatchOpenCodePrompt(lastUserPrompt);
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
        await dispatchOpenCodePrompt(command.text.trim());
        return;
      case "send_key":
        try {
          await sendKey(command.args ?? {});
          if (!activeOpenCodeTask) {
            beginOpenCodeFollowUp(`Special key: ${JSON.stringify(command.args ?? {})}`);
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
  const targetPane = await resolvePane();

  if (select.menuId !== activeMenuId) {
    await runtime.sendText(undefined, "Menu selection timed out or menu changed.");
    return;
  }

  if (select.itemId === "__cancel__") {
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Escape"], { encoding: "utf8" });
    resetActiveMenuState();
    beginOpenCodeFollowUp(`Dialog cancel: ${select.menuId}`);
    return;
  }

  if (select.itemId === "__confirm__") {
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Enter"], { encoding: "utf8" });
    resetActiveMenuState();
    beginOpenCodeFollowUp(`Dialog confirm: ${select.menuId}`);
    return;
  }

  if (select.itemId === "__submit__") {
    const inputValue = select.inputValue?.trim();
    if (!inputValue) {
      await runtime.sendText(undefined, "Please enter a value before submitting.");
      return;
    }
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "-l", inputValue], { encoding: "utf8" });
    await execFileAsync("tmux", ["send-keys", "-t", targetPane, "Enter"], { encoding: "utf8" });
    resetActiveMenuState();
    beginOpenCodeFollowUp(`Dialog submit: ${select.menuId}`);
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
  resetActiveMenuState();
  beginOpenCodeFollowUp(`Menu selection: ${select.itemId}`);
});

runtime.connect()
  .then(async () => {
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
    return currentCodexMode === "exec" ? "sh" : "codex --no-alt-screen";
  }
  if (currentProfile === "copilot" || currentProfile === "qwen") {
    return "sh";
  }
  return undefined;
}

function isExecProfile(currentProfile: BridgeProfile): boolean {
  return currentProfile === "copilot"
    || currentProfile === "qwen"
    || (currentProfile === "codex" && codexMode === "exec");
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

function openCodeMetadata(
  task: ActiveOpenCodeTask,
  capture: ReturnType<typeof parseOpenCodeInteractiveCapture>
): Record<string, unknown> {
  return {
    model: capture.model ?? task.model,
    provider: "opencode",
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

function beginOpenCodeFollowUp(prompt: string): void {
  activeOpenCodeTask = {
    id: `menu_select_${Date.now()}`,
    prompt,
    startedAt: Date.now(),
    sawBusy: false
  };
}

function buildCommandCompletionText(providerName: string, prompt: string): string | undefined {
  const normalized = prompt.trim();
  if (!normalized.startsWith("/")) {
    return undefined;
  }
  return `${providerName} finished ${normalized}.`;
}
