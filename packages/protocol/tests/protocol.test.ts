import { describe, expect, it } from "vitest";

import {
  createId,
  deriveStatusFromEvent,
  parseIncomingMessage
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
});
