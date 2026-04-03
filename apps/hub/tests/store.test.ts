import { describe, expect, it } from "vitest";

import { HubStore } from "../src/store.js";

describe("HubStore", () => {
  it("preserves last conversation timestamp on heartbeat-style upsert", () => {
    const store = new HubStore();
    store.upsertAgent({
      agentId: "codex-demo",
      displayName: "codex-demo",
      kind: "codex",
      capabilities: [],
      quickCommands: []
    });

    store.appendEvent({
      id: "evt_1",
      agentId: "codex-demo",
      eventType: "text_output",
      timestamp: "2026-04-04T10:00:00.000Z",
      body: "hello"
    });

    const afterMessage = store.getAgent("codex-demo");
    expect(afterMessage?.lastSeenAt).toBe("2026-04-04T10:00:00.000Z");

    store.upsertAgent({
      ...(afterMessage!),
      status: afterMessage!.status
    });

    expect(store.getAgent("codex-demo")?.lastSeenAt).toBe("2026-04-04T10:00:00.000Z");
  });
});
