import { Buffer } from "node:buffer";

import { AgentRuntime } from "../../../packages/sdk/src/index.js";

const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787/ws";
const agentId = process.env.AGENT_ID ?? "demo-agent";
const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const systemPrompt = process.env.OPENAI_SYSTEM_PROMPT ?? [
  "You are a personal private coding agent inside an IM client.",
  "Reply concisely, practically, and as an execution-oriented engineering assistant.",
  "Use plain text only unless the user explicitly asks for structured output."
].join(" ");

const runtime = new AgentRuntime({
  hubUrl,
  agentId,
  displayName: "OpenAI Agent",
  kind: "openai-agent",
  capabilities: ["status", "stop", "retry", "approve", "send_text", "custom"],
  quickCommands: ["status", "retry", "stop"]
});

type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

const transcript: ChatTurn[] = [];
let lastUserMessage: string | undefined;

async function publishDemoImage(): Promise<void> {
  const svg = [
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"360\">",
    "<rect width=\"640\" height=\"360\" fill=\"#101820\" />",
    "<rect x=\"24\" y=\"24\" width=\"592\" height=\"312\" rx=\"20\" fill=\"#1f3a5f\" />",
    "<text x=\"48\" y=\"100\" fill=\"#f2f7ff\" font-size=\"34\" font-family=\"monospace\">Personal Private Agent IM</text>",
    "<text x=\"48\" y=\"158\" fill=\"#9fd3ff\" font-size=\"22\" font-family=\"monospace\">Artifact preview from OpenAI bridge</text>",
    `<text x="48" y="214" fill="#d4e9ff" font-size="18" font-family="monospace">model: ${openAiModel}</text>`,
    "</svg>"
  ].join("");

  await runtime.uploadArtifact({
    kind: "image",
    fileName: "openai-preview.svg",
    mimeType: "image/svg+xml",
    caption: "OpenAI bridge artifact preview",
    contentBase64: Buffer.from(svg, "utf8").toString("base64")
  });
}

async function emitMissingApiKeyNotice(): Promise<void> {
  await runtime.emitEvent({
    eventType: "need_user_input",
    body: "OPENAI_API_KEY is missing. Set it before using send_text or retry.",
    status: "waiting_input"
  });
}

async function bootstrap(): Promise<void> {
  await runtime.connect();
  await runtime.emitEvent({
    eventType: "agent_started",
    body: openAiApiKey
      ? `OpenAI bridge is online with model ${openAiModel}.`
      : "OpenAI bridge is online, but OPENAI_API_KEY is not configured.",
    status: openAiApiKey ? "online" : "waiting_input"
  });
}

async function requestModelReply(userText: string): Promise<string> {
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const input = [
    {
      role: "system",
      content: systemPrompt
    },
    ...transcript.map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: userText
    }
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      input
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: HTTP ${response.status} ${body}`);
  }

  const payload = await response.json() as {
    output_text?: string;
  };
  const text = payload.output_text?.trim();
  if (!text) {
    throw new Error("OpenAI response did not include output_text");
  }
  return text;
}

async function answerUser(userText: string): Promise<void> {
  lastUserMessage = userText;
  transcript.push({ role: "user", content: userText });

  await runtime.emitEvent({
    eventType: "task_running",
    status: "busy"
  });

  try {
    const assistantText = await requestModelReply(userText);
    transcript.push({ role: "assistant", content: assistantText });
    await runtime.sendText(undefined, assistantText);
    await runtime.emitEvent({
      eventType: "task_completed",
      status: "completed"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown model error";
    await runtime.emitEvent({
      eventType: openAiApiKey ? "task_failed" : "need_user_input",
      body: message,
      status: openAiApiKey ? "failed" : "waiting_input"
    });
  }
}

runtime.onCommand(async (command) => {
  switch (command.type) {
    case "status":
      await runtime.sendText(
        undefined,
        openAiApiKey
          ? `Online. Model: ${openAiModel}. Turns: ${transcript.length}.`
          : "Online, but OPENAI_API_KEY is missing."
      );
      break;
    case "approve":
      await runtime.sendText(undefined, "Approval noted.");
      break;
    case "retry":
      if (!lastUserMessage) {
        await runtime.sendText(undefined, "Nothing to retry yet.");
        break;
      }
      await answerUser(lastUserMessage);
      break;
    case "send_text":
      if (!command.text?.trim()) {
        await runtime.sendText(undefined, "Please send a non-empty instruction.");
        break;
      }
      await answerUser(command.text.trim());
      break;
    case "stop":
      await runtime.close();
      process.exit(0);
      break;
    case "custom":
      if (command.text === "image_demo") {
        await publishDemoImage();
      } else {
        await runtime.sendText(undefined, "Unsupported custom command.");
      }
      break;
  }
});

bootstrap()
  .then(async () => {
    if (!openAiApiKey) {
      await emitMissingApiKeyNotice();
    }
  })
  .catch((error) => {
    console.error("openai agent failed", error);
    process.exit(1);
  });
