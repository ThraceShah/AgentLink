import { z } from "zod";

export const agentStatusSchema = z.enum([
  "online",
  "busy",
  "waiting_input",
  "completed",
  "failed",
  "offline"
]);

export const eventTypeSchema = z.enum([
  "agent_started",
  "task_running",
  "task_completed",
  "task_failed",
  "need_user_input",
  "need_approval",
  "artifact_generated",
  "image_available",
  "text_output",
  "user_command",
  "agent_stopped"
]);

export const commandTypeSchema = z.enum([
  "status",
  "stop",
  "retry",
  "approve",
  "send_text",
  "custom"
]);

export const artifactSchema = z.object({
  artifactId: z.string(),
  kind: z.enum(["image", "file", "text"]),
  fileName: z.string(),
  mimeType: z.string(),
  url: z.string(),
  caption: z.string().optional()
});

export const timelineEventSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  eventType: eventTypeSchema,
  timestamp: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  status: agentStatusSchema.optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  artifact: artifactSchema.optional()
});

export const commandSchema = z.object({
  id: z.string(),
  type: commandTypeSchema,
  text: z.string().optional(),
  args: z.record(z.string(), z.any()).optional()
});

export const agentSnapshotSchema = z.object({
  agentId: z.string(),
  displayName: z.string(),
  kind: z.string(),
  status: agentStatusSchema,
  sessionHint: z.string().optional(),
  capabilities: z.array(z.string()),
  quickCommands: z.array(commandTypeSchema).default([]),
  lastSeenAt: z.string(),
  lastMessage: z.string().optional()
});

export const clientHelloSchema = z.object({
  type: z.literal("hello"),
  role: z.literal("client"),
  client: z.object({
    clientId: z.string(),
    deviceName: z.string().optional(),
    platform: z.string().optional()
  })
});

export const agentHelloSchema = z.object({
  type: z.literal("hello"),
  role: z.literal("agent"),
  agent: z.object({
    agentId: z.string(),
    displayName: z.string(),
    kind: z.string(),
    sessionHint: z.string().optional(),
    capabilities: z.array(z.string()).default([]),
    quickCommands: z.array(commandTypeSchema).default([])
  })
});

export const heartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  timestamp: z.string()
});

export const agentEventMessageSchema = z.object({
  type: z.literal("agent_event"),
  event: timelineEventSchema.omit({ id: true, timestamp: true })
    .extend({
      id: z.string().optional(),
      timestamp: z.string().optional()
    })
});

export const commandMessageSchema = z.object({
  type: z.literal("command"),
  agentId: z.string(),
  command: commandSchema
});

export const artifactUploadSchema = z.object({
  type: z.literal("artifact_upload"),
  agentId: z.string(),
  upload: z.object({
    artifactId: z.string(),
    kind: z.enum(["image", "file", "text"]),
    fileName: z.string(),
    mimeType: z.string(),
    caption: z.string().optional(),
    contentBase64: z.string()
  })
});

export const incomingMessageSchema = z.union([
  clientHelloSchema,
  agentHelloSchema,
  heartbeatSchema,
  agentEventMessageSchema,
  commandMessageSchema,
  artifactUploadSchema
]);

export const welcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  role: z.enum(["client", "agent"]),
  serverTime: z.string()
});

export const bootstrapMessageSchema = z.object({
  type: z.literal("bootstrap"),
  agents: z.array(agentSnapshotSchema),
  events: z.array(timelineEventSchema)
});

export const agentDeltaMessageSchema = z.object({
  type: z.literal("agent_delta"),
  agent: agentSnapshotSchema
});

export const timelineEventMessageSchema = z.object({
  type: z.literal("timeline_event"),
  event: timelineEventSchema
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string()
});

export const outgoingMessageSchema = z.union([
  welcomeMessageSchema,
  bootstrapMessageSchema,
  agentDeltaMessageSchema,
  timelineEventMessageSchema,
  commandMessageSchema,
  errorMessageSchema
]);

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type CommandType = z.infer<typeof commandTypeSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;
export type CommandPayload = z.infer<typeof commandSchema>;
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export type OutgoingMessage = z.infer<typeof outgoingMessageSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function parseIncomingMessage(raw: string): IncomingMessage {
  return incomingMessageSchema.parse(JSON.parse(raw));
}

export function serializeMessage(message: OutgoingMessage | IncomingMessage): string {
  return JSON.stringify(message);
}

export function summarizeEvent(event: TimelineEvent): string {
  return event.title ?? event.body ?? event.eventType;
}

export function deriveStatusFromEvent(eventType: EventType): AgentStatus | undefined {
  switch (eventType) {
    case "agent_started":
      return "online";
    case "task_running":
      return "busy";
    case "need_user_input":
    case "need_approval":
      return "waiting_input";
    case "task_completed":
      return "completed";
    case "task_failed":
      return "failed";
    case "agent_stopped":
      return "offline";
    default:
      return undefined;
  }
}
