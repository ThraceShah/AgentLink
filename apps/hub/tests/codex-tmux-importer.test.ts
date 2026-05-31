import { describe, expect, it } from "vitest";

import { parseCodexRolloutTimeline } from "../src/codex-tmux-importer.js";

describe("parseCodexRolloutTimeline", () => {
  it("restores visible user and assistant messages from Codex rollout JSONL", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-05-31T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "thread-1" }
      }),
      JSON.stringify({
        timestamp: "2026-05-31T01:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-31T01:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi there" }]
        }
      })
    ].join("\n");

    const events = parseCodexRolloutTimeline(content, "imported", "thread-1");

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      agentId: "imported",
      eventType: "user_command",
      body: "hello",
      metadata: {
        imported: true,
        source: "codex_rollout",
        threadId: "thread-1"
      }
    });
    expect(events[1]).toMatchObject({
      agentId: "imported",
      eventType: "text_output",
      body: "hi there"
    });
  });
});
