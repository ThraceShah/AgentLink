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
  lastSeenAt?: string;
  lastMessage?: string;
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
      slashCommands: agent.slashCommands ?? [],
      status: agent.status ?? previous?.status ?? "online",
      lastSeenAt: agent.lastSeenAt ?? previous?.lastSeenAt ?? nowIso(),
      lastMessage: agent.lastMessage ?? previous?.lastMessage
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
    const next = [...currentEvents.filter((item) => item.id !== event.id), event]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-this.maxEventsPerAgent);
    this.events.set(event.agentId, next);

    const snapshot = this.agents.get(event.agentId);
    if (snapshot) {
      const derived = deriveStatusFromEvent(event.eventType);
      const summary = summarizeEvent(event);
      this.agents.set(event.agentId, {
        ...snapshot,
        status: event.status ?? derived ?? snapshot.status,
        lastSeenAt: event.timestamp,
        lastMessage: summary ?? snapshot.lastMessage
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

  clearAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.events.delete(agentId);
  }

  pruneOfflineAgents(): string[] {
    const removedIds: string[] = [];
    for (const [agentId, snapshot] of this.agents.entries()) {
      if (snapshot.status !== "offline") {
        continue;
      }

      removedIds.push(agentId);
      this.clearAgent(agentId);
    }
    return removedIds;
  }
}
