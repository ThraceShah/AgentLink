import { describe, expect, it } from "vitest";

import { parseProviderStream } from "../src/stream-parser.js";

describe("parseProviderStream", () => {
  it("extracts opencode json output", () => {
    const result = parseProviderStream("opencode", [
      "INFO service=llm providerID=opencode modelID=qwen3.6-plus-free sessionID=abc small=false agent=build mode=primary stream",
      JSON.stringify({
        type: "text",
        part: {
          text: "partial answer"
        }
      }),
      JSON.stringify({
        type: "step_finish",
        part: {
          tokens: {
            total: 120,
            input: 100,
            output: 20,
            reasoning: 12
          }
        }
      }),
      JSON.stringify({
        type: "text",
        part: {
          text: "final answer"
        }
      })
    ].join("\n"));

    expect(result.partialText).toBe("final answer");
    expect(result.finalText).toBe("final answer");
    expect(result.model).toBe("qwen3.6-plus-free");
    expect(result.totalTokens).toBe(120);
    expect(result.contextUsedTokens).toBe(120);
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
        type: "system",
        model: "glm-5"
      }),
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
          model: "glm-5",
          content: [{ type: "text", text: "Hello world" }],
          usage: {
            input_tokens: 100,
            output_tokens: 30,
            total_tokens: 130
          }
        }
      })
    ].join("\n"));

    expect(result.partialText).toBe("Hello world");
    expect(result.finalText).toBe("Hello world");
    expect(result.model).toBe("glm-5");
    expect(result.totalTokens).toBe(130);
    expect(result.contextUsedTokens).toBe(130);
  });

  it("extracts copilot json streaming output", () => {
    const result = parseProviderStream("copilot", [
      JSON.stringify({
        type: "session.tools_updated",
        data: { model: "claude-sonnet-4.6" }
      }),
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
        data: { content: "Copilot_OK", outputTokens: 9 }
      })
    ].join("\n"));

    expect(result.partialText).toBe("Copilot_OK");
    expect(result.finalText).toBe("Copilot_OK");
    expect(result.model).toBe("claude-sonnet-4.6");
    expect(result.outputTokens).toBe(9);
  });

  it("extracts codex final message from json output", () => {
    const result = parseProviderStream("codex", [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "CODEX_OK"
        }
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 200,
          cached_input_tokens: 50,
          output_tokens: 20
        }
      })
    ].join("\n"));

    expect(result.partialText).toBe("CODEX_OK");
    expect(result.finalText).toBe("CODEX_OK");
    expect(result.totalTokens).toBe(270);
    expect(result.contextUsedTokens).toBe(250);
  });
});
