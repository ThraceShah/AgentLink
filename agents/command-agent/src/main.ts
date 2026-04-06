import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const agentId = process.env.AGENT_ID ?? "command-agent";
const commandString = process.argv.slice(2).join(" ") || process.env.COMMAND_AGENT_SCRIPT || "printf 'command agent ready\n'";

const runtime = new AgentRuntime({
  hubUrl,
  agentId,
  displayName: "Command Agent",
  kind: "command-agent",
  capabilities: ["status", "stop", "retry", "approve", "send_text"],
  quickCommands: ["status", "retry", "stop"],
  slashCommands: [
    {
      id: "status",
      label: "Status",
      description: "Check agent status",
      commandType: "status"
    },
    {
      id: "stop",
      label: "Stop",
      description: "Kill the running process",
      commandType: "stop"
    },
    {
      id: "retry",
      label: "Retry",
      description: "Re-run the command",
      commandType: "retry"
    },
    {
      id: "send_text",
      label: "Send",
      description: "Send text to stdin",
      commandType: "send_text",
      requiresInput: true,
      inputPlaceholder: "Type input..."
    },
    {
      id: "approve",
      label: "Approve",
      description: "Acknowledge approval",
      commandType: "approve"
    }
  ]
});

let child: ChildProcessWithoutNullStreams | undefined;
let lastExitCode: number | null = null;

function parseStructuredEvent(line: string): { eventType: any; title?: string; body?: string; status?: any; metadata?: Record<string, unknown> } | null {
  if (!line.startsWith("AGENT_EVENT ")) {
    return null;
  }

  try {
    return JSON.parse(line.slice("AGENT_EVENT ".length));
  } catch {
    return null;
  }
}

async function runCommand(): Promise<void> {
  await runtime.emitEvent({
    eventType: "task_running",
    title: "Command started",
    body: commandString,
    status: "busy"
  });

  child = spawn(commandString, {
    shell: true,
    stdio: "pipe"
  });

  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });

  stdout.on("line", async (line) => {
    const structured = parseStructuredEvent(line);
    if (structured) {
      await runtime.emitEvent({
        eventType: structured.eventType,
        title: structured.title,
        body: structured.body,
        status: structured.status,
        metadata: structured.metadata
      });
      return;
    }

    await runtime.sendText("stdout", line);
  });

  stderr.on("line", async (line) => {
    await runtime.sendText("stderr", line);
  });

  child.on("exit", async (code) => {
    lastExitCode = code;
    if (code === 0) {
      await runtime.emitEvent({
        eventType: "task_completed",
        title: "Command completed",
        body: commandString,
        status: "completed"
      });
    } else {
      await runtime.emitEvent({
        eventType: "task_failed",
        title: "Command failed",
        body: `exit code ${code}`,
        status: "failed"
      });
    }
    child = undefined;
  });
}

runtime.onCommand(async (command) => {
  switch (command.type) {
    case "status":
      await runtime.sendText(
        "Command agent status",
        child ? "A child process is still running." : `Idle. Last exit code: ${lastExitCode ?? "n/a"}`
      );
      break;
    case "stop":
      child?.kill("SIGTERM");
      break;
    case "retry":
      if (!child) {
        await runCommand();
      }
      break;
    case "approve":
      await runtime.sendText("Approval", "Approval acknowledged by command agent.");
      break;
    case "send_text":
      if (child?.stdin.writable) {
        child.stdin.write(`${command.text ?? ""}\n`);
      } else {
        await runtime.sendText("stdin unavailable", "No active process to receive text input.");
      }
      break;
  }
});

runtime.connect()
  .then(() => runCommand())
  .catch((error) => {
    console.error("command agent failed", error);
    process.exit(1);
  });
