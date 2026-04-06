import type { StreamSnapshot } from "./stream-parser.js";

type ExecEventInput = {
  id?: string;
  eventType: "text_output" | "need_user_input" | "task_failed";
  body?: string;
  status?: "waiting_input" | "failed";
  metadata?: Record<string, unknown>;
};

type ExecCompletionInput = {
  providerName: string;
  eventId: string;
  emittedText: string;
  latestReply: string;
  prompt?: string;
  exitCode: number;
  snapshot: StreamSnapshot;
  metadata?: Record<string, unknown>;
};

type ExecCompletionResult = {
  events: ExecEventInput[];
  emittedText: string;
  latestReply: string;
};

export function latestExecPreview(snapshot: StreamSnapshot): string {
  return snapshot.partialText?.trim() || snapshot.finalText?.trim() || "";
}

function finalExecText(snapshot: StreamSnapshot): string {
  return snapshot.finalText?.trim() || snapshot.partialText?.trim() || "";
}

export function buildExecCompletionResult(input: ExecCompletionInput): ExecCompletionResult {
  const finalText = finalExecText(input.snapshot);
  const completionText = buildCommandCompletionText(input.providerName, input.prompt);

  if (input.exitCode === 0) {
    const events: ExecEventInput[] = [];
    let emittedText = input.emittedText;
    let latestReply = input.latestReply;

    if (finalText) {
      latestReply = finalText;
      if (finalText !== input.emittedText) {
        emittedText = finalText;
        events.push({
          id: input.eventId,
          eventType: "text_output",
          body: finalText,
          metadata: input.metadata
        });
      }
    } else if (completionText) {
      emittedText = completionText;
      latestReply = completionText;
      events.push({
        id: input.eventId,
        eventType: "text_output",
        body: completionText,
        metadata: input.metadata
      });
    }

    events.push({
      eventType: "need_user_input",
      status: "waiting_input",
      metadata: input.metadata
    });

    return {
      events,
      emittedText,
      latestReply
    };
  }

  const fallback = finalText || input.latestReply || `${input.providerName} command failed.`;
  return {
    events: [
      {
        eventType: "task_failed",
        body: fallback,
        status: "failed",
        metadata: input.metadata
      }
    ],
    emittedText: input.emittedText,
    latestReply: fallback
  };
}

function buildCommandCompletionText(providerName: string, prompt?: string): string | undefined {
  const normalized = prompt?.trim();
  if (!normalized?.startsWith("/")) {
    return undefined;
  }
  return `${providerName} finished ${normalized}.`;
}
