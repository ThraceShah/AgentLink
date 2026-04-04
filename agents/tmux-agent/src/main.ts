import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";
import { resolveProviderModel } from "./model-resolver.js";
import { parseCaptureDelta, type BridgeProfile } from "./parser.js";
import { parseProviderStream } from "./stream-parser.js";

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

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const profile = (process.env.TMUX_BRIDGE_PROFILE ?? "generic") as BridgeProfile;
const codexMode = ((process.env.TMUX_CODEX_MODE ?? "exec") as CodexMode);
const sessionName = process.env.TMUX_SESSION ?? "iris-agent";
const managedCommand = process.argv.slice(2).join(" ") || process.env.TMUX_COMMAND || defaultManagedCommand(profile, codexMode);
const pollIntervalMs = Number(process.env.TMUX_POLL_MS ?? 1000);
const approveText = process.env.TMUX_APPROVE_TEXT ?? "y";

const runtime = new AgentRuntime({
  hubUrl,
  agentId: process.env.AGENT_ID ?? defaultAgentId(profile, sessionName),
  displayName: process.env.AGENT_DISPLAY_NAME ?? defaultDisplayName(sessionName),
  kind: process.env.AGENT_KIND ?? defaultKind(profile),
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
let activeExecTask: ActiveExecTask | undefined;

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

    if (!isExecProfile(profile)) {
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
  const candidateText = streamSnapshot.partialText?.trim();
  if (candidateText && candidateText != task.emittedText) {
    task.emittedText = candidateText;
    latestReply = candidateText;
    await runtime.emitEvent({
      id: task.eventId,
      eventType: "text_output",
      body: candidateText,
      metadata: streamMetadata(task, streamSnapshot)
    });
  }

  let statusText: string | undefined;
  try {
    statusText = (await readFile(task.statusPath, "utf8")).trim();
  } catch {
    return;
  }

  const exitCode = Number(statusText || "1");
  const finalText = streamSnapshot.finalText?.trim() || "";
  if (finalText && finalText != task.emittedText) {
    task.emittedText = finalText;
    latestReply = finalText;
    await runtime.emitEvent({
      id: task.eventId,
      eventType: "text_output",
      body: finalText,
      metadata: streamMetadata(task, streamSnapshot)
    });
  }

  if (exitCode === 0) {
    await runtime.emitEvent({
      eventType: "task_completed",
      body: `${providerDisplayName(profile)} finished the request.`,
      status: "completed",
      metadata: streamMetadata(task, streamSnapshot)
    });
  } else {
    const fallback = latestReply || `${providerDisplayName(profile)} command failed.`;
    await runtime.emitEvent({
      eventType: "task_failed",
      body: fallback,
      status: "failed",
      metadata: streamMetadata(task, streamSnapshot)
    });
  }

  activeExecTask = undefined;
}

runtime.onCommand(async (command) => {
  const targetPane = await resolvePane();

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
    return "sh";
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
  return currentProfile === "opencode"
    || currentProfile === "copilot"
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
