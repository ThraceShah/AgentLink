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
  codexHistoryCandidates: [],
  selectedCodexImportCandidateId: null,
  selectedCodexHistoryCandidateId: null,
  notifiedEventIds: new Set(),
  pollTimer: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  expandedProcesses: new Set(),
  pendingImport: null,
  activeCommand: null,
  modelOptions: [],
  selectedModelId: null,
  dismissedApprovalEventIds: new Set()
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
  bottomBackButton: document.querySelector("#bottom-back-button"),
  jumpTopButton: document.querySelector("#jump-top-button"),
  deleteSessionButton: document.querySelector("#delete-session-button"),
  chatTitle: document.querySelector("#chat-title"),
  chatSubtitle: document.querySelector("#chat-subtitle"),
  timeline: document.querySelector("#timeline"),
  slashPanel: document.querySelector("#slash-panel"),
  keypad: document.querySelector("#keypad"),
  messageInput: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  runtimeStrip: document.querySelector("#runtime-strip"),
  sessionDialog: document.querySelector("#session-dialog"),
  sessionForm: document.querySelector("#session-form"),
  profileSelect: document.querySelector("#profile-select"),
  sessionNameInput: document.querySelector("#session-name-input"),
  workdirInput: document.querySelector("#workdir-input"),
  cancelSessionButton: document.querySelector("#cancel-session-button"),
  importDialog: document.querySelector("#import-dialog"),
  importForm: document.querySelector("#import-form"),
  importCandidateList: document.querySelector("#import-candidate-list"),
  tmuxImportMode: document.querySelector("#tmux-import-mode"),
  historyWorkdirLabel: document.querySelector("#history-workdir-label"),
  historyWorkdirInput: document.querySelector("#history-workdir-input"),
  importNameDialog: document.querySelector("#import-name-dialog"),
  importNameForm: document.querySelector("#import-name-form"),
  importSessionNameInput: document.querySelector("#import-session-name-input"),
  importNameNote: document.querySelector("#import-name-note"),
  cancelImportNameButton: document.querySelector("#cancel-import-name-button"),
  importNote: document.querySelector("#import-note"),
  refreshImportButton: document.querySelector("#refresh-import-button"),
  cancelImportButton: document.querySelector("#cancel-import-button"),
  tuiDialog: document.querySelector("#tui-dialog"),
  tuiTitle: document.querySelector("#tui-title"),
  tuiBody: document.querySelector("#tui-body"),
  tuiItems: document.querySelector("#tui-items"),
  tuiCancelButton: document.querySelector("#tui-cancel-button"),
  commandDialog: document.querySelector("#command-dialog"),
  commandForm: document.querySelector("#command-form"),
  commandTitle: document.querySelector("#command-title"),
  commandNote: document.querySelector("#command-note"),
  commandFields: document.querySelector("#command-fields"),
  submitCommandButton: document.querySelector("#submit-command-button"),
  cancelCommandButton: document.querySelector("#cancel-command-button"),
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
  if (!hasTimelineTextSelection()) {
    renderChat();
  }
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
    const pendingApproval = approvalPromptFor(agent);
    const node = els.agentTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("needs-approval", Boolean(pendingApproval));
    node.querySelector("strong").textContent = agent.displayName;
    node.querySelector("small").textContent = pendingApproval
      ? `Approval needed · ${eventDisplayText(pendingApproval)}`
      : agent.lastMessage || `${agent.kind} · ${agent.status}`;
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
  const shouldStickToBottom = isChatNearBottom();
  const pendingApproval = approvalPromptFor(agent);
  els.chatTitle.textContent = agent.displayName;
  els.chatSubtitle.textContent = pendingApproval
    ? `${agent.kind} · approval needed · ${state.socketState === "live" ? "Live" : "Fallback"}`
    : `${agent.kind} · ${agent.status} · ${state.socketState === "live" ? "Live" : "Fallback"}`;
  els.timeline.replaceChildren();

  const visibleEvents = eventsFor(agent.agentId).filter(isVisibleEvent);
  const timelineItems = buildTimelineItems(visibleEvents);
  if (timelineItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Send a message or use a slash command.";
    els.timeline.append(empty);
    renderRuntimeStrip(agent, pendingApproval);
    return;
  }

  for (const item of timelineItems) {
    els.timeline.append(renderTimelineItem(item, agent));
  }
  if (shouldStickToBottom) {
    scheduleChatBottomScroll();
  }
  renderRuntimeStrip(agent, pendingApproval);
}

function isChatNearBottom() {
  const timelineRemaining = els.timeline.scrollHeight - els.timeline.clientHeight - els.timeline.scrollTop;
  const windowRemaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
  return timelineRemaining < 96 && windowRemaining < 96;
}

function scrollChatToBottom() {
  els.timeline.scrollTop = els.timeline.scrollHeight;
  window.scrollTo(0, document.documentElement.scrollHeight);
}

function scheduleChatBottomScroll({ force = false } = {}) {
  if (!force && !isChatNearBottom()) {
    return;
  }
  requestAnimationFrame(() => {
    scrollChatToBottom();
    requestAnimationFrame(scrollChatToBottom);
  });
  setTimeout(scrollChatToBottom, 80);
}

function hasTimelineTextSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (els.timeline.contains(range.commonAncestorContainer)) {
      return true;
    }
  }
  return false;
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
  const isApproval = event.eventType === "need_approval";
  item.className = `message ${isUser ? "user" : "agent"}${isApproval ? " approval" : ""}`;

  const meta = document.createElement("div");
  meta.className = "meta";
  const metaText = document.createElement("span");
  metaText.textContent = `${isUser ? "You" : agent.displayName} · ${shortTime(event.timestamp)}`;
  meta.append(metaText);
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "copy-button";
  copyButton.textContent = "Copy";
  copyButton.addEventListener("click", () => copyText(displayText));
  meta.append(copyButton);
  item.append(meta);

  const body = document.createElement("p");
  body.textContent = displayText;
  item.append(body);

  if (isApproval) {
    item.append(renderApprovalActions(event, agent.agentId));
  }

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

function renderApprovalActions(event, agentId) {
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const allow = document.createElement("button");
  allow.type = "button";
  allow.textContent = "Approve";
  allow.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    approveRequest(agentId, event, "turn");
  });
  actions.append(allow);
  if (event.metadata?.allowForSession === true) {
    const allowSession = document.createElement("button");
    allowSession.type = "button";
    allowSession.textContent = "Allow session";
    allowSession.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      approveRequest(agentId, event, "session");
    });
    actions.append(allowSession);
  }
  return actions;
}

function renderRuntimeStrip(agent, pendingApproval = null) {
  els.runtimeStrip.replaceChildren();
  if (pendingApproval) {
    const bar = document.createElement("div");
    bar.className = "approval-strip";
    const label = document.createElement("span");
    label.textContent = "Approval needed";
    bar.append(label);
    bar.append(renderApprovalActions(pendingApproval, agent.agentId));
    els.runtimeStrip.append(bar);
    return;
  }
  const metadata = latestRuntimeMetadata(agent.agentId);
  const model = stringValue(metadata?.model) || agent.kind;
  const effort = stringValue(metadata?.reasoningEffort);
  const remaining = contextRemainingPercent(metadata);
  els.runtimeStrip.textContent = [
    model,
    effort ? `reasoning ${effort}` : "",
    remaining != null ? `context ${remaining}% left` : "context --"
  ].filter(Boolean).join(" · ");
}

function latestRuntimeMetadata(agentId) {
  const candidates = eventsFor(agentId)
    .map((event) => event.metadata)
    .filter((metadata) => metadata && typeof metadata === "object")
    .filter((metadata) =>
      metadata.model
      || metadata.reasoningEffort
      || metadata.contextUsedTokens != null
      || metadata.contextWindowTokens != null
    );
  return candidates.at(-1) ?? null;
}

function contextRemainingPercent(metadata) {
  const used = numberValue(metadata?.contextUsedTokens);
  const window = numberValue(metadata?.contextWindowTokens);
  if (used == null || window == null || window <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(((window - used) / window) * 100)));
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
      openOrExecuteSlashCommand(node, null);
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
  if (!els.historyWorkdirInput.value.trim()) {
    els.historyWorkdirInput.value = state.sessionConfig.workspaceRootHint || "~/code";
  }
  await refreshCodexImportCandidates();
  els.importDialog.showModal();
}

async function refreshCodexImportCandidates() {
  if (isHistoryImportSource()) {
    await refreshCodexHistoryCandidates();
    return;
  }
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

async function refreshCodexHistoryCandidates() {
  try {
    const workdir = els.historyWorkdirInput.value.trim();
    const payload = await api(`/api/codex/history-candidates?workdir=${encodeURIComponent(workdir)}`);
    state.codexHistoryCandidates = payload.candidates ?? [];
    renderCodexHistoryCandidates();
  } catch (error) {
    state.codexHistoryCandidates = [];
    renderCodexHistoryCandidates();
    toast(error.message || "Failed to scan Codex history");
  }
}

function renderCodexHistoryCandidates() {
  els.importCandidateList.replaceChildren();
  if (
    state.codexHistoryCandidates.length > 0
    && !state.codexHistoryCandidates.some((item) => item.candidateId === state.selectedCodexHistoryCandidateId)
  ) {
    const firstImportable = state.codexHistoryCandidates.find((item) => item.importable);
    state.selectedCodexHistoryCandidateId = (firstImportable ?? state.codexHistoryCandidates[0]).candidateId;
  }
  for (const candidate of state.codexHistoryCandidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-item history-candidate";
    button.dataset.selected = candidate.candidateId === state.selectedCodexHistoryCandidateId ? "true" : "false";
    button.dataset.importable = candidate.importable ? "true" : "false";
    const title = document.createElement("strong");
    title.textContent = truncateText(candidate.title || candidate.preview || candidate.id, 34);
    const meta = document.createElement("small");
    meta.textContent = formatHistoryMeta(candidate);
    button.append(title, meta);
    button.addEventListener("click", () => {
      state.selectedCodexHistoryCandidateId = candidate.candidateId;
      renderCodexHistoryCandidates();
    });
    els.importCandidateList.append(button);
  }
  const selected = selectedCodexHistoryCandidate();
  updateImportSourceMode();
  const importSubmit = els.importForm.querySelector("button[type='submit']");
  if (importSubmit) {
    importSubmit.disabled = !selected?.importable;
  }
  els.importNote.textContent = selected
    ? [
      truncateText(selected.preview || selected.title || selected.id, 160),
      selected.cwd,
      selected.importable ? "Matched Codex history thread for this workdir." : selected.reason
    ].filter(Boolean).join("\n")
    : "No Codex history found for this workdir.";
}

function renderCodexImportCandidates() {
  els.importCandidateList.replaceChildren();
  if (
    state.codexImportCandidates.length > 0
    && !state.codexImportCandidates.some((item) => item.candidateId === state.selectedCodexImportCandidateId)
  ) {
    const firstImportable = state.codexImportCandidates.find((item) => item.importable);
    state.selectedCodexImportCandidateId = (firstImportable ?? state.codexImportCandidates[0]).candidateId;
  }
  for (const candidate of state.codexImportCandidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-item";
    button.dataset.selected = candidate.candidateId === state.selectedCodexImportCandidateId ? "true" : "false";
    button.dataset.importable = candidate.importable ? "true" : "false";
    const title = document.createElement("strong");
    title.textContent = candidate.tmuxSession;
    const meta = document.createElement("small");
    meta.textContent = `${candidate.title || candidate.threadId || "No thread match"} · ${candidate.importable ? candidate.confidence : "not importable"}`;
    button.append(title, meta);
    button.addEventListener("click", () => {
      state.selectedCodexImportCandidateId = candidate.candidateId;
      renderCodexImportCandidates();
    });
    els.importCandidateList.append(button);
  }
  const selected = selectedCodexImportCandidate();
  updateImportSessionMode();
  const importSubmit = els.importForm.querySelector("button[type='submit']");
  if (importSubmit) {
    importSubmit.disabled = !selected?.importable;
  }
  els.importNote.textContent = selected
    ? [
      selected.preview || selected.title || selected.threadId,
      selected.cwd,
      selected.importable
        ? selected.confidence === "exact"
          ? "Matched by open Codex rollout file."
          : "Matched by visible prompt and a unique persisted Codex thread."
        : selected.reason || "Detected Codex TUI, but this pane is not importable yet."
    ].filter(Boolean).join("\n")
    : "No Codex tmux sessions found.";
}

function selectedCodexImportCandidate() {
  return state.codexImportCandidates.find((item) => item.candidateId === state.selectedCodexImportCandidateId) ?? null;
}

function selectedCodexHistoryCandidate() {
  return state.codexHistoryCandidates.find((item) => item.candidateId === state.selectedCodexHistoryCandidateId) ?? null;
}

function updateImportSessionMode() {
  // Import names are collected in the confirmation dialog.
}

function updateImportSourceMode() {
  const history = isHistoryImportSource();
  els.tmuxImportMode.classList.toggle("hidden", history);
  els.historyWorkdirLabel.classList.toggle("hidden", !history);
}

function isTakeoverImportMode() {
  return (document.querySelector("input[name='import-mode']:checked")?.value || "fork") === "takeover";
}

function isHistoryImportSource() {
  return (document.querySelector("input[name='import-source']:checked")?.value || "tmux") === "history";
}

function historySessionNameBase(candidate) {
  const readable = (candidate.title || candidate.preview || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return readable || `codex-${String(candidate.id || "history").slice(0, 8)}`;
}

function formatHistoryMeta(candidate) {
  return [
    candidate.updatedAt ? formatShortDate(candidate.updatedAt) : "",
    candidate.model || "codex",
    candidate.reasoningEffort || "",
    candidate.importable ? "" : "not importable"
  ].filter(Boolean).join(" · ");
}

function formatShortDate(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function truncateText(value, maxLength) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberValue(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventsFor(agentId) {
  return state.events.filter((event) => event.agentId === agentId);
}

function selectedAgent() {
  return state.agents.find((agent) => agent.agentId === state.selectedAgentId) ?? null;
}

function latestPendingApproval(agentId) {
  const events = eventsFor(agentId);
  const approval = events
    .filter((event) => event.eventType === "need_approval" && !state.dismissedApprovalEventIds.has(event.id))
    .at(-1);
  if (!approval) {
    return null;
  }
  const approvalIndex = events.findIndex((event) => event.id === approval.id);
  const laterCompletion = events.slice(approvalIndex + 1).some((event) =>
    event.eventType === "task_running"
    || event.eventType === "process_completed"
    || event.eventType === "text_output"
    || (event.eventType === "need_user_input" && event.status === "waiting_input")
  );
  return laterCompletion ? null : approval;
}

function approvalPromptFor(agent) {
  return latestPendingApproval(agent.agentId);
}

function selectAgent(agentId, { updateHistory = true } = {}) {
  state.selectedAgentId = agentId;
  els.listScreen.classList.add("hidden");
  els.chatScreen.classList.remove("hidden");
  if (updateHistory && history.state?.agentId !== agentId) {
    history.pushState({ screen: "chat", agentId }, "", `#session=${encodeURIComponent(agentId)}`);
  }
  render();
  scheduleChatBottomScroll({ force: true });
}

function showList({ updateHistory = true } = {}) {
  state.selectedAgentId = null;
  els.chatScreen.classList.add("hidden");
  els.listScreen.classList.remove("hidden");
  if (updateHistory && history.state?.screen === "chat") {
    history.pushState({ screen: "list" }, "", window.location.pathname + window.location.search);
  }
  render();
}

function showListFromBackNavigation() {
  state.selectedAgentId = null;
  els.chatScreen.classList.add("hidden");
  els.listScreen.classList.remove("hidden");
  render();
}

function navigateBackToList() {
  if (history.state?.screen === "chat") {
    history.back();
  } else {
    showList();
  }
}

function jumpTimelineTop() {
  els.timeline.scrollTo({ top: 0, behavior: "smooth" });
}

function sessionIdFromHash() {
  const match = window.location.hash.match(/^#session=(.+)$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function initializeNavigationState() {
  const agentId = sessionIdFromHash();
  if (agentId && state.agents.some((agent) => agent.agentId === agentId)) {
    history.replaceState({ screen: "chat", agentId }, "", window.location.href);
    selectAgent(agentId, { updateHistory: false });
    return;
  }
  history.replaceState({ screen: "list" }, "", window.location.pathname + window.location.search);
  showList({ updateHistory: false });
}

window.addEventListener("popstate", (event) => {
  const agentId = event.state?.agentId;
  if (event.state?.screen === "chat" && agentId && state.agents.some((agent) => agent.agentId === agentId)) {
    selectAgent(agentId, { updateHistory: false });
    return;
  }
  showListFromBackNavigation();
});

function isVisibleEvent(event) {
  if (event.metadata?.structured === true) {
    return false;
  }
  if (event.eventType === "user_command" && event.metadata?.internal === true) {
    return false;
  }
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
    await openOrExecuteSlashCommand(matched.node, matched.userInput);
  } else {
    await sendCommand(agent.agentId, "send_text", input);
  }
  els.messageInput.value = "";
  renderSlashPanel();
}

async function openOrExecuteSlashCommand(node, userInput) {
  const uiKind = node.ui?.kind;
  if (node.commandType === "custom" && uiKind && uiKind !== "direct" && !userInput) {
    await openCommandDialog(node);
    return;
  }
  await executeSlashCommand(node, userInput);
}

async function executeSlashCommand(node, userInput) {
  const agent = selectedAgent();
  if (!agent || !node.commandType) {
    return;
  }
  if (node.commandType === "custom") {
    await sendCommand(agent.agentId, "custom", userInput ? `/${node.id} ${userInput}` : `/${node.id}`, customSlashArgs(node, userInput));
    return;
  }
  if (node.commandType === "send_text") {
    await sendCommand(agent.agentId, "send_text", userInput || `/${node.id}`);
  } else {
    await sendCommand(agent.agentId, node.commandType, userInput || undefined);
  }
}

function customSlashArgs(node, userInput) {
  const args = { ...(node.args ?? {}) };
  const value = typeof userInput === "string" ? userInput.trim() : "";
  if (!value) {
    return args;
  }
  const command = args.codexCommand;
  if (command === "goal") {
    if (value === "status") {
      args.codexCommand = "goal.get";
    } else if (value === "clear") {
      args.codexCommand = "goal.clear";
    } else {
      args.codexCommand = "goal.set";
      args.objective = value;
    }
  } else if (command === "thread.rename") {
    args.name = value;
  } else if (command === "memory") {
    if (value === "reset") {
      args.codexCommand = "memory.reset";
    } else if (value === "on" || value === "enable") {
      args.codexCommand = "memory.mode";
      args.enabled = true;
    } else if (value === "off" || value === "disable") {
      args.codexCommand = "memory.mode";
      args.enabled = false;
    }
  } else if (command === "mcp.status" && value === "status") {
    args.codexCommand = "mcp.status";
  }
  return args;
}

async function openCommandDialog(node) {
  state.activeCommand = node;
  state.modelOptions = [];
  state.selectedModelId = null;
  els.commandTitle.textContent = node.ui?.title || `/${node.label}`;
  els.commandNote.textContent = node.description || "";
  els.commandNote.classList.toggle("hidden", !node.description);
  els.commandFields.replaceChildren();
  els.submitCommandButton.textContent = "Run";
  els.submitCommandButton.disabled = false;
  els.submitCommandButton.classList.remove("hidden");
  els.commandDialog.showModal();

  const kind = node.ui?.kind;
  if (kind === "codexModel") {
    await renderModelCommand(node);
  } else if (kind === "codexGoal") {
    renderGoalCommand();
  } else if (kind === "codexMemory") {
    renderMemoryCommand();
  } else if (kind === "textInput") {
    renderTextInputCommand(node);
  } else if (kind === "confirm") {
    renderConfirmCommand(node);
  }
}

async function renderModelCommand(node) {
  const agent = selectedAgent();
  if (!agent) {
    return;
  }
  els.submitCommandButton.textContent = "Apply";
  els.submitCommandButton.disabled = true;
  const loading = document.createElement("p");
  loading.className = "dialog-note";
  loading.textContent = "Loading models...";
  els.commandFields.append(loading);
  try {
    const commandId = createId("cmd");
    await api("/api/commands", {
      method: "POST",
      body: JSON.stringify({
        agentId: agent.agentId,
        command: { id: commandId, type: "custom", text: "/model", args: { codexCommand: "model.list", internal: true } }
      })
    });
    await waitForStructuredEvent(agent.agentId, "model.list");
    const payload = latestStructuredPayload(agent.agentId, "model.list");
    state.modelOptions = payload?.models ?? [];
    state.selectedModelId = payload?.currentModel ?? state.modelOptions[0]?.id ?? null;
    els.commandFields.replaceChildren();
    const list = document.createElement("div");
    list.className = "model-list";
    for (const model of state.modelOptions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-option";
      button.dataset.modelId = model.id;
      button.dataset.selected = model.id === state.selectedModelId ? "true" : "false";
      button.innerHTML = `<strong>${escapeHtml(model.label || model.id)}</strong>`;
      button.addEventListener("click", () => {
        state.selectedModelId = model.id;
        renderModelCommandSelection(list);
      });
      list.append(button);
    }
    els.commandFields.append(list);
    const effortLabel = document.createElement("label");
    effortLabel.textContent = "Reasoning effort";
    const select = document.createElement("select");
    select.id = "command-reasoning-effort";
    effortLabel.append(select);
    els.commandFields.append(effortLabel);
    renderReasoningOptions();
    els.submitCommandButton.disabled = state.modelOptions.length === 0;
  } catch (error) {
    els.commandFields.replaceChildren();
    const note = document.createElement("p");
    note.className = "dialog-note";
    note.textContent = error.message || "Failed to load models.";
    els.commandFields.append(note);
  }
}

function renderModelCommandSelection(list) {
  for (const button of list.querySelectorAll(".model-option")) {
    const id = button.dataset.modelId || "";
    button.dataset.selected = id === state.selectedModelId ? "true" : "false";
  }
  renderReasoningOptions();
}

function renderReasoningOptions() {
  const select = document.querySelector("#command-reasoning-effort");
  if (!select) {
    return;
  }
  const model = state.modelOptions.find((item) => item.id === state.selectedModelId);
  select.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = model?.defaultReasoningEffort ? `Default (${model.defaultReasoningEffort})` : "Default";
  select.append(defaultOption);
  const efforts = model?.supportedReasoningEfforts?.length
    ? model.supportedReasoningEfforts
    : ["none", "minimal", "low", "medium", "high", "xhigh"].map((id) => ({ id, label: id }));
  for (const effort of efforts) {
    const option = document.createElement("option");
    option.value = effort.id;
    option.textContent = effort.label || effort.id;
    select.append(option);
  }
}

function renderGoalCommand() {
  els.submitCommandButton.textContent = "Set Goal";
  const actions = document.createElement("div");
  actions.className = "command-actions";
  actions.append(commandActionButton("Show Current Goal", () => runCommandDialogArgs({ codexCommand: "goal.get" })));
  actions.append(commandActionButton("Clear Goal", () => runCommandDialogArgs({ codexCommand: "goal.clear" }, "Clear current goal?")));
  els.commandFields.append(actions);
  const objective = labeledTextarea("Objective", "Improve benchmark coverage");
  objective.querySelector("textarea").id = "command-goal-objective";
  els.commandFields.append(objective);
  const budget = labeledInput("Token budget (optional)", "number", "50000");
  budget.querySelector("input").id = "command-goal-budget";
  els.commandFields.append(budget);
}

function renderMemoryCommand() {
  els.submitCommandButton.classList.add("hidden");
  const actions = document.createElement("div");
  actions.className = "command-actions";
  actions.append(commandActionButton("Enable Memory", () => runCommandDialogArgs({ codexCommand: "memory.mode", enabled: true })));
  actions.append(commandActionButton("Disable Memory", () => runCommandDialogArgs({ codexCommand: "memory.mode", enabled: false })));
  actions.append(commandActionButton("Reset Local Memories", () => runCommandDialogArgs({ codexCommand: "memory.reset" }, "Reset local Codex memories?")));
  els.commandFields.append(actions);
}

function renderTextInputCommand(node) {
  els.submitCommandButton.textContent = "Run";
  const field = labeledInput(node.ui?.label || "Value", "text", node.ui?.placeholder || "");
  field.querySelector("input").id = "command-text-value";
  els.commandFields.append(field);
}

function renderConfirmCommand(node) {
  els.submitCommandButton.textContent = "Confirm";
  const note = document.createElement("p");
  note.className = "dialog-note";
  note.textContent = node.ui?.body || node.description || "Confirm this command.";
  els.commandFields.append(note);
}

function commandActionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function labeledInput(labelText, type, placeholder) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.placeholder = placeholder;
  label.append(input);
  return label;
}

function labeledTextarea(labelText, placeholder) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const textarea = document.createElement("textarea");
  textarea.placeholder = placeholder;
  label.append(textarea);
  return label;
}

async function submitCommandDialog(event) {
  event.preventDefault();
  const node = state.activeCommand;
  if (!node) {
    els.commandDialog.close();
    return;
  }
  const kind = node.ui?.kind;
  if (kind === "codexModel") {
    await runCommandDialogArgs({
      codexCommand: "model.set",
      model: state.selectedModelId,
      reasoningEffort: document.querySelector("#command-reasoning-effort")?.value || undefined
    });
  } else if (kind === "codexGoal") {
    const objective = document.querySelector("#command-goal-objective")?.value.trim() || "";
    if (!objective) {
      toast("Goal objective is required.");
      return;
    }
    await runCommandDialogArgs({
      codexCommand: "goal.set",
      objective,
      tokenBudget: document.querySelector("#command-goal-budget")?.value || undefined
    });
  } else if (kind === "textInput") {
    const value = document.querySelector("#command-text-value")?.value.trim() || "";
    if (!value) {
      toast("Value is required.");
      return;
    }
    await runCommandDialogArgs({ ...(node.args ?? {}), name: value });
  } else {
    await runCommandDialogArgs({ ...(node.args ?? {}) });
  }
}

async function runCommandDialogArgs(args, confirmText) {
  if (confirmText && !confirm(confirmText)) {
    return;
  }
  const agent = selectedAgent();
  const node = state.activeCommand;
  if (!agent || !node) {
    return;
  }
  await sendCommand(agent.agentId, "custom", `/${node.id}`, args);
  els.submitCommandButton.classList.remove("hidden");
  els.commandDialog.close();
}

async function waitForStructuredEvent(agentId, codexCommand) {
  const start = Date.now();
  while (Date.now() - start < 2500) {
    if (latestStructuredPayload(agentId, codexCommand)) {
      return;
    }
    await refreshAll({ silent: true });
    if (latestStructuredPayload(agentId, codexCommand)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Timed out waiting for Codex.");
}

function latestStructuredPayload(agentId, codexCommand) {
  const event = eventsFor(agentId)
    .filter((item) => item.metadata?.structured === true && item.metadata?.codexCommand === codexCommand)
    .at(-1);
  if (!event?.body) {
    return null;
  }
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

async function sendCommand(agentId, type, text, args) {
  const commandId = createId("cmd");
  if (args?.internal !== true) {
    appendOptimistic(agentId, commandId, type, text);
  }
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

async function approveRequest(agentId, event, scope) {
  try {
    const menuId = stringValue(event.metadata?.pendingMenuId);
    if (menuId && state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({
        type: "tui_menu_select",
        agentId,
        menuId,
        itemId: scope === "session" ? "__allow_session__" : "__allow__"
      }));
    } else {
      await api("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          agentId,
          command: {
            id: createId("cmd"),
            type: "approve",
            text: scope === "session" ? "session" : undefined
          }
        })
      });
    }
    state.dismissedApprovalEventIds.add(event.id);
    render();
  } catch (error) {
    toast(error.message || "Approval failed");
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
  if (isHistoryImportSource()) {
    const candidate = selectedCodexHistoryCandidate();
    if (!candidate) {
      toast("No Codex history selected.");
      return;
    }
    if (!candidate.importable) {
      toast(candidate.reason || "Selected Codex history is not importable.");
      return;
    }
    openImportNameDialog({
      source: "history",
      candidate,
      defaultSessionName: `${historySessionNameBase(candidate)}-agentlink`,
      note: candidate.preview || candidate.title || candidate.id
    });
    return;
  }
  const candidate = selectedCodexImportCandidate();
  if (!candidate) {
    toast("No Codex tmux session selected.");
    return;
  }
  if (!candidate.importable) {
    toast(candidate.reason || "Selected Codex tmux session is not importable yet.");
    return;
  }
  const mode = document.querySelector("input[name='import-mode']:checked")?.value || "fork";
  openImportNameDialog({
    source: "tmux",
    candidate,
    mode,
    defaultSessionName: mode === "takeover" ? candidate.tmuxSession : `${candidate.tmuxSession}-agentlink`,
    note: candidate.preview || candidate.title || candidate.threadId
  });
}

function openImportNameDialog(pendingImport) {
  state.pendingImport = pendingImport;
  els.importSessionNameInput.value = pendingImport.defaultSessionName;
  els.importSessionNameInput.disabled = pendingImport.source === "tmux" && pendingImport.mode === "takeover";
  els.importNameNote.textContent = truncateText(pendingImport.note || pendingImport.defaultSessionName, 140);
  els.importNameDialog.showModal();
  els.importSessionNameInput.focus();
  els.importSessionNameInput.select();
}

async function confirmImportSession(event) {
  event.preventDefault();
  const pendingImport = state.pendingImport;
  if (!pendingImport) {
    els.importNameDialog.close();
    return;
  }
  if (pendingImport.source === "history") {
    await importCodexHistorySession(pendingImport.candidate, els.importSessionNameInput.value.trim());
  } else {
    await importCodexTmuxSession(pendingImport.candidate, pendingImport.mode, els.importSessionNameInput.value.trim());
  }
}

async function importCodexTmuxSession(candidate, mode, sessionName) {
  try {
    const payload = await api("/api/codex/import-tmux", {
      method: "POST",
      body: JSON.stringify({
        candidateId: candidate.candidateId,
        mode,
        sessionName
      })
    });
    state.pendingImport = null;
    els.importNameDialog.close();
    els.importDialog.close();
    await refreshAll();
    selectAgent(payload.sessionName);
  } catch (error) {
    toast(error.message || "Failed to import Codex session");
  }
}

async function importCodexHistorySession(candidate, sessionName) {
  try {
    const payload = await api("/api/codex/import-history", {
      method: "POST",
      body: JSON.stringify({
        threadId: candidate.id,
        workdir: els.historyWorkdirInput.value.trim(),
        sessionName
      })
    });
    state.pendingImport = null;
    els.importNameDialog.close();
    els.importDialog.close();
    await refreshAll();
    selectAgent(payload.sessionName);
  } catch (error) {
    toast(error.message || "Failed to import Codex history");
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
els.cancelImportNameButton.addEventListener("click", () => {
  state.pendingImport = null;
  els.importNameDialog.close();
});
els.importNameForm.addEventListener("submit", confirmImportSession);
for (const item of document.querySelectorAll("input[name='import-source']")) {
  item.addEventListener("change", () => {
    state.selectedCodexImportCandidateId = null;
    state.selectedCodexHistoryCandidateId = null;
    updateImportSourceMode();
    void refreshCodexImportCandidates();
  });
}
els.historyWorkdirInput.addEventListener("change", () => {
  state.selectedCodexHistoryCandidateId = null;
  if (isHistoryImportSource()) {
    void refreshCodexHistoryCandidates();
  }
});
for (const item of document.querySelectorAll("input[name='import-mode']")) {
  item.addEventListener("change", updateImportSessionMode);
}
els.agentSearch.addEventListener("input", renderAgents);
els.backButton.addEventListener("click", navigateBackToList);
els.bottomBackButton.addEventListener("click", navigateBackToList);
els.jumpTopButton.addEventListener("click", jumpTimelineTop);
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
els.cancelCommandButton.addEventListener("click", () => {
  els.submitCommandButton.classList.remove("hidden");
  els.commandDialog.close();
});
els.commandForm.addEventListener("submit", submitCommandDialog);
els.commandDialog.addEventListener("close", () => {
  state.activeCommand = null;
  state.modelOptions = [];
  state.selectedModelId = null;
  els.submitCommandButton.classList.remove("hidden");
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
  initializeNavigationState();
});
