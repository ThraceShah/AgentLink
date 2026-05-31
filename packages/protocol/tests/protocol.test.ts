import { describe, expect, it } from "vitest";

import {
  createId,
  deriveStatusFromEvent,
  parseIncomingMessage,
  slashCommandNodeSchema
} from "../src/index.js";

describe("protocol helpers", () => {
  it("parses client hello messages", () => {
    const parsed = parseIncomingMessage(JSON.stringify({
      type: "hello",
      role: "client",
      client: {
        clientId: "android-1",
        platform: "android"
      }
    }));

    expect(parsed.type).toBe("hello");
    expect(parsed.role).toBe("client");
  });

  it("derives status from event types", () => {
    expect(deriveStatusFromEvent("task_running")).toBe("busy");
    expect(deriveStatusFromEvent("process_delta")).toBe("busy");
    expect(deriveStatusFromEvent("assistant_completed")).toBe("completed");
    expect(deriveStatusFromEvent("task_failed")).toBe("failed");
  });

  it("creates ids with prefixes", () => {
    expect(createId("evt")).toMatch(/^evt_/);
  });

  it("parses custom commands with structured args and ui metadata", () => {
    const parsed = parseIncomingMessage(JSON.stringify({
      type: "command",
      agentId: "codex-1",
      command: {
        id: "cmd-1",
        type: "custom",
        text: "/goal Ship structured commands",
        args: {
          codexCommand: "goal.set",
          objective: "Ship structured commands"
        }
      }
    }));

    expect(parsed.type).toBe("command");
    expect(parsed.command.type).toBe("custom");
    expect(parsed.command.args?.codexCommand).toBe("goal.set");

    const slashNode = slashCommandNodeSchema.parse({
      id: "goal",
      label: "goal",
      commandType: "custom",
      args: { codexCommand: "goal" },
      ui: { kind: "codexGoal" }
    });
    expect(slashNode.ui?.kind).toBe("codexGoal");
  });
});
