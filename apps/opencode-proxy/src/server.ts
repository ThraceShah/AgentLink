import { spawn } from "node:child_process";
import http from "node:http";

import { parseProviderStream } from "../../../agents/tmux-agent/src/stream-parser.js";
import { resolveProviderModel } from "../../../agents/tmux-agent/src/model-resolver.js";

type ChatCompletionRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
};

type ChatMessage = {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
};

type ProxyOptions = {
  host: string;
  port: number;
  workdir: string;
  backend: "qwen";
  modelId: string;
};

export async function createOpencodeProxyServer(options: ProxyOptions): Promise<http.Server> {
  const backendModel = await resolveProviderModel("qwen") ?? "glm-5";

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${options.host}:${options.port}`}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return respondJson(res, 200, {
          status: "ok",
          backend: options.backend,
          workdir: options.workdir,
          modelId: options.modelId,
          backendModel
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return respondJson(res, 200, {
          object: "list",
          data: [
            {
              id: options.modelId,
              object: "model",
              created: 0,
              owned_by: options.backend,
              metadata: {
                backendModel
              }
            }
          ]
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const requestBody = await readJson<ChatCompletionRequest>(req);
        const prompt = renderPrompt(requestBody.messages ?? []);
        const completion = await runQwenPrompt(prompt, options.workdir);
        return requestBody.stream
          ? respondStream(res, completion, options.modelId)
          : respondJson(res, 200, {
            id: "chatcmpl-local",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: options.modelId,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: completion
                },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          });
      }

      respondJson(res, 404, { error: "not_found" });
    } catch (error) {
      respondJson(res, 500, {
        error: error instanceof Error ? error.message : "proxy_request_failed"
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  return server;
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString()
  });
  res.end(payload);
}

function respondStream(res: http.ServerResponse, content: string, modelId: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close"
  });

  const chunks = [
    {
      id: "chatcmpl-local",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    },
    {
      id: "chatcmpl-local",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta: { content }, finish_reason: null }]
    },
    {
      id: "chatcmpl-local",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    }
  ];

  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function renderPrompt(messages: ChatCompletionRequest["messages"]): string {
  return (messages ?? [])
    .map((message) => {
      const role = (message.role ?? "user").toUpperCase();
      const text = flattenContent(message.content);
      return text ? `${role}:\n${text}` : undefined;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

function flattenContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => (part.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

async function runQwenPrompt(prompt: string, workdir: string): Promise<string> {
  const args = [
    "-p",
    prompt,
    "--yolo",
    "--add-dir",
    ".",
    "-o",
    "stream-json",
    "--include-partial-messages"
  ];

  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn("qwen", args, {
      cwd: workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      const snapshot = parseProviderStream("qwen", stdout);
      const text = snapshot.finalText ?? snapshot.partialText;
      if (code === 0 && text?.trim()) {
        resolve(text.trim());
        return;
      }

      const failure = stderr.trim() || text?.trim() || "qwen_proxy_failed";
      reject(new Error(failure));
    });
  });

  return result;
}

async function main(): Promise<void> {
  const host = process.env.OPENCODE_PROXY_HOST ?? "127.0.0.1";
  const port = Number(process.env.OPENCODE_PROXY_PORT ?? "18741");
  const workdir = process.env.OPENCODE_PROXY_WORKDIR ?? process.cwd();
  const backend = "qwen";
  const modelId = process.env.OPENCODE_PROXY_MODEL_ID ?? "qwen-cli";

  const server = await createOpencodeProxyServer({
    host,
    port,
    workdir,
    backend,
    modelId
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "opencode_proxy_failed");
    process.exit(1);
  });
}
