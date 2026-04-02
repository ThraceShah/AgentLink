import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";

const execFileAsync = promisify(execFile);

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const agentId = process.env.AGENT_ID ?? "tmux-agent";
const sessionName = process.env.TMUX_SESSION ?? "iris-agent";
const managedCommand = process.argv.slice(2).join(" ") || process.env.TMUX_COMMAND;
const pollIntervalMs = Number(process.env.TMUX_POLL_MS ?? 3000);

const runtime = new AgentRuntime({
  hubUrl,
  agentId,
  displayName: "tmux Agent",
  kind: "tmux-agent",
  sessionHint: sessionName,
  capabilities: ["status", "stop", "retry", "approve", "send_text"],
  quickCommands: ["status", "approve", "retry", "stop"]
});

let paneId = process.env.IRIS_TMUX_PANE;
let lastCapture = "";
let lastPromptKey = "";
let lastDeadState = "0";
let poller: NodeJS.Timeout | undefined;

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

function summarizeCapture(capture: string): string {
  return capture
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
}

async function emitPromptHint(capture: string): Promise<void> {
  const lines = capture
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4);
  const joined = lines.join(" | ");
  const lower = joined.toLowerCase();

  let eventType: "need_approval" | "need_user_input" | undefined;
  if (/(approve|approval|y\/n)/.test(lower)) {
    eventType = "need_approval";
  } else if (/(press enter|input|select|continue\?|confirm\?)/.test(lower)) {
    eventType = "need_user_input";
  }

  if (!eventType || joined === lastPromptKey) {
    return;
  }

  lastPromptKey = joined;
  await runtime.emitEvent({
    eventType,
    title: eventType === "need_approval" ? "tmux prompt requires approval" : "tmux prompt requires input",
    body: joined,
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
    title: exitCode === 0 ? "tmux task completed" : "tmux task failed",
    body: `session=${sessionName} pane=${targetPane} exit=${exitCode}`,
    status: exitCode === 0 ? "completed" : "failed"
  });
}

async function capturePane(): Promise<void> {
  const targetPane = await resolvePane();
  const capture = await tmux(["capture-pane", "-p", "-t", targetPane, "-S", "-80"]);
  if (capture !== lastCapture) {
    lastCapture = capture;
    const summary = summarizeCapture(capture);
    if (summary) {
      await runtime.sendText("tmux pane update", summary);
      await emitPromptHint(summary);
    }
  }
  await emitCompletionIfNeeded(targetPane);
}

async function ensureSessionBound(): Promise<void> {
  const targetPane = await resolvePane();
  await runtime.emitEvent({
    eventType: "task_running",
    title: "tmux session attached",
    body: `session=${sessionName} pane=${targetPane}`,
    status: "busy",
    metadata: {
      sessionName,
      paneId: targetPane,
      managed: Boolean(managedCommand)
    }
  });
}

async function stopManagedSession(): Promise<void> {
  if (await tmuxExists(sessionName)) {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName], { encoding: "utf8" });
  }
}

runtime.onCommand(async (command) => {
  const targetPane = await resolvePane();

  switch (command.type) {
    case "status":
      await runtime.sendText("tmux status", `session=${sessionName} pane=${targetPane}\n${summarizeCapture(lastCapture) || "No pane output yet."}`);
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
        await runtime.sendText("retry unsupported", "Set TMUX_COMMAND to allow managed retry.");
        break;
      }
      await stopManagedSession();
      paneId = undefined;
      lastCapture = "";
      lastPromptKey = "";
      lastDeadState = "0";
      await ensureSessionBound();
      break;
    case "approve":
      await sendLiteral(command.text ?? "y");
      await runtime.emitEvent({
        eventType: "task_running",
        title: "approval forwarded to tmux",
        body: `sent '${command.text ?? "y"}' to ${targetPane}`,
        status: "busy"
      });
      break;
    case "send_text":
      await sendLiteral(command.text ?? "");
      break;
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
