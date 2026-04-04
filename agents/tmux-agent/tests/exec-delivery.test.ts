import { describe, expect, it } from "vitest";

import { buildExecCompletionResult, latestExecPreview } from "../src/exec-delivery.js";

describe("latestExecPreview", () => {
  it("prefers partial text while a provider is still streaming", () => {
    expect(latestExecPreview({
      partialText: "partial answer",
      finalText: "final answer"
    })).toBe("partial answer");
  });

  it("falls back to final text when partial text is absent", () => {
    expect(latestExecPreview({
      finalText: "final answer"
    })).toBe("final answer");
  });
});

describe("buildExecCompletionResult", () => {
  it("emits the final text once and then switches to waiting_input", () => {
    const result = buildExecCompletionResult({
      providerName: "Qwen",
      eventId: "stream_1",
      emittedText: "",
      latestReply: "",
      exitCode: 0,
      snapshot: {
        partialText: "draft",
        finalText: "final answer"
      },
      metadata: {
        provider: "qwen"
      }
    });

    expect(result.emittedText).toBe("final answer");
    expect(result.latestReply).toBe("final answer");
    expect(result.events).toEqual([
      {
        id: "stream_1",
        eventType: "text_output",
        body: "final answer",
        metadata: {
          provider: "qwen"
        }
      },
      {
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: {
          provider: "qwen"
        }
      }
    ]);
  });

  it("does not resend text when the final event already matches the stored reply", () => {
    const result = buildExecCompletionResult({
      providerName: "OpenCode",
      eventId: "stream_2",
      emittedText: "final answer",
      latestReply: "final answer",
      exitCode: 0,
      snapshot: {
        finalText: "final answer"
      }
    });

    expect(result.events).toEqual([
      {
        eventType: "need_user_input",
        status: "waiting_input",
        metadata: undefined
      }
    ]);
  });

  it("uses the latest available text for task_failed", () => {
    const result = buildExecCompletionResult({
      providerName: "OpenCode",
      eventId: "stream_3",
      emittedText: "",
      latestReply: "partial answer",
      exitCode: 1,
      snapshot: {}
    });

    expect(result.latestReply).toBe("partial answer");
    expect(result.events).toEqual([
      {
        eventType: "task_failed",
        body: "partial answer",
        status: "failed",
        metadata: undefined
      }
    ]);
  });
});
