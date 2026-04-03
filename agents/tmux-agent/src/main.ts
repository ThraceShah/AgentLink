import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";
import { parseCaptureDelta, type BridgeProfile } from "./parser.js";

const execFileAsync = promisify(execFile);

type CodexMode = "exec" | "interactive";
type ActiveCodexTask = {
  id: string;
  prompt: string;
  promptPath: string;
  outputPath: string;
  statusPath: string;
};

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const profile = (process.env.TMUX_BRIDGE_PROFILE ?? "generic") as BridgeProfile;
const codexMode = ((process.env.TMUX_CODEX_MODE ?? "exec") as CodexMode);
const sessionName = process.env.TMUX_SESSION ?? "iris-agent";
const managedCommand = process.argv.slice(2).join(" ") || process.env.TMUX_COMMAND || defaultManagedCommand(profile, codexMode);
const pollIntervalMs = Number(process.env.TMUX_POLL_MS ?? 3000);
const approveText = process.env.TMUX_APPROVE_TEXT ?? "y";

const runtime = new AgentRuntime({
  hubUrl,
  agentId: process.env.AGENT_ID ?? defaultAgentId(profile),
  displayName: defaultDisplayName(profile),
  kind: defaultKind(profile),
  sessionHint: sessionName,
  capabilities: ["status", "stop", "retry", "approve", "send_text"],
  quickCommands: ["status", "approve", "retry", "stop"]
});

let paneId = process.env.IRIS_TMUX_PANE;
let lastCapture = "";
let lastPromptKey = "";
let lastDeadState = "0";
let lastSentText = "";
let lastUserPrompt = "";
let latestReply = "";
let poller: NodeJS.Timeout | undefined;
let activeCodexTask: ActiveCodexTask | undefined;

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
    const parsed = parseCaptureDelta({
      profile,
      previousCapture: lastCapture,
      currentCapture: capture,
      lastSentText
    });
    lastCapture = capture;

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

  if (profile === "codex" && codexMode === "exec") {
    await pollCodexExecTask();
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

async function createCodexExecTask(prompt: string): Promise<ActiveCodexTask> {
  const dir = codexBridgeDir();
  await mkdir(dir, { recursive: true });
  const id = `task_${Date.now()}`;
  const promptPath = path.join(dir, `${id}.prompt.txt`);
  const outputPath = path.join(dir, `${id}.reply.txt`);
  const statusPath = path.join(dir, `${id}.status.txt`);
  await rm(outputPath, { force: true });
  await rm(statusPath, { force: true });
  await writeFile(promptPath, `${prompt}\n`, "utf8");
  return { id, prompt, promptPath, outputPath, statusPath };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function dispatchCodexExecPrompt(prompt: string): Promise<void> {
  if (activeCodexTask) {
    await runtime.sendText(undefined, "Codex is still working on the previous request.");
    return;
  }

  const task = await createCodexExecTask(prompt);
  activeCodexTask = task;
  lastUserPrompt = prompt;
  lastSentText = prompt;
  lastPromptKey = "";

  const command = [
    `codex exec --skip-git-repo-check -C . --sandbox workspace-write --output-last-message ${shellQuote(task.outputPath)} - < ${shellQuote(task.promptPath)}`,
    `printf '%s\\n' $? > ${shellQuote(task.statusPath)}`
  ].join("; ");

  await runtime.emitEvent({
    eventType: "task_running",
    body: "Codex is working on your request.",
    status: "busy"
  });

  await sendLiteral(command);
}

async function pollCodexExecTask(): Promise<void> {
  const task = activeCodexTask;
  if (!task) {
    return;
  }

  let statusText: string | undefined;
  try {
    statusText = (await readFile(task.statusPath, "utf8")).trim();
  } catch {
    return;
  }

  let reply = "";
  try {
    reply = (await readFile(task.outputPath, "utf8")).trim();
  } catch {
    reply = "";
  }

  const exitCode = Number(statusText || "1");
  if (reply) {
    latestReply = reply;
    await runtime.sendText(undefined, reply);
  }

  if (exitCode === 0) {
    await runtime.emitEvent({
      eventType: "task_completed",
      body: "Codex finished the request.",
      status: "completed"
    });
  } else {
    const fallback = latestReply || "Codex command failed.";
    await runtime.emitEvent({
      eventType: "task_failed",
      body: fallback,
      status: "failed"
    });
  }

  activeCodexTask = undefined;
}

runtime.onCommand(async (command) => {
  const targetPane = await resolvePane();

  if (profile === "codex" && codexMode === "exec") {
    switch (command.type) {
      case "status":
        await runtime.sendText(
          undefined,
          latestReply || (activeCodexTask
            ? "Codex is still working on the current request."
            : `Attached to ${sessionName} (${targetPane}). Waiting for a prompt.`)
        );
        return;
      case "stop":
        if (activeCodexTask) {
          await execFileAsync("tmux", ["send-keys", "-t", targetPane, "C-c"], { encoding: "utf8" });
          activeCodexTask = undefined;
        } else if (managedCommand) {
          await stopManagedSession();
        }
        return;
      case "retry":
        if (!lastUserPrompt) {
          await runtime.sendText(undefined, "Nothing to retry yet.");
          return;
        }
        await dispatchCodexExecPrompt(lastUserPrompt);
        return;
      case "approve":
        await runtime.sendText(undefined, "Approve is not used in codex exec mode.");
        return;
      case "send_text":
        if (!command.text?.trim()) {
          await runtime.sendText(undefined, "Please send a non-empty instruction.");
          return;
        }
        await dispatchCodexExecPrompt(command.text.trim());
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
  }
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

function defaultDisplayName(currentProfile: BridgeProfile): string {
  return currentProfile === "codex" ? "Codex Bridge" : "tmux Agent";
}

function defaultKind(currentProfile: BridgeProfile): string {
  return currentProfile === "codex" ? "codex-bridge" : "tmux-agent";
}

function defaultAgentId(currentProfile: BridgeProfile): string {
  return currentProfile === "codex" ? "codex-bridge" : "tmux-agent";
}

function defaultManagedCommand(currentProfile: BridgeProfile, currentCodexMode: CodexMode): string | undefined {
  if (currentProfile === "codex") {
    return currentCodexMode === "exec" ? "sh" : "codex --no-alt-screen";
  }
  return undefined;
}
