import {
  createId,
  deriveStatusFromEvent,
  nowIso,
  summarizeEvent,
  type AgentSnapshot,
  type TimelineEvent
} from "../../../packages/protocol/src/index.js";

type AgentInit = Omit<AgentSnapshot, "lastSeenAt" | "status" | "lastMessage"> & {
  status?: AgentSnapshot["status"];
};

export class HubStore {
  private readonly agents = new Map<string, AgentSnapshot>();
  private readonly events = new Map<string, TimelineEvent[]>();
  private readonly maxEventsPerAgent = 100;

  upsertAgent(agent: AgentInit): AgentSnapshot {
    const previous = this.agents.get(agent.agentId);
    const snapshot: AgentSnapshot = {
      agentId: agent.agentId,
      displayName: agent.displayName,
      kind: agent.kind,
      sessionHint: agent.sessionHint,
      capabilities: agent.capabilities,
      quickCommands: agent.quickCommands,
      status: agent.status ?? previous?.status ?? "online",
      lastSeenAt: nowIso(),
      lastMessage: previous?.lastMessage
    };
    this.agents.set(snapshot.agentId, snapshot);
    return snapshot;
  }

  markOffline(agentId: string, title = "Agent disconnected"): { agent?: AgentSnapshot; event?: TimelineEvent } {
    const current = this.agents.get(agentId);
    if (!current) {
      return {};
    }
    const snapshot: AgentSnapshot = {
      ...current,
      status: "offline",
      lastSeenAt: nowIso(),
      lastMessage: title
    };
    this.agents.set(agentId, snapshot);

    const event = this.appendEvent({
      id: createId("evt"),
      agentId,
      eventType: "agent_stopped",
      timestamp: nowIso(),
      title,
      status: "offline"
    });

    return { agent: snapshot, event };
  }

  appendEvent(event: TimelineEvent): TimelineEvent {
    const currentEvents = this.events.get(event.agentId) ?? [];
    const next = [...currentEvents, event].slice(-this.maxEventsPerAgent);
    this.events.set(event.agentId, next);

    const snapshot = this.agents.get(event.agentId);
    if (snapshot) {
      const derived = deriveStatusFromEvent(event.eventType);
      this.agents.set(event.agentId, {
        ...snapshot,
        status: event.status ?? derived ?? snapshot.status,
        lastSeenAt: event.timestamp,
        lastMessage: summarizeEvent(event)
      });
    }

    return event;
  }

  getBootstrap(): { agents: AgentSnapshot[]; events: TimelineEvent[] } {
    const agents = [...this.agents.values()].sort((a, b) =>
      b.lastSeenAt.localeCompare(a.lastSeenAt)
    );
    const events = [...this.events.values()].flat().sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );
    return { agents, events };
  }

  getAgent(agentId: string): AgentSnapshot | undefined {
    return this.agents.get(agentId);
  }
}
