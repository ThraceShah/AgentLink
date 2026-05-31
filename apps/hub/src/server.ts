import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

const mobileWebRoot = path.resolve("apps", "mobile-web");
const staticMimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
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
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", time: nowIso() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/mobile") {
        res.writeHead(302, { location: "/mobile/" });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/mobile/")) {
        if (await serveMobileWeb(url.pathname, res)) {
          return;
        }
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

    if (req.method === "GET" && url.pathname === "/api/codex/tmux-candidates") {
      try {
        const candidates = await sessionManager.listCodexTmuxCandidates();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ candidates }));
        return;
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "failed_to_list_codex_tmux_candidates"
        }));
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/codex/history-candidates") {
      try {
        const result = await sessionManager.listCodexHistoryCandidates(url.searchParams.get("workdir") ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "failed_to_list_codex_history_candidates"
        }));
        return;
      }
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

    if (req.method === "POST" && url.pathname === "/api/codex/import-tmux") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          candidateId?: string;
          mode?: "fork" | "takeover";
          sessionName?: string;
        };

        const result = await sessionManager.importCodexTmuxSession({
          candidateId: payload.candidateId ?? "",
          mode: payload.mode ?? "fork",
          sessionName: payload.sessionName ?? "",
          hubUrl: `ws://127.0.0.1:${activePort}/ws`
        });
        for (const event of store.appendEvents(result.events)) {
          broadcastTimelineEvent(event);
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          sessionName: result.sessionName,
          candidate: result.candidate,
          importedEvents: result.events.length
        }));
        return;
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "failed_to_import_codex_tmux_session"
        }));
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/codex/import-history") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          threadId?: string;
          sessionName?: string;
          workdir?: string;
        };

        const result = await sessionManager.importCodexHistorySession({
          threadId: payload.threadId ?? "",
          sessionName: payload.sessionName ?? "",
          workdir: payload.workdir ?? "",
          hubUrl: `ws://127.0.0.1:${activePort}/ws`
        });
        for (const event of store.appendEvents(result.events)) {
          broadcastTimelineEvent(event);
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          sessionName: result.sessionName,
          candidate: result.candidate,
          importedEvents: result.events.length
        }));
        return;
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "failed_to_import_codex_history_session"
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
        const agentSocket = agentSockets.get(result.sessionName);
        if (agentSocket) {
          agentSockets.delete(result.sessionName);
          agentSocket.close(1000, "session deleted");
        }
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

    if (req.method === "POST" && url.pathname === "/api/sessions/clear-events") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          agentId?: string;
        };
        const agentId = payload.agentId?.trim();
        if (!agentId) {
          throw new Error("agentId is required");
        }
        store.clearAgentEvents(agentId);
        const agent = store.getAgent(agentId);
        if (agent) {
          broadcastAgentDelta(agent);
        }
        broadcastClients({
          type: "timeline_cleared",
          agentId
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ agentId }));
        return;
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : "failed_to_clear_events"
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
    } catch (error) {
      console.error("HTTP request handler error", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_server_error" }));
      }
    }
  });

  const websocketServer = new WebSocketServer({ server, path: "/ws" });

  function send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        console.error("WebSocket send error", error);
      }
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
    const updatedAgent = store.getAgent(message.agentId);
    if (updatedAgent) {
      broadcastAgentDelta(updatedAgent);
    }

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

      try {
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
        send(socket, {
          type: "heartbeat_ack",
          timestamp: nowIso()
        });
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
        const eventInput = {
          id: message.event.id ?? createId("evt"),
          timestamp: message.event.timestamp ?? nowIso(),
          ...message.event
        };
        const isTransient = message.event.metadata?.transient === true;
        const event = isTransient ? eventInput : store.appendEvent(eventInput);
        broadcastTimelineEvent(event);
        if (!isTransient) {
          const agent = store.getAgent(event.agentId);
          if (agent) {
            broadcastAgentDelta(agent);
          }
        }
        return;
      }

      if (message.type === "tui_menu") {
        const raw = JSON.parse(String(data)) as {
          type: string; agentId: string; menuId: string; title: string;
          body?: string;
          items: Array<{ id: string; label: string; description?: string; isInput?: boolean; inputPlaceholder?: string }>;
          timestamp: string;
        };
        broadcastClients({
          type: "tui_menu",
          agentId: raw.agentId,
          menuId: raw.menuId,
          title: raw.title,
          body: raw.body,
          items: raw.items,
          timestamp: raw.timestamp
        });
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

      if (message.type === "tui_menu_select") {
        const context = contexts.get(socket);
        if (context?.role !== "client") {
          send(socket, {
            type: "error",
            message: "tui_menu_select only allowed from client"
          });
          return;
        }
        const agentSocket = agentSockets.get(message.agentId);
        if (!agentSocket) {
          send(socket, {
            type: "error",
            message: `agent ${message.agentId} not connected`
          });
          return;
        }
        send(agentSocket, {
          type: "tui_menu_select",
          agentId: message.agentId,
          menuId: message.menuId,
          itemId: message.itemId,
          inputValue: message.inputValue
        });
        return;
      }
      } catch (error) {
        console.error("WebSocket message handler error", error);
        send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "internal_error"
        });
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

async function serveMobileWeb(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const relativePath = pathname === "/mobile/"
    ? "index.html"
    : decodeURIComponent(pathname.replace(/^\/mobile\/?/, ""));
  const candidate = path.resolve(mobileWebRoot, relativePath);

  if (!candidate.startsWith(`${mobileWebRoot}${path.sep}`) && candidate !== mobileWebRoot) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return true;
  }

  try {
    const info = await stat(candidate);
    const filePath = info.isDirectory() ? path.join(candidate, "index.html") : candidate;
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": staticMimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Global error handlers to prevent process crashes
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection at:", promise, "reason:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    // Don't exit immediately - allow graceful handling
  });

  const hub = createHubServer();
  hub.start().then(({ host, port }) => {
    console.log(`hub listening on http://${host}:${port}`);
  }).catch((error) => {
    console.error("hub failed to start", error);
    process.exit(1);
  });
}
