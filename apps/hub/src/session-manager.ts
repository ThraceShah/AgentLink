import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
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

  async createSession(input: CreateSessionInput): Promise<{ sessionName: string; profile: AgentProfile }> {
    const profile = (await this.listProfiles()).find((item) => item.id === input.profileId);
    if (!profile) {
      throw new Error(`unsupported agent profile: ${input.profileId}`);
    }

    const sessionName = sanitizeSessionName(input.sessionName);
    if (!sessionName) {
      throw new Error("session name is required");
    }

    await this.ensureTmuxSession(sessionName, profile);
    await this.startBridge(sessionName, profile, input.hubUrl);

    return { sessionName, profile };
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

  private async ensureTmuxSession(sessionName: string, profile: AgentProfile): Promise<void> {
    if (await this.tmuxSessionExists(sessionName)) {
      return;
    }

    const command = profile.command ?? defaultSessionCommand(profile);
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "sh", "-lc", command], {
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

function shellToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "");
}
