import { describe, expect, it, vi } from "vitest";

import { SessionManager } from "../src/session-manager.js";

describe("SessionManager", () => {
  it("lists profiles in the preferred order", async () => {
    const manager = new SessionManager();
    const hasCommand = vi.spyOn(manager as any, "hasCommand");

    hasCommand.mockImplementation(async (command: string) => {
      return ["opencode", "qwen", "codex", "copilot"].includes(command);
    });

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

  it("hides opencode when qwen backend is unavailable", async () => {
    const manager = new SessionManager();
    const hasCommand = vi.spyOn(manager as any, "hasCommand");

    hasCommand.mockImplementation(async (command: string) => {
      return ["opencode", "codex", "copilot"].includes(command);
    });

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
});
