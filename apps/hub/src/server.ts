import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import WebSocket, { WebSocketServer } from "ws";

import {
  createId,
  nowIso,
  parseIncomingMessage,
  type AgentSnapshot,
  type TimelineEvent
} from "../../../packages/protocol/src/index.js";
import { SessionManager } from "./session-manager.js";
import { HubStore } from "./store.js";

type CreateHubServerOptions = {
  host?: string;
  port?: number;
  dataDir?: string;
};

type ConnectionContext = {
  role?: "client" | "agent";
  agentId?: string;
};

export function createHubServer(options: CreateHubServerOptions = {}) {
  const host = options.host ?? process.env.HUB_HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.HUB_PORT ?? 8787);
  const dataDir = options.dataDir ?? process.env.HUB_DATA_DIR ?? "data";
  const store = new HubStore();
  const sessionManager = new SessionManager();
  const clientSockets = new Set<WebSocket>();
  const agentSockets = new Map<string, WebSocket>();
  const contexts = new WeakMap<WebSocket, ConnectionContext>();
  let activePort = port;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", time: nowIso() }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(store.getBootstrap()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent-profiles") {
      const profiles = await sessionManager.listProfiles();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ profiles }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session-config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessionManager.getSessionConfig()));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/prune-offline") {
      const removedAgentIds = store.pruneOfflineAgents();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ removedAgentIds }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          sessionName?: string;
          profileId?: string;
          workdir?: string;
        };

        const result = await sessionManager.createSession({
          sessionName: payload.sessionName ?? "",
          profileId: payload.profileId ?? "",
          workdir: payload.workdir ?? "",
          hubUrl: `ws://127.0.0.1:${activePort}/ws`
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          sessionName: result.sessionName,
          profile: result.profile
        }));
        return;
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "failed_to_create_session"
        }));
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/delete") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          sessionName?: string;
        };
        const result = await sessionManager.deleteSession(payload.sessionName ?? "");
        store.clearAgent(result.sessionName);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionName: result.sessionName, removedAgentId: result.sessionName }));
        return;
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "failed_to_delete_session"
        }));
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/commands") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          agentId: string;
          command: {
            id: string;
            type: string;
            text?: string;
            args?: Record<string, unknown>;
          };
        };
        const result = routeCommand(payload);
        if (!result.ok) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "accepted" }));
        return;
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "invalid_command_request"
        }));
        return;
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      const filePath = path.join(dataDir, url.pathname.replace(/^\/+/, ""));
      try {
        const content = await readFile(filePath);
        res.writeHead(200);
        res.end(content);
        return;
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "artifact_not_found" }));
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const websocketServer = new WebSocketServer({ server, path: "/ws" });

  function send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function broadcastClients(message: unknown): void {
    for (const socket of clientSockets) {
      send(socket, message);
    }
  }

  async function persistArtifact(
    agentId: string,
    upload: {
      artifactId: string;
      kind: "image" | "file" | "text";
      fileName: string;
      mimeType: string;
      caption?: string;
      contentBase64: string;
    }
  ): Promise<TimelineEvent> {
    const dir = path.join(dataDir, "artifacts", agentId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, upload.fileName);
    await writeFile(filePath, Buffer.from(upload.contentBase64, "base64"));
    const url = `/artifacts/${agentId}/${upload.fileName}`;

    const event: TimelineEvent = {
      id: createId("evt"),
      agentId,
      eventType: upload.kind === "image" ? "image_available" : "artifact_generated",
      timestamp: nowIso(),
      title: upload.kind === "image" ? "Image available" : "Artifact generated",
      body: upload.caption ?? upload.fileName,
      artifact: {
        artifactId: upload.artifactId,
        kind: upload.kind,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        url,
        caption: upload.caption
      }
    };

    return store.appendEvent(event);
  }

  function sendBootstrap(socket: WebSocket): void {
    send(socket, {
      type: "bootstrap",
      ...store.getBootstrap()
    });
  }

  function broadcastAgentDelta(agent: AgentSnapshot): void {
    broadcastClients({
      type: "agent_delta",
      agent
    });
  }

  function broadcastTimelineEvent(event: TimelineEvent): void {
    broadcastClients({
      type: "timeline_event",
      event
    });
  }

  function routeCommand(message: {
    agentId: string;
    command: {
      id: string;
      type: string;
      text?: string;
      args?: Record<string, unknown>;
    };
  }): { ok: true } | { ok: false; error: string } {
    const agentSocket = agentSockets.get(message.agentId);
    if (!agentSocket) {
      return {
        ok: false,
        error: `agent ${message.agentId} is offline`
      };
    }

    const userEvent = store.appendEvent({
      id: `user_${message.command.id}`,
      agentId: message.agentId,
      eventType: "user_command",
      timestamp: nowIso(),
      title: `Command: ${message.command.type}`,
      body: message.command.text,
      metadata: message.command.args
    });
    broadcastTimelineEvent(userEvent);

    send(agentSocket, {
      type: "command",
      agentId: message.agentId,
      command: message.command
    });
    return { ok: true };
  }

  websocketServer.on("connection", (socket) => {
    contexts.set(socket, {});

    socket.on("message", async (data) => {
      let message;
      try {
        message = parseIncomingMessage(String(data));
      } catch (error) {
        send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "invalid_message"
        });
        return;
      }

      if (message.type === "hello" && message.role === "client") {
        contexts.set(socket, { role: "client" });
        clientSockets.add(socket);
        send(socket, { type: "welcome", role: "client", serverTime: nowIso() });
        sendBootstrap(socket);
        return;
      }

      if (message.type === "hello" && message.role === "agent") {
        const snapshot = store.upsertAgent({
          ...message.agent,
          status: "online"
        });
        contexts.set(socket, { role: "agent", agentId: message.agent.agentId });
        agentSockets.set(message.agent.agentId, socket);
        send(socket, { type: "welcome", role: "agent", serverTime: nowIso() });
        broadcastAgentDelta(snapshot);

        const event = store.appendEvent({
          id: createId("evt"),
          agentId: message.agent.agentId,
          eventType: "agent_started",
          timestamp: nowIso(),
          title: "Agent started",
          body: `${message.agent.displayName} is now online`,
          status: "online"
        });
        broadcastTimelineEvent(event);
        return;
      }

      if (message.type === "heartbeat") {
        const context = contexts.get(socket);
        if (context?.agentId) {
          const agent = store.getAgent(context.agentId);
          if (agent) {
            broadcastAgentDelta(store.upsertAgent({
              ...agent,
              status: agent.status
            }));
          }
        }
        return;
      }

      if (message.type === "agent_event") {
        const event = store.appendEvent({
          id: message.event.id ?? createId("evt"),
          timestamp: message.event.timestamp ?? nowIso(),
          ...message.event
        });
        broadcastTimelineEvent(event);
        const agent = store.getAgent(event.agentId);
        if (agent) {
          broadcastAgentDelta(agent);
        }
        return;
      }

      if (message.type === "artifact_upload") {
        const event = await persistArtifact(message.agentId, message.upload);
        broadcastTimelineEvent(event);
        const agent = store.getAgent(event.agentId);
        if (agent) {
          broadcastAgentDelta(agent);
        }
        return;
      }

      if (message.type === "command") {
        const result = routeCommand(message);
        if (!result.ok) {
          send(socket, {
            type: "error",
            message: result.error
          });
        }
      }
    });

    socket.on("close", () => {
      const context = contexts.get(socket);
      if (context?.role === "client") {
        clientSockets.delete(socket);
      }

      if (context?.role === "agent" && context.agentId) {
        agentSockets.delete(context.agentId);
        const result = store.markOffline(context.agentId);
        if (result.agent) {
          broadcastAgentDelta(result.agent);
        }
        if (result.event) {
          broadcastTimelineEvent(result.event);
        }
      }
    });
  });

  return {
    store,
    async start(): Promise<{ port: number; host: string }> {
      await mkdir(path.join(dataDir, "artifacts"), { recursive: true });
      await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      activePort = actualPort;
      return { port: actualPort, host };
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        websocketServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hub = createHubServer();
  hub.start().then(({ host, port }) => {
    console.log(`hub listening on http://${host}:${port}`);
  }).catch((error) => {
    console.error("hub failed to start", error);
    process.exit(1);
  });
}
