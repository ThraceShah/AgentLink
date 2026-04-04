import { describe, expect, it } from "vitest";

import { parseProviderStream } from "../src/stream-parser.js";

describe("parseProviderStream", () => {
  it("extracts opencode json output", () => {
    const result = parseProviderStream("opencode", [
      JSON.stringify({
        type: "message",
        content: "partial answer"
      }),
      JSON.stringify({
        type: "result",
        data: {
          content: "final answer"
        }
      })
    ].join("\n"));

    expect(result.partialText).toBe("final answer");
    expect(result.finalText).toBe("final answer");
  });

  it("falls back to plain text for opencode errors", () => {
    const result = parseProviderStream("opencode", "Error: agent coder not found");

    expect(result.partialText).toBe("Error: agent coder not found");
    expect(result.finalText).toBe("Error: agent coder not found");
  });

  it("extracts opencode response from a whole json document", () => {
    const result = parseProviderStream("opencode", JSON.stringify({
      response: "ok"
    }, null, 2));

    expect(result.partialText).toBe("ok");
    expect(result.finalText).toBe("ok");
  });

  it("extracts partial and final text from qwen stream-json output", () => {
    const result = parseProviderStream("qwen", [
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" }
        }
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " world" }
        }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }]
        }
      })
    ].join("\n"));

    expect(result.partialText).toBe("Hello world");
    expect(result.finalText).toBe("Hello world");
  });

  it("extracts copilot json streaming output", () => {
    const result = parseProviderStream("copilot", [
      JSON.stringify({
        type: "assistant.message_delta",
        data: { deltaContent: "Copilot" }
      }),
      JSON.stringify({
        type: "assistant.message_delta",
        data: { deltaContent: "_OK" }
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "Copilot_OK" }
      })
    ].join("\n"));

    expect(result.partialText).toBe("Copilot_OK");
    expect(result.finalText).toBe("Copilot_OK");
  });

  it("extracts codex final message from json output", () => {
    const result = parseProviderStream("codex", JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "CODEX_OK"
      }
    }));

    expect(result.partialText).toBe("CODEX_OK");
    expect(result.finalText).toBe("CODEX_OK");
  });
});
