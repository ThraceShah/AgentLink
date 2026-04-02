import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createHubServer } from "../src/server.js";

function waitForMessage(socket: WebSocket, predicate: (payload: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const listener = (data: WebSocket.RawData) => {
      const payload = JSON.parse(String(data));
      if (predicate(payload)) {
        socket.off("message", listener);
        resolve(payload);
      }
    };
    socket.on("message", listener);
  });
}

describe("hub integration", () => {
  const started: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    while (started.length > 0) {
      await started.pop()?.stop();
    }
  });

  it("registers agents and routes commands", async () => {
    const hub = createHubServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: "temp_docs/test-hub-data"
    });
    started.push(hub);
    const address = await hub.start();
    const wsUrl = `ws://${address.host}:${address.port}/ws`;

    const client = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => client.once("open", () => resolve()));
    client.send(JSON.stringify({
      type: "hello",
      role: "client",
      client: {
        clientId: "test-client",
        platform: "node"
      }
    }));

    await waitForMessage(client, (message) => message.type === "bootstrap");

    const agent = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => agent.once("open", () => resolve()));
    agent.send(JSON.stringify({
      type: "hello",
      role: "agent",
      agent: {
        agentId: "agent-1",
        displayName: "Agent One",
        kind: "demo",
        capabilities: ["status"],
        quickCommands: ["status"]
      }
    }));

    const delta = await waitForMessage(client, (message) =>
      message.type === "agent_delta" && message.agent.agentId === "agent-1"
    );
    expect(delta.agent.status).toBe("online");

    client.send(JSON.stringify({
      type: "command",
      agentId: "agent-1",
      command: {
        id: "cmd-1",
        type: "status"
      }
    }));

    const command = await waitForMessage(agent, (message) =>
      message.type === "command" && message.command.id === "cmd-1"
    );
    expect(command.command.type).toBe("status");

    agent.close();
    const offline = await waitForMessage(client, (message) =>
      message.type === "agent_delta" &&
      message.agent.agentId === "agent-1" &&
      message.agent.status === "offline"
    );
    expect(offline.agent.status).toBe("offline");

    client.close();
  });
});
