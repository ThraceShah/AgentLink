import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";
import { parseCaptureDelta, type BridgeProfile } from "./parser.js";

const execFileAsync = promisify(execFile);

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const profile = (process.env.TMUX_BRIDGE_PROFILE ?? "generic") as BridgeProfile;
const sessionName = process.env.TMUX_SESSION ?? "iris-agent";
const managedCommand = process.argv.slice(2).join(" ") || process.env.TMUX_COMMAND || defaultManagedCommand(profile);
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
let latestReply = "";
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

    if (parsed.emittedText) {
      await runtime.sendText(undefined, parsed.emittedText);
    }

    if (parsed.promptHint) {
      await emitPromptHint(parsed.promptHint.body, parsed.promptHint.eventType);
    }
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
      profile
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

function defaultManagedCommand(currentProfile: BridgeProfile): string | undefined {
  if (currentProfile === "codex") {
    return process.env.TMUX_COMMAND ?? "codex";
  }
  return undefined;
}
