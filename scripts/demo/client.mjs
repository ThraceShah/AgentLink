import WebSocket from "ws";

const socket = new WebSocket("ws://127.0.0.1:8787/ws");
const targetAgentId = process.env.DEMO_AGENT_ID ?? "demo-agent";
let commandedFromBootstrap = false;
let approved = false;

socket.on("open", () => {
  socket.send(JSON.stringify({
    type: "hello",
    role: "client",
    client: {
      clientId: "demo-cli",
      platform: "node"
    }
  }));
});

socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  console.log("[demo-client]", message.type, JSON.stringify(message));

  if (message.type === "bootstrap" && !commandedFromBootstrap) {
    const agent = message.agents.find((item) => item.agentId === targetAgentId);
    if (agent) {
      commandedFromBootstrap = true;
      socket.send(JSON.stringify({
        type: "command",
        agentId: targetAgentId,
        command: {
          id: `cmd_${Date.now()}`,
          type: "status"
        }
      }));
    }

    const hasApproval = message.events.some(
      (event) => event.agentId === targetAgentId && event.eventType === "need_approval"
    );
    if (hasApproval && !approved) {
      approved = true;
      socket.send(JSON.stringify({
        type: "command",
        agentId: targetAgentId,
        command: {
          id: `cmd_${Date.now()}`,
          type: "approve"
        }
      }));
      socket.send(JSON.stringify({
        type: "command",
        agentId: targetAgentId,
        command: {
          id: `cmd_${Date.now()}`,
          type: "custom",
          text: "image_demo"
        }
      }));
      socket.send(JSON.stringify({
        type: "command",
        agentId: targetAgentId,
        command: {
          id: `cmd_${Date.now()}`,
          type: "stop"
        }
      }));
    }
  }

  if (message.type === "timeline_event" && message.event.eventType === "need_approval" && !approved) {
    approved = true;
    socket.send(JSON.stringify({
      type: "command",
      agentId: message.event.agentId,
      command: {
        id: `cmd_${Date.now()}`,
        type: "approve"
      }
    }));
    socket.send(JSON.stringify({
      type: "command",
      agentId: message.event.agentId,
      command: {
        id: `cmd_${Date.now()}`,
        type: "custom",
        text: "image_demo"
      }
    }));
    socket.send(JSON.stringify({
      type: "command",
      agentId: message.event.agentId,
      command: {
        id: `cmd_${Date.now()}`,
        type: "stop"
      }
    }));
  }
});

setTimeout(() => {
  socket.close();
}, 7000);
