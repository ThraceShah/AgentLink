import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentProfile = {
  id: string;
  label: string;
  bridgeProfile: "opencode" | "codex" | "copilot" | "qwen" | "generic";
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
  private readonly runningOpencodeProxies = new Map<string, { pid: number; port: number }>();

  async listProfiles(): Promise<AgentProfile[]> {
    const profiles: AgentProfile[] = [];

    if (await this.hasCommand("opencode") && await this.hasCommand("qwen")) {
      profiles.push({
        id: "opencode",
        label: "opencode",
        bridgeProfile: "opencode"
      });
    }

    if (await this.hasCommand("qwen")) {
      profiles.push({
        id: "qwen",
        label: "qwen",
        bridgeProfile: "qwen"
      });
    }

    if (await this.hasCommand("codex")) {
      profiles.push({
        id: "codex",
        label: "codex",
        bridgeProfile: "codex"
      });
    }

    if (await this.hasCommand("copilot")) {
      profiles.push({
        id: "copilot",
        label: "copilot",
        bridgeProfile: "copilot"
      });
    }

    return profiles;
  }

  getSessionConfig(): { workspaceRootHint: string; hostUsername: string } {
    return {
      workspaceRootHint: formatWorkspaceRootHint(resolveWorkspaceRoot()),
      hostUsername: userInfo().username
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
    await this.startBridge(sessionName, profile, input.hubUrl, workingDirectory);

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
        env: {
          ...process.env,
          PATH: buildCommandPath(process.env.PATH)
        },
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

  private async startBridge(
    sessionName: string,
    profile: AgentProfile,
    hubUrl: string,
    workingDirectory: string
  ): Promise<void> {
    if (this.runningBridges.has(sessionName)) {
      return;
    }

    const proxyPort = profile.id === "opencode"
      ? await this.ensureOpencodeProxy(sessionName, workingDirectory)
      : undefined;

    const child = spawn("node_modules/.bin/tsx", ["agents/tmux-agent/src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: buildCommandPath(process.env.PATH),
        HUB_URL: hubUrl,
        TMUX_SESSION: sessionName,
        TMUX_BRIDGE_PROFILE: profile.bridgeProfile,
        AGENT_ID: sessionName,
        AGENT_DISPLAY_NAME: sessionName,
        AGENT_KIND: profile.id,
        IRIS_USER_HOME: process.env.HOME ?? homedir(),
        OPENCODE_PROXY_PORT: proxyPort?.toString(),
        OPENCODE_PROXY_MODEL_ID: process.env.OPENCODE_PROXY_MODEL_ID ?? "qwen-cli"
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

    const proxy = this.runningOpencodeProxies.get(sessionName);
    if (proxy) {
      try {
        process.kill(proxy.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
      this.runningOpencodeProxies.delete(sessionName);
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

  private async ensureOpencodeProxy(sessionName: string, workingDirectory: string): Promise<number> {
    const existing = this.runningOpencodeProxies.get(sessionName);
    if (existing) {
      return existing.port;
    }

    const port = await allocateTcpPort();
    const child = spawn("node_modules/.bin/tsx", ["apps/opencode-proxy/src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: buildCommandPath(process.env.PATH),
        OPENCODE_PROXY_HOST: "127.0.0.1",
        OPENCODE_PROXY_PORT: port.toString(),
        OPENCODE_PROXY_WORKDIR: workingDirectory,
        OPENCODE_PROXY_MODEL_ID: process.env.OPENCODE_PROXY_MODEL_ID ?? "qwen-cli"
      },
      stdio: "ignore",
      detached: true
    });

    child.unref();
    this.runningOpencodeProxies.set(sessionName, { pid: child.pid ?? 0, port });
    return port;
  }
}

function defaultSessionCommand(profile: AgentProfile): string {
  if (profile.id === "opencode" || profile.id === "codex" || profile.id === "copilot" || profile.id === "qwen") {
    return "sh";
  }
  return "sh";
}

async function allocateTcpPort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed_to_allocate_proxy_port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
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

function buildCommandPath(existingPath?: string): string {
  const userBins = [path.join(homedir(), ".opencode", "bin")];
  const segments = [...userBins, ...(existingPath?.split(":") ?? [])].filter(Boolean);
  return Array.from(new Set(segments)).join(":");
}
