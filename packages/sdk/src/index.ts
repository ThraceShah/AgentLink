import WebSocket from "ws";

import {
  createId,
  nowIso,
  serializeMessage,
  type CommandPayload,
  type CommandType,
  type EventType,
  type SlashCommandNode,
  type TuiMenuSelect
} from "../../protocol/src/index.js";

type RuntimeOptions = {
  hubUrl: string;
  agentId: string;
  displayName: string;
  kind: string;
  sessionHint?: string;
  capabilities?: string[];
  quickCommands?: CommandType[];
  slashCommands?: SlashCommandNode[];
};

export type { SlashCommandNode, TuiMenuSelect };

type EventInput = {
  id?: string;
  eventType: EventType;
  title?: string;
  body?: string;
  status?: "online" | "busy" | "waiting_input" | "completed" | "failed" | "offline";
  metadata?: Record<string, unknown>;
};

type ArtifactInput = {
  artifactId?: string;
  kind: "image" | "file" | "text";
  fileName: string;
  mimeType: string;
  caption?: string;
  contentBase64: string;
};

export class AgentRuntime {
  private readonly options: RuntimeOptions;
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private commandHandler?: (command: CommandPayload) => Promise<void> | void;
  private tuiMenuSelectHandler?: (select: TuiMenuSelect) => Promise<void> | void;

  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.hubUrl);
      this.socket = socket;

      socket.on("open", () => {
        socket.send(serializeMessage({
          type: "hello",
          role: "agent",
          agent: {
            agentId: this.options.agentId,
            displayName: this.options.displayName,
            kind: this.options.kind,
            sessionHint: this.options.sessionHint,
            capabilities: this.options.capabilities ?? [],
            quickCommands: this.options.quickCommands ?? [],
            slashCommands: this.options.slashCommands ?? []
          }
        }));
        this.heartbeat = setInterval(() => {
          this.send({
            type: "heartbeat",
            timestamp: nowIso()
          });
        }, 15000);
        resolve();
      });

      socket.on("message", async (data) => {
        const payload = JSON.parse(String(data));
        if (payload.type === "command" && payload.agentId === this.options.agentId && this.commandHandler) {
          await this.commandHandler(payload.command as CommandPayload);
        }
        if (payload.type === "tui_menu_select" && payload.agentId === this.options.agentId && this.tuiMenuSelectHandler) {
          await this.tuiMenuSelectHandler(payload as TuiMenuSelect);
        }
      });

      socket.on("error", (error) => reject(error));
      socket.on("close", () => {
        if (this.heartbeat) {
          clearInterval(this.heartbeat);
        }
      });
    });
  }

  onCommand(handler: (command: CommandPayload) => Promise<void> | void): void {
    this.commandHandler = handler;
  }

  onTuiMenuSelect(handler: (select: TuiMenuSelect) => Promise<void> | void): void {
    this.tuiMenuSelectHandler = handler;
  }

  async emitEvent(input: EventInput): Promise<void> {
    this.send({
      type: "agent_event",
      event: {
        id: input.id ?? createId("evt"),
        agentId: this.options.agentId,
        eventType: input.eventType,
        timestamp: nowIso(),
        title: input.title,
        body: input.body,
        status: input.status,
        metadata: input.metadata
      }
    });
  }

  async emitTuiMenu(
    menuId: string,
    title: string,
    items: Array<{ id: string; label: string; description?: string; isInput?: boolean; inputPlaceholder?: string }>,
    body?: string
  ): Promise<void> {
    this.send({
      type: "tui_menu",
      agentId: this.options.agentId,
      menuId,
      title,
      body,
      items: items.map((item, idx) => ({
        id: item.id ?? `item_${idx}`,
        label: item.label,
        description: item.description,
        isInput: item.isInput,
        inputPlaceholder: item.inputPlaceholder
      })),
      timestamp: nowIso()
    });
  }

  async sendText(title: string | undefined, body: string): Promise<void> {
    await this.emitEvent({
      eventType: "text_output",
      title,
      body
    });
  }

  async uploadArtifact(input: ArtifactInput): Promise<void> {
    this.send({
      type: "artifact_upload",
      agentId: this.options.agentId,
      upload: {
        artifactId: input.artifactId ?? createId("artifact"),
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        caption: input.caption,
        contentBase64: input.contentBase64
      }
    });
  }

  async close(): Promise<void> {
    await this.emitEvent({
      eventType: "agent_stopped",
      title: "Agent stopped",
      status: "offline"
    });
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.socket?.close();
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }
}
