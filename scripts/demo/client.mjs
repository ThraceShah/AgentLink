import WebSocket from "ws";

const socket = new WebSocket("ws://127.0.0.1:8787/ws");
const targetAgentId = process.env.DEMO_AGENT_ID ?? "tmux-agent";
let commandedFromBootstrap = false;
let stopped = false;

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
      socket.send(JSON.stringify({
        type: "command",
        agentId: targetAgentId,
        command: {
          id: `cmd_${Date.now()}`,
          type: "send_text",
          text: process.env.DEMO_PROMPT ?? "Give me a concise status update for the current coding task."
        }
      }));
    }
  }

  if (message.type === "timeline_event" && message.event.agentId === targetAgentId && !stopped) {
    const done = ["text_output", "task_completed", "task_failed", "need_user_input"].includes(message.event.eventType);
    if (!done) {
      return;
    }
    stopped = true;
    socket.send(JSON.stringify({
      type: "command",
      agentId: targetAgentId,
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
