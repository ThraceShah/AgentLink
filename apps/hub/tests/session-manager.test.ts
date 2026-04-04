import { describe, expect, it, vi } from "vitest";

import { SessionManager } from "../src/session-manager.js";

describe("SessionManager", () => {
  it("lists profiles in the preferred order", async () => {
    const manager = new SessionManager();
    const hasCommand = vi.spyOn(manager as any, "hasCommand");
    const hasUsableOpenCodeConfig = vi.spyOn(manager as any, "hasUsableOpenCodeConfig");

    hasCommand.mockImplementation(async (command: string) => {
      return ["opencode", "qwen", "codex", "copilot"].includes(command);
    });
    hasUsableOpenCodeConfig.mockResolvedValue(true);

    await expect(manager.listProfiles()).resolves.toEqual([
      {
        id: "opencode",
        label: "opencode",
        bridgeProfile: "opencode"
      },
      {
        id: "qwen",
        label: "qwen",
        bridgeProfile: "qwen"
      },
      {
        id: "codex",
        label: "codex",
        bridgeProfile: "codex"
      },
      {
        id: "copilot",
        label: "copilot",
        bridgeProfile: "copilot"
      }
    ]);
  });

  it("hides opencode when the runtime probe fails", async () => {
    const manager = new SessionManager();
    const hasCommand = vi.spyOn(manager as any, "hasCommand");
    const hasUsableOpenCodeConfig = vi.spyOn(manager as any, "hasUsableOpenCodeConfig");

    hasCommand.mockImplementation(async (command: string) => {
      return ["opencode", "codex", "copilot"].includes(command);
    });
    hasUsableOpenCodeConfig.mockResolvedValue(false);

    await expect(manager.listProfiles()).resolves.toEqual([
      {
        id: "codex",
        label: "codex",
        bridgeProfile: "codex"
      },
      {
        id: "copilot",
        label: "copilot",
        bridgeProfile: "copilot"
      }
    ]);
  });

  it("returns a non-empty host username in session config", () => {
    const manager = new SessionManager();

    expect(manager.getSessionConfig().hostUsername).toMatch(/\S+/);
  });

  it("hides opencode when its own config is unavailable", async () => {
    const manager = new SessionManager();
    const hasCommand = vi.spyOn(manager as any, "hasCommand");
    const hasUsableOpenCodeConfig = vi.spyOn(manager as any, "hasUsableOpenCodeConfig");

    hasCommand.mockImplementation(async (command: string) => {
      return ["opencode", "qwen", "codex", "copilot"].includes(command);
    });
    hasUsableOpenCodeConfig.mockResolvedValue(false);

    await expect(manager.listProfiles()).resolves.toEqual([
      {
        id: "qwen",
        label: "qwen",
        bridgeProfile: "qwen"
      },
      {
        id: "codex",
        label: "codex",
        bridgeProfile: "codex"
      },
      {
        id: "copilot",
        label: "copilot",
        bridgeProfile: "copilot"
      }
    ]);
  });
});
