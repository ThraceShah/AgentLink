import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentProfile = {
  id: string;
  label: string;
  bridgeProfile: "codex" | "generic";
  command?: string;
};

export type CreateSessionInput = {
  sessionName: string;
  profileId: string;
  workdir: string;
  hubUrl: string;
};

export class SessionManager {
  private readonly runningBridges = new Map<string, number>();

  async listProfiles(): Promise<AgentProfile[]> {
    const profiles: AgentProfile[] = [];

    if (await this.hasCommand("codex")) {
      profiles.push({
        id: "codex",
        label: "codex",
        bridgeProfile: "codex"
      });
    }

    return profiles;
  }

  getSessionConfig(): { workspaceRootHint: string } {
    return {
      workspaceRootHint: formatWorkspaceRootHint(resolveWorkspaceRoot())
    };
  }

  async createSession(input: CreateSessionInput): Promise<{ sessionName: string; profile: AgentProfile }> {
    const profile = (await this.listProfiles()).find((item) => item.id === input.profileId);
    if (!profile) {
      throw new Error(`unsupported agent profile: ${input.profileId}`);
    }

    const sessionName = sanitizeSessionName(input.sessionName);
    if (!sessionName) {
      throw new Error("session name is required");
    }

    const workingDirectory = resolveWorkingDirectory(input.workdir);
    await mkdir(workingDirectory, { recursive: true });
    await this.ensureTmuxSession(sessionName, profile, workingDirectory);
    await this.startBridge(sessionName, profile, input.hubUrl);

    return { sessionName, profile };
  }

  async deleteSession(sessionNameInput: string): Promise<{ sessionName: string }> {
    const sessionName = sanitizeSessionName(sessionNameInput);
    if (!sessionName) {
      throw new Error("session name is required");
    }

    await this.stopBridge(sessionName);
    if (await this.tmuxSessionExists(sessionName)) {
      await execFileAsync("tmux", ["kill-session", "-t", sessionName], { encoding: "utf8" });
    }
    this.runningBridges.delete(sessionName);
    return { sessionName };
  }

  private async hasCommand(command: string): Promise<boolean> {
    try {
      await execFileAsync("sh", ["-lc", `command -v ${shellToken(command)}`], {
        encoding: "utf8"
      });
      return true;
    } catch {
      return false;
    }
  }

  private async ensureTmuxSession(
    sessionName: string,
    profile: AgentProfile,
    workingDirectory: string
  ): Promise<void> {
    if (await this.tmuxSessionExists(sessionName)) {
      return;
    }

    const command = profile.command ?? defaultSessionCommand(profile);
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-c", workingDirectory, "sh", "-lc", command], {
      encoding: "utf8"
    });
  }

  private async tmuxSessionExists(sessionName: string): Promise<boolean> {
    try {
      await execFileAsync("tmux", ["has-session", "-t", sessionName], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }

  private async startBridge(sessionName: string, profile: AgentProfile, hubUrl: string): Promise<void> {
    if (this.runningBridges.has(sessionName)) {
      return;
    }

    const child = spawn("node_modules/.bin/tsx", ["agents/tmux-agent/src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_URL: hubUrl,
        TMUX_SESSION: sessionName,
        TMUX_BRIDGE_PROFILE: profile.bridgeProfile,
        AGENT_ID: sessionName,
        AGENT_LABEL: profile.label,
        AGENT_KIND: profile.id
      },
      stdio: "ignore",
      detached: true
    });

    child.unref();
    this.runningBridges.set(sessionName, child.pid ?? 0);
  }

  private async stopBridge(sessionName: string): Promise<void> {
    const trackedPid = this.runningBridges.get(sessionName);
    if (trackedPid) {
      try {
        process.kill(trackedPid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }

    const processIds = await this.findBridgeProcessIds(sessionName);
    for (const pid of processIds) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  }

  private async findBridgeProcessIds(sessionName: string): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", "agents/tmux-agent/src/main.ts"], {
        encoding: "utf8"
      });
      const ids = stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      const matched: number[] = [];
      for (const pid of ids) {
        try {
          const environ = await readFile(`/proc/${pid}/environ`, "utf8");
          const variables = environ.split("\u0000");
          if (variables.includes(`TMUX_SESSION=${sessionName}`)) {
            matched.push(pid);
          }
        } catch {
          // Ignore vanished process.
        }
      }
      return matched;
    } catch {
      return [];
    }
  }
}

function defaultSessionCommand(profile: AgentProfile): string {
  if (profile.id === "codex") {
    return "sh";
  }
  return "sh";
}

function sanitizeSessionName(input: string): string {
  return input.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
}

function resolveWorkingDirectory(workdir: string): string {
  const sanitized = sanitizeWorkdir(workdir);
  if (!sanitized) {
    throw new Error("workdir is required");
  }
  return path.join(resolveWorkspaceRoot(), sanitized);
}

function sanitizeWorkdir(input: string): string {
  const normalized = input
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("workdir must stay inside workspace root");
  }

  const safeSegments = segments.map((segment) =>
    segment.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-")
  );
  if (safeSegments.some((segment) => segment.length === 0)) {
    throw new Error("workdir contains unsupported path segment");
  }

  return safeSegments.join("/");
}

function resolveWorkspaceRoot(): string {
  const configured = process.env.SESSION_WORKDIR_ROOT_RELATIVE?.trim() || "code";
  const safeRelative = configured
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..")
    .join("/");
  return path.join(homedir(), safeRelative || "code");
}

function formatWorkspaceRootHint(workspaceRoot: string): string {
  const home = homedir();
  if (workspaceRoot === home) {
    return "~";
  }
  if (workspaceRoot.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, workspaceRoot).replaceAll(path.sep, "/")}`;
  }
  return "~";
}

function shellToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "");
}
