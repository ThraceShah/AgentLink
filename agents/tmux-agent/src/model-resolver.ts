import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { BridgeProfile } from "./parser.js";

type TimedModel = {
  model: string;
  timestamp: string;
};

export async function resolveProviderModel(profile: BridgeProfile): Promise<string | undefined> {
  const explicit = process.env.TMUX_PROVIDER_MODEL?.trim();
  if (explicit) {
    return explicit;
  }

  if (profile === "opencode") {
    return resolveOpenCodeModel();
  }

  if (profile === "codex") {
    return resolveCodexModel();
  }

  if (profile === "qwen") {
    return resolveQwenModel();
  }

  if (profile === "copilot") {
    return resolveCopilotModel();
  }

  return undefined;
}

async function resolveOpenCodeModel(): Promise<string | undefined> {
  const candidatePaths = [
    path.join(process.cwd(), ".opencode.json"),
    path.join(homedir(), ".opencode.json"),
    path.join(homedir(), ".config", "opencode", ".opencode.json")
  ];

  for (const configPath of candidatePaths) {
    const config = await safeReadFile(configPath);
    if (config) {
      const model = parseOpenCodeModel(config);
      if (model) {
        return model;
      }
    }
  }

  return undefined;
}

async function resolveCodexModel(): Promise<string | undefined> {
  const envModel = process.env.CODEX_MODEL?.trim();
  if (envModel) {
    return envModel;
  }

  const configPath = path.join(homedir(), ".codex", "config.toml");
  const config = await safeReadFile(configPath);
  return config ? parseCodexModel(config) : undefined;
}

async function resolveQwenModel(): Promise<string | undefined> {
  const envModel = process.env.QWEN_MODEL?.trim();
  if (envModel) {
    return envModel;
  }

  const candidatePaths = [
    path.join(homedir(), ".config", "qwen", "settings.json"),
    path.join(homedir(), ".qwen", "settings.json")
  ];

  for (const settingsPath of candidatePaths) {
    const settings = await safeReadFile(settingsPath);
    if (settings) {
      const model = parseQwenModel(settings);
      if (model) {
        return model;
      }
    }
  }

  return undefined;
}

async function resolveCopilotModel(): Promise<string | undefined> {
  const envModel = process.env.COPILOT_MODEL?.trim();
  if (envModel) {
    return envModel;
  }

  const sessionRoot = path.join(homedir(), ".copilot", "session-state");
  let directories: string[] = [];
  try {
    directories = await readdir(sessionRoot);
  } catch {
    return undefined;
  }

  let latest: TimedModel | undefined;
  for (const directory of directories) {
    const eventsPath = path.join(sessionRoot, directory, "events.jsonl");
    const content = await safeReadFile(eventsPath);
    if (!content) {
      continue;
    }

    const candidate = parseCopilotModel(content);
    if (!candidate) {
      continue;
    }

    if (!latest || candidate.timestamp > latest.timestamp) {
      latest = candidate;
    }
  }

  return latest?.model;
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function parseCodexModel(content: string): string | undefined {
  const match = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match?.[1]?.trim() || undefined;
}

export function parseQwenModel(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { model?: { name?: string } };
    return parsed.model?.name?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseOpenCodeModel(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as {
      agents?: {
        coder?: {
          model?: string;
        };
      };
      model?: string;
      agent?: {
        model?: string;
      };
      provider?: {
        model?: string;
      };
    };
    const legacyModel = parsed.agents?.coder?.model?.trim();
    return parsed.model?.trim()
      || legacyModel
      || parsed.agent?.model?.trim()
      || parsed.provider?.model?.trim()
      || undefined;
  } catch {
    return undefined;
  }
}

export function parseCopilotModel(content: string): TimedModel | undefined {
  let latest: TimedModel | undefined;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const item = JSON.parse(trimmed) as {
        type?: string;
        timestamp?: string;
        data?: {
          model?: string;
          newModel?: string;
          currentModel?: string;
        };
      };

      const timestamp = item.timestamp?.trim();
      const model = extractCopilotModel(item)?.trim();
      if (!timestamp || !model) {
        continue;
      }

      if (!latest || timestamp > latest.timestamp) {
        latest = { model, timestamp };
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return latest;
}

function extractCopilotModel(item: {
  type?: string;
  data?: {
    model?: string;
    newModel?: string;
    currentModel?: string;
  };
}): string | undefined {
  if (item.type === "session.tools_updated") {
    return item.data?.model;
  }
  if (item.type === "session.model_change") {
    return item.data?.newModel;
  }
  if (item.type === "session.shutdown") {
    return item.data?.currentModel;
  }
  return undefined;
}
