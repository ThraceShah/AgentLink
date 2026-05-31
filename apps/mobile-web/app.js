const state = {
  agents: [],
  events: [],
  profiles: [],
  sessionConfig: { workspaceRootHint: "~/code", hostUsername: "" },
  selectedAgentId: null,
  socket: null,
  socketState: "syncing",
  activeTuiMenu: null,
  codexImportCandidates: [],
  selectedCodexImportCandidateId: null,
  notifiedEventIds: new Set(),
  pollTimer: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  expandedProcesses: new Set()
};

const els = {
  listScreen: document.querySelector("#list-screen"),
  chatScreen: document.querySelector("#chat-screen"),
  hostLabel: document.querySelector("#host-label"),
  connectionStatus: document.querySelector("#connection-status"),
  refreshButton: document.querySelector("#refresh-button"),
  notifyButton: document.querySelector("#notify-button"),
  importCodexButton: document.querySelector("#import-codex-button"),
  newSessionButton: document.querySelector("#new-session-button"),
  agentSearch: document.querySelector("#agent-search"),
  agentList: document.querySelector("#agent-list"),
  backButton: document.querySelector("#back-button"),
  deleteSessionButton: document.querySelector("#delete-session-button"),
  chatTitle: document.querySelector("#chat-title"),
  chatSubtitle: document.querySelector("#chat-subtitle"),
  timeline: document.querySelector("#timeline"),
  slashPanel: document.querySelector("#slash-panel"),
  keypad: document.querySelector("#keypad"),
  messageInput: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  sessionDialog: document.querySelector("#session-dialog"),
  sessionForm: document.querySelector("#session-form"),
  profileSelect: document.querySelector("#profile-select"),
  sessionNameInput: document.querySelector("#session-name-input"),
  workdirInput: document.querySelector("#workdir-input"),
  cancelSessionButton: document.querySelector("#cancel-session-button"),
  importDialog: document.querySelector("#import-dialog"),
  importForm: document.querySelector("#import-form"),
  importCandidateList: document.querySelector("#import-candidate-list"),
  importSessionNameInput: document.querySelector("#import-session-name-input"),
  importNote: document.querySelector("#import-note"),
  refreshImportButton: document.querySelector("#refresh-import-button"),
  cancelImportButton: document.querySelector("#cancel-import-button"),
  tuiDialog: document.querySelector("#tui-dialog"),
  tuiTitle: document.querySelector("#tui-title"),
  tuiBody: document.querySelector("#tui-body"),
  tuiItems: document.querySelector("#tui-items"),
  tuiCancelButton: document.querySelector("#tui-cancel-button"),
  agentTemplate: document.querySelector("#agent-card-template")
};

function httpBase() {
  return window.location.origin;
}

function wsBase() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${httpBase()}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json();
}

async function refreshAll({ silent = false } = {}) {
  try {
    const [bootstrap, profiles, sessionConfig] = await Promise.all([
      api("/api/bootstrap"),
      api("/api/agent-profiles"),
      api("/api/session-config")
    ]);
    mergeBootstrap(bootstrap);
    state.profiles = profiles.profiles ?? [];
    state.sessionConfig = sessionConfig;
    els.hostLabel.textContent = sessionConfig.hostUsername || window.location.host;
    renderProfiles();
    render();
  } catch (error) {
    if (!silent) {
      toast(error.message || "Failed to refresh");
    }
  }
}

function mergeBootstrap(bootstrap) {
  state.agents = [...(bootstrap.agents ?? [])].sort(sortAgents);
  const persistentEvents = [...(bootstrap.events ?? [])];
  const activeTransientEvents = state.events.filter((event) =>
    event.metadata?.transient === true
    && ["process_started", "process_delta", "assistant_delta"].includes(event.eventType)
  );
  state.events = [...persistentEvents, ...activeTransientEvents]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function connectSocket() {
  clearTimeout(state.reconnectTimer);
  if (state.socket) {
    state.socket.close();
  }
  setConnection("syncing");
  const socket = new WebSocket(wsBase());
  state.socket = socket;

  socket.addEventListener("open", () => {
    setConnection("live");
    socket.send(JSON.stringify({
      type: "hello",
      role: "client",
      client: {
        clientId: createId("web"),
        deviceName: "Mobile Web",
        platform: "web"
      }
    }));
    startHeartbeat();
  });

  socket.addEventListener("message", (event) => {
    handleSocketMessage(event.data);
  });

  socket.addEventListener("close", () => {
    if (state.socket === socket) {
      setConnection("fallback");
      stopHeartbeat();
      state.reconnectTimer = setTimeout(connectSocket, 1500);
    }
  });

  socket.addEventListener("error", () => {
    setConnection("fallback");
  });
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "heartbeat", timestamp: new Date().toISOString() }));
    }
  }, 20000);
}

function stopHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function handleSocketMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.type === "bootstrap") {
    mergeBootstrap(message);
  } else if (message.type === "agent_delta") {
    upsertAgent(message.agent);
  } else if (message.type === "timeline_event") {
    upsertEvent(message.event);
    maybeNotify(message.event);
  } else if (message.type === "timeline_cleared") {
    state.events = state.events.filter((event) => event.agentId !== message.agentId);
  } else if (message.type === "tui_menu") {
    state.activeTuiMenu = message;
    showTuiMenu(message);
  } else if (message.type === "error") {
    toast(message.message);
  }
  render();
}

function upsertAgent(agent) {
  state.agents = state.agents.filter((item) => item.agentId !== agent.agentId);
  if (agent.status !== "offline") {
    state.agents.push(agent);
  }
  state.agents.sort(sortAgents);
}

function upsertEvent(event) {
  state.events = state.events.filter((item) => item.id !== event.id);
  state.events.push(event);
  state.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function sortAgents(a, b) {
  return lastActivity(b).localeCompare(lastActivity(a));
}

function lastActivity(agent) {
  const latest = eventsFor(agent.agentId).at(-1);
  return latest?.timestamp ?? agent.lastSeenAt ?? "";
}

function setConnection(value) {
  state.socketState = value;
  els.connectionStatus.textContent = value === "live" ? "Live" : value === "fallback" ? "Fallback" : "Syncing";
  els.connectionStatus.className = `status-pill ${value}`;
}

function render() {
  renderAgents();
  renderChat();
  renderSlashPanel();
}

function renderAgents() {
  const filter = els.agentSearch.value.trim().toLowerCase();
  els.agentList.replaceChildren();
  const agents = state.agents.filter((agent) =>
    !filter
    || agent.displayName.toLowerCase().includes(filter)
    || agent.kind.toLowerCase().includes(filter)
    || agent.agentId.toLowerCase().includes(filter)
  );

  if (agents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No sessions yet.";
    els.agentList.append(empty);
    return;
  }

  for (const agent of agents) {
    const node = els.agentTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector("strong").textContent = agent.displayName;
    node.querySelector("small").textContent = agent.lastMessage || `${agent.kind} · ${agent.status}`;
    node.querySelector(".agent-meta").textContent = shortTime(lastActivity(agent));
    node.addEventListener("click", () => selectAgent(agent.agentId));
    els.agentList.append(node);
  }
}

function renderChat() {
  const agent = selectedAgent();
  if (!agent) {
    return;
  }
  els.chatTitle.textContent = agent.displayName;
  els.chatSubtitle.textContent = `${agent.kind} · ${agent.status} · ${state.socketState === "live" ? "Live" : "Fallback"}`;
  els.timeline.replaceChildren();

  const visibleEvents = eventsFor(agent.agentId).filter(isVisibleEvent);
  const timelineItems = buildTimelineItems(visibleEvents);
  if (timelineItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Send a message or use a slash command.";
    els.timeline.append(empty);
    return;
  }

  for (const item of timelineItems) {
    els.timeline.append(renderTimelineItem(item, agent));
  }
  requestAnimationFrame(() => {
    els.timeline.scrollTop = els.timeline.scrollHeight;
  });
}

function renderTimelineItem(item, agent) {
  if (item.kind === "process") {
    return renderProcessItem(item, agent);
  }
  return renderEvent(item.event, agent);
}

function renderProcessItem(item, agent) {
  const latest = item.events.at(-1);
  const completed = item.completed != null;
  const expanded = state.expandedProcesses.has(item.processId) || !completed;
  const article = document.createElement("article");
  article.className = `message agent process ${completed ? "completed" : "active"}`;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${agent.displayName} · process · ${shortTime(latest?.timestamp)}`;
  article.append(meta);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "process-toggle";
  button.textContent = completed
    ? `${expanded ? "Hide" : "Show"} process · ${item.summary}`
    : item.summary;
  button.addEventListener("click", () => {
    if (state.expandedProcesses.has(item.processId)) {
      state.expandedProcesses.delete(item.processId);
    } else {
      state.expandedProcesses.add(item.processId);
    }
    renderChat();
  });
  article.append(button);

  if (expanded) {
    const list = document.createElement("div");
    list.className = "process-log";
    for (const event of item.events) {
      const row = document.createElement("div");
      row.className = "process-row";
      const title = event.title?.trim() || event.eventType;
      const body = event.body?.trim();
      row.textContent = body ? `${title}: ${body}` : title;
      list.append(row);
    }
    article.append(list);
  }
  return article;
}

function renderEvent(event, agent) {
  const item = document.createElement("article");
  const isUser = event.eventType === "user_command";
  const displayText = eventDisplayText(event) ?? event.eventType;
  item.className = `message ${isUser ? "user" : "agent"}`;
  item.title = "Tap to copy";
  item.addEventListener("click", () => copyText(displayText));

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${isUser ? "You" : agent.displayName} · ${shortTime(event.timestamp)}`;
  item.append(meta);

  const body = document.createElement("p");
  body.textContent = displayText;
  item.append(body);

  if (event.artifact?.kind === "image") {
    const img = document.createElement("img");
    img.src = event.artifact.url;
    img.alt = event.artifact.caption || event.artifact.fileName;
    item.append(img);
  } else if (event.artifact?.url) {
    const link = document.createElement("a");
    link.href = event.artifact.url;
    link.textContent = event.artifact.fileName;
    link.target = "_blank";
    item.append(link);
  }
  return item;
}

function renderSlashPanel() {
  const agent = selectedAgent();
  const input = els.messageInput.value.trim();
  els.slashPanel.replaceChildren();
  if (!agent || !input.startsWith("/") || agent.slashCommands.length === 0) {
    els.slashPanel.classList.add("hidden");
    return;
  }
  const filter = input.slice(1).toLowerCase();
  const commands = flattenCommands(agent.slashCommands)
    .filter(({ node }) =>
      !filter
      || node.label.toLowerCase().includes(filter)
      || node.id.toLowerCase().includes(filter)
      || (node.description ?? "").toLowerCase().includes(filter)
    )
    .slice(0, 12);
  for (const { node } of commands) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `/${node.label}`;
    button.addEventListener("click", () => {
      executeSlashCommand(node, null);
      els.messageInput.value = "";
      renderSlashPanel();
    });
    els.slashPanel.append(button);
  }
  els.slashPanel.classList.toggle("hidden", commands.length === 0);
}

function renderProfiles() {
  const previousProfileId = els.profileSelect.value;
  els.profileSelect.replaceChildren();
  for (const profile of state.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.label;
    els.profileSelect.append(option);
  }
  if (previousProfileId) {
    els.profileSelect.value = previousProfileId;
  }
}

function openSessionDialog() {
  if (!els.workdirInput.value.trim()) {
    els.workdirInput.value = state.sessionConfig.workspaceRootHint || "~/code";
  }
  els.sessionDialog.showModal();
}

async function openImportDialog() {
  await refreshCodexImportCandidates();
  els.importDialog.showModal();
}

async function refreshCodexImportCandidates() {
  try {
    const payload = await api("/api/codex/tmux-candidates");
    state.codexImportCandidates = payload.candidates ?? [];
    renderCodexImportCandidates();
  } catch (error) {
    state.codexImportCandidates = [];
    renderCodexImportCandidates();
    toast(error.message || "Failed to scan Codex sessions");
  }
}

function renderCodexImportCandidates() {
  els.importCandidateList.replaceChildren();
  if (
    state.codexImportCandidates.length > 0
    && !state.codexImportCandidates.some((item) => item.candidateId === state.selectedCodexImportCandidateId)
  ) {
    state.selectedCodexImportCandidateId = state.codexImportCandidates[0].candidateId;
  }
  for (const candidate of state.codexImportCandidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-item";
    button.dataset.selected = candidate.candidateId === state.selectedCodexImportCandidateId ? "true" : "false";
    const title = document.createElement("strong");
    title.textContent = candidate.tmuxSession;
    const meta = document.createElement("small");
    meta.textContent = `${candidate.title || candidate.threadId} · ${candidate.confidence}`;
    button.append(title, meta);
    button.addEventListener("click", () => {
      state.selectedCodexImportCandidateId = candidate.candidateId;
      els.importSessionNameInput.value = `${candidate.tmuxSession}-agentlink`;
      renderCodexImportCandidates();
    });
    els.importCandidateList.append(button);
  }
  const selected = selectedCodexImportCandidate();
  if (selected && !els.importSessionNameInput.value.trim()) {
    els.importSessionNameInput.value = `${selected.tmuxSession}-agentlink`;
  }
  els.importNote.textContent = selected
    ? [
      selected.preview || selected.title || selected.threadId,
      selected.cwd,
      selected.confidence === "exact" ? "Matched by thread id." : "Matched by latest Codex thread in cwd."
    ].filter(Boolean).join("\n")
    : "No Codex tmux sessions found.";
}

function selectedCodexImportCandidate() {
  return state.codexImportCandidates.find((item) => item.candidateId === state.selectedCodexImportCandidateId) ?? null;
}

function eventsFor(agentId) {
  return state.events.filter((event) => event.agentId === agentId);
}

function selectedAgent() {
  return state.agents.find((agent) => agent.agentId === state.selectedAgentId) ?? null;
}

function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  els.listScreen.classList.add("hidden");
  els.chatScreen.classList.remove("hidden");
  render();
}

function showList() {
  state.selectedAgentId = null;
  els.chatScreen.classList.add("hidden");
  els.listScreen.classList.remove("hidden");
  render();
}

function isVisibleEvent(event) {
  if (["process_started", "process_delta", "process_completed", "assistant_delta"].includes(event.eventType)) {
    return true;
  }
  if (["agent_started", "agent_stopped", "task_running", "task_completed"].includes(event.eventType)) {
    return false;
  }
  if (event.eventType === "user_command" && !event.body?.trim()) {
    return false;
  }
  return event.artifact != null || eventDisplayText(event) != null;
}

function buildTimelineItems(events) {
  const items = [];
  const processMap = new Map();
  for (const event of events) {
    if (["process_started", "process_delta", "process_completed", "assistant_delta"].includes(event.eventType)) {
      const processId = event.metadata?.processId || event.id;
      if (!processMap.has(processId)) {
        const processItem = {
          kind: "process",
          processId,
          events: [],
          completed: null,
          summary: "Codex is working..."
        };
        processMap.set(processId, processItem);
        items.push(processItem);
      }
      const processItem = processMap.get(processId);
      processItem.events.push(event);
      if (event.eventType === "process_completed") {
        processItem.completed = event;
      }
      processItem.summary = processSummary(processItem);
      continue;
    }
    items.push({ kind: "event", event });
  }
  return items;
}

function processSummary(item) {
  if (item.completed) {
    return item.completed.body?.trim() || item.completed.title || "Codex completed.";
  }
  const latest = item.events.at(-1);
  if (latest?.eventType === "assistant_delta") {
    return "Drafting reply...";
  }
  return latest?.body?.trim() || latest?.title || "Codex is working...";
}

function eventDisplayText(event) {
  const body = event.body?.trim();
  if (body) {
    return body;
  }
  const title = event.title?.trim();
  return title || null;
}

async function sendCurrentMessage() {
  const agent = selectedAgent();
  const input = els.messageInput.value.trim();
  if (!agent || !input) {
    return;
  }

  const matched = matchSlashCommand(agent.slashCommands, input);
  if (matched) {
    await executeSlashCommand(matched.node, matched.userInput);
  } else {
    await sendCommand(agent.agentId, "send_text", input);
  }
  els.messageInput.value = "";
  renderSlashPanel();
}

async function executeSlashCommand(node, userInput) {
  const agent = selectedAgent();
  if (!agent || !node.commandType) {
    return;
  }
  if (node.commandType === "send_text") {
    await sendCommand(agent.agentId, "send_text", userInput || `/${node.id}`);
  } else {
    await sendCommand(agent.agentId, node.commandType, userInput || undefined);
  }
}

async function sendCommand(agentId, type, text, args) {
  const commandId = createId("cmd");
  appendOptimistic(agentId, commandId, type, text);
  render();
  try {
    await api("/api/commands", {
      method: "POST",
      body: JSON.stringify({
        agentId,
        command: { id: commandId, type, text, args }
      })
    });
  } catch (error) {
    toast(error.message || "Command failed");
  }
}

function appendOptimistic(agentId, commandId, type, text) {
  upsertEvent({
    id: `user_${commandId}`,
    agentId,
    eventType: "user_command",
    timestamp: new Date().toISOString(),
    title: `Command: ${type}`,
    body: text,
    metadata: { source: "mobile-web" }
  });
}

function matchSlashCommand(commands, input) {
  if (!input.startsWith("/")) {
    return null;
  }
  const withoutSlash = input.slice(1).trim();
  const [token, ...rest] = withoutSlash.split(/\s+/);
  const node = findCommand(commands, token.toLowerCase());
  return node ? { node, userInput: rest.join(" ").trim() || null } : null;
}

function findCommand(commands, token) {
  for (const command of commands) {
    if (command.id.toLowerCase() === token || command.label.toLowerCase() === token) {
      return command;
    }
    const child = findCommand(command.children ?? [], token);
    if (child) {
      return child;
    }
  }
  return null;
}

function flattenCommands(commands) {
  const result = [];
  for (const node of commands) {
    if (!node.children?.length || node.requiresInput) {
      result.push({ node });
    }
    result.push(...flattenCommands(node.children ?? []));
  }
  return result;
}

function showTuiMenu(menu) {
  if (menu.agentId !== state.selectedAgentId) {
    selectAgent(menu.agentId);
  }
  els.tuiTitle.textContent = menu.title;
  els.tuiBody.textContent = menu.body || "";
  els.tuiBody.classList.toggle("hidden", !menu.body);
  els.tuiItems.replaceChildren();

  for (const item of menu.items ?? []) {
    if (item.isInput) {
      els.tuiItems.append(renderInputTuiItem(menu, item));
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tui-item";
    button.innerHTML = `<strong>${escapeHtml(item.label)}</strong>${item.description ? `<small>${escapeHtml(item.description)}</small>` : ""}`;
    button.addEventListener("click", () => sendTuiSelect(menu, item.id));
    els.tuiItems.append(button);
  }
  els.keypad.classList.remove("hidden");
  els.tuiDialog.showModal();
}

function renderInputTuiItem(menu, item) {
  const wrap = document.createElement("div");
  wrap.className = "input-action";
  const input = document.createElement("input");
  input.placeholder = item.inputPlaceholder || "Enter value...";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = item.label;
  button.addEventListener("click", () => sendTuiSelect(menu, item.id, input.value));
  wrap.append(input, button);
  return wrap;
}

function sendTuiSelect(menu, itemId, inputValue) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    toast("WebSocket is not connected.");
    return;
  }
  state.socket.send(JSON.stringify({
    type: "tui_menu_select",
    agentId: menu.agentId,
    menuId: menu.menuId,
    itemId,
    inputValue: inputValue || undefined
  }));
  state.activeTuiMenu = null;
  els.tuiDialog.close();
  els.keypad.classList.add("hidden");
}

async function sendSpecialKey(key) {
  const agent = selectedAgent();
  if (!agent) {
    return;
  }
  await sendCommand(agent.agentId, "send_key", undefined, { key });
}

async function createSession(event) {
  event.preventDefault();
  try {
    const sessionName = els.sessionNameInput.value.trim();
    const profileId = els.profileSelect.value;
    const workdir = els.workdirInput.value.trim();
    await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionName, profileId, workdir })
    });
    els.sessionDialog.close();
    await refreshAll();
  } catch (error) {
    toast(error.message || "Failed to create session");
  }
}

async function importCodexSession(event) {
  event.preventDefault();
  const candidate = selectedCodexImportCandidate();
  if (!candidate) {
    toast("No Codex tmux session selected.");
    return;
  }
  const mode = document.querySelector("input[name='import-mode']:checked")?.value || "fork";
  try {
    const payload = await api("/api/codex/import-tmux", {
      method: "POST",
      body: JSON.stringify({
        candidateId: candidate.candidateId,
        mode,
        sessionName: els.importSessionNameInput.value.trim()
      })
    });
    els.importDialog.close();
    await refreshAll();
    selectAgent(payload.sessionName);
  } catch (error) {
    toast(error.message || "Failed to import Codex session");
  }
}

async function deleteSelectedSession() {
  const agent = selectedAgent();
  if (!agent || !confirm(`Delete ${agent.displayName}?`)) {
    return;
  }
  try {
    await api("/api/sessions/delete", {
      method: "POST",
      body: JSON.stringify({ sessionName: agent.agentId })
    });
    state.agents = state.agents.filter((item) => item.agentId !== agent.agentId);
    state.events = state.events.filter((event) => event.agentId !== agent.agentId);
    showList();
    await refreshAll();
  } catch (error) {
    toast(error.message || "Failed to delete session");
  }
}

function maybeNotify(event) {
  if (state.notifiedEventIds.has(event.id) || event.eventType === "user_command") {
    return;
  }
  state.notifiedEventIds.add(event.id);
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  if (!["text_output", "need_user_input", "need_approval", "task_failed", "artifact_generated", "image_available"].includes(event.eventType)) {
    return;
  }
  const body = eventDisplayText(event);
  if (!body && !event.artifact) {
    return;
  }
  const agent = state.agents.find((item) => item.agentId === event.agentId);
  const notification = new Notification(agent?.displayName || "AgentLink", {
    body: body || event.artifact?.caption || event.artifact?.fileName || event.eventType,
    tag: event.id
  });
  notification.onclick = () => {
    window.focus();
    selectAgent(event.agentId);
    notification.close();
  };
}

async function requestNotifications() {
  if (!("Notification" in window)) {
    toast("This browser does not support notifications.");
    return;
  }
  const result = await Notification.requestPermission();
  toast(result === "granted" ? "Notifications enabled." : "Notifications not enabled.");
}

function shortTime(value) {
  if (!value) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function copyText(text) {
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Copy failed.");
  }
}

function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(node.hideTimer);
  node.hideTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

els.refreshButton.addEventListener("click", () => refreshAll());
els.notifyButton.addEventListener("click", requestNotifications);
els.importCodexButton.addEventListener("click", () => void openImportDialog());
els.newSessionButton.addEventListener("click", openSessionDialog);
els.cancelSessionButton.addEventListener("click", () => els.sessionDialog.close());
els.sessionForm.addEventListener("submit", createSession);
els.refreshImportButton.addEventListener("click", () => void refreshCodexImportCandidates());
els.cancelImportButton.addEventListener("click", () => els.importDialog.close());
els.importForm.addEventListener("submit", importCodexSession);
els.agentSearch.addEventListener("input", renderAgents);
els.backButton.addEventListener("click", showList);
els.deleteSessionButton.addEventListener("click", deleteSelectedSession);
els.sendButton.addEventListener("click", sendCurrentMessage);
els.messageInput.addEventListener("input", renderSlashPanel);
els.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendCurrentMessage();
  }
});
els.tuiCancelButton.addEventListener("click", () => {
  if (state.activeTuiMenu) {
    sendTuiSelect(state.activeTuiMenu, "__cancel__");
  } else {
    els.tuiDialog.close();
  }
});
els.keypad.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key]");
  if (button) {
    void sendSpecialKey(button.dataset.key);
  }
});

setInterval(() => {
  refreshAll({ silent: true });
}, 3000);

refreshAll().then(() => {
  connectSocket();
  render();
});
