package im.agent.link

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class MainUiState(
    val hubOrigin: String = "",
    val agents: List<AgentSnapshot> = emptyList(),
    val events: List<TimelineEvent> = emptyList(),
    val profiles: List<AgentProfile> = emptyList(),
    val workspaceRootHint: String = "~/code",
    val hostUsername: String = "",
    val selectedAgentId: String? = null,
    val isConnecting: Boolean = false,
    val isCreatingSession: Boolean = false,
    val connectionError: String? = null,
    val socketState: SocketConnectionState = SocketConnectionState.DISCONNECTED,
    val activeTuiMenu: TuiMenu? = null
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val connectedRefreshIntervalMs = 3_000L
    private val disconnectedRefreshIntervalMs = 2_000L

    private val configStore = HubConfigStore(application)
    private var repository: HubRepository? = null
    private var pollingJob: Job? = null

    private val _uiState = MutableStateFlow(MainUiState(hubOrigin = configStore.load().origin))
    val uiState: StateFlow<MainUiState> = _uiState.asStateFlow()

    fun load() {
        connect()
    }

    fun updateHubOrigin(origin: String) {
        _uiState.value = _uiState.value.copy(hubOrigin = origin)
    }

    fun refreshFromHub() {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                repository?.fetchBootstrap()
            }.onSuccess { bootstrap ->
                if (bootstrap != null) {
                    mergeBootstrap(bootstrap)
                    _uiState.value = _uiState.value.copy(connectionError = null)
                }
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    connectionError = error.message ?: "Failed to refresh from hub"
                )
            }
        }
    }

    fun connect() {
        viewModelScope.launch(Dispatchers.IO) {
            _uiState.value = _uiState.value.copy(
                isConnecting = true,
                connectionError = null
            )

            runCatching {
                val requestedConfig = HubConfig.fromInput(_uiState.value.hubOrigin)
                val resolved = connectWithFallback(requestedConfig)
                val config = resolved.first
                val bootstrap = resolved.second
                val profiles = resolved.third
                val sessionConfig = resolved.fourth
                configStore.save(config)

                _uiState.value = _uiState.value.copy(
                    hubOrigin = config.origin,
                    agents = bootstrap.agents,
                    events = bootstrap.events,
                    profiles = profiles,
                    workspaceRootHint = sessionConfig.workspaceRootHint,
                    hostUsername = sessionConfig.hostUsername,
                    socketState = SocketConnectionState.CONNECTING
                )
                AgentNotificationService.start(getApplication(), config.origin)
                repository!!.connect(
                    onConnectionStateChange = { socketState ->
                        _uiState.value = _uiState.value.copy(socketState = socketState)
                        if (socketState == SocketConnectionState.CONNECTED) {
                            refreshFromHub()
                        }
                        startPolling()
                    },
                    onAgentDelta = { agent ->
                        val updated = if (agent.status == "offline") {
                            _uiState.value.agents.filterNot { it.agentId == agent.agentId }
                        } else {
                            _uiState.value.agents.filterNot { it.agentId == agent.agentId } + agent
                        }
                        _uiState.value = _uiState.value.copy(
                            agents = updated.sortedByDescending { it.lastSeenAt },
                            events = if (agent.status == "offline") {
                                _uiState.value.events.filterNot { it.agentId == agent.agentId }
                            } else {
                                _uiState.value.events
                            }
                        )
                    },
                    onTimelineEvent = { event ->
                        _uiState.value = _uiState.value.copy(
                            agents = applyConversationEvent(_uiState.value.agents, event),
                            events = _uiState.value.events
                                .filterNot { it.id == event.id }
                                .plus(event)
                                .sortedBy { it.timestamp }
                        )
                    },
                    onTuiMenu = { menu ->
                        android.util.Log.i("MainViewModel", "=== TUI MENU RECEIVED ===")
                        android.util.Log.i("MainViewModel", "agentId=${menu.agentId}, title=${menu.title}, items=${menu.items.size}")
                        android.util.Log.i("MainViewModel", "Current activeTuiMenu before update: ${_uiState.value.activeTuiMenu}")
                        _uiState.value = _uiState.value.copy(activeTuiMenu = menu)
                        android.util.Log.i("MainViewModel", "activeTuiMenu after update: ${_uiState.value.activeTuiMenu?.title}")
                    }
                )
                refreshFromHub()
                startPolling()
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    connectionError = error.message ?: "Failed to connect to hub",
                    socketState = SocketConnectionState.DISCONNECTED,
                    hubOrigin = _uiState.value.hubOrigin
                )
                startPolling()
            }

            _uiState.value = _uiState.value.copy(isConnecting = false)
        }
    }

    fun selectAgent(agentId: String?) {
        _uiState.value = _uiState.value.copy(selectedAgentId = agentId)
    }

    fun sendQuickCommand(agentId: String, type: String) {
        val commandId = repository?.sendCommand(agentId, type) ?: return
        appendOptimisticUserEvent(agentId = agentId, commandId = commandId, type = type, text = null)
    }

    fun sendInstruction(agentId: String, text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) {
            return
        }
        val commandId = repository?.sendCommand(agentId, "send_text", trimmed) ?: return
        appendOptimisticUserEvent(agentId = agentId, commandId = commandId, type = "send_text", text = trimmed)
    }

    fun sendSpecialKey(agentId: String, key: String, modifiers: List<String> = emptyList()) {
        val normalizedKey = key.trim()
        if (normalizedKey.isEmpty()) {
            return
        }
        repository?.sendCommand(
            agentId = agentId,
            type = "send_key",
            args = buildJsonObject {
                put("key", normalizedKey)
                if (modifiers.isNotEmpty()) {
                    put("modifiers", kotlinx.serialization.json.JsonArray(modifiers.map { modifier ->
                        kotlinx.serialization.json.JsonPrimitive(modifier)
                    }))
                }
            }
        )
    }

    fun selectTuiMenuItem(itemId: String, inputValue: String? = null) {
        val menu = _uiState.value.activeTuiMenu ?: return
        repository?.sendTuiMenuSelect(
            agentId = menu.agentId,
            menuId = menu.menuId,
            itemId = itemId,
            inputValue = inputValue?.takeIf { it.isNotBlank() }
        )
        _uiState.value = _uiState.value.copy(activeTuiMenu = null)
    }

    fun dismissTuiMenu() {
        _uiState.value = _uiState.value.copy(activeTuiMenu = null)
    }

    fun createSession(profileId: String, sessionName: String, workdir: String) {
        if (profileId.isBlank() || sessionName.isBlank() || workdir.isBlank()) {
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            _uiState.value = _uiState.value.copy(isCreatingSession = true, connectionError = null)
            runCatching {
                repository?.createSession(
                    sessionName = sessionName,
                    profileId = profileId,
                    workdir = workdir
                )
                repeat(12) {
                    delay(500)
                    val bootstrap = repository?.fetchBootstrap() ?: return@repeat
                    val profiles = repository?.fetchProfiles()?.profiles ?: emptyList()
                    val sessionConfig = repository?.fetchSessionConfig()
                    mergeBootstrap(bootstrap)
                    _uiState.value = _uiState.value.copy(
                        profiles = profiles,
                        workspaceRootHint = sessionConfig?.workspaceRootHint ?: _uiState.value.workspaceRootHint,
                        hostUsername = sessionConfig?.hostUsername ?: _uiState.value.hostUsername
                    )
                    val matched = bootstrap.agents.firstOrNull { it.displayName == sessionName || it.agentId == sessionName }
                    if (matched != null) {
                        _uiState.value = _uiState.value.copy(selectedAgentId = matched.agentId)
                        return@runCatching
                    }
                }
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    connectionError = error.message ?: "Failed to create session"
                )
            }
            _uiState.value = _uiState.value.copy(isCreatingSession = false)
        }
    }

    fun deleteSession(agentId: String) {
        if (agentId.isBlank()) {
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                repository?.deleteSession(agentId)
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    connectionError = error.message ?: "Failed to delete session"
                )
            }

            _uiState.value = _uiState.value.copy(
                agents = _uiState.value.agents.filterNot { it.agentId == agentId },
                events = _uiState.value.events.filterNot { it.agentId == agentId },
                selectedAgentId = if (_uiState.value.selectedAgentId == agentId) null else _uiState.value.selectedAgentId
            )
        }
    }

    fun resolveArtifactUrl(relativeUrl: String): String {
        return repository?.resolveArtifactUrl(relativeUrl) ?: relativeUrl
    }

    override fun onCleared() {
        stopPolling()
        repository?.close()
        super.onCleared()
    }

    private suspend fun connectWithFallback(
        config: HubConfig
    ): Quadruple<HubConfig, BootstrapResponse, List<AgentProfile>, SessionConfigResponse> {
        var lastError: Throwable? = null

        for (candidate in config.connectionCandidates()) {
            try {
                repository?.close()
                val nextRepository = HubRepository(
                    baseHttpUrl = candidate.httpUrl,
                    baseWsUrl = candidate.wsUrl
                )
                repository = nextRepository
                nextRepository.pruneOfflineSessions()
                val bootstrap = nextRepository.fetchBootstrap()
                val profiles = nextRepository.fetchProfiles().profiles
                val sessionConfig = nextRepository.fetchSessionConfig()
                return Quadruple(candidate, bootstrap, profiles, sessionConfig)
            } catch (error: Throwable) {
                lastError = error
            }
        }

        throw lastError ?: IllegalStateException("Failed to connect to hub")
    }

    private fun startPolling() {
        if (pollingJob?.isActive == true) {
            return
        }

        pollingJob = viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                runCatching {
                    repository?.fetchBootstrap()
                }.onSuccess { bootstrap ->
                    if (bootstrap != null) {
                        mergeBootstrap(bootstrap)
                        _uiState.value = _uiState.value.copy(connectionError = null)
                    }
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        connectionError = error.message ?: "Failed to refresh from hub"
                    )
                }

                val delayMs = if (_uiState.value.socketState == SocketConnectionState.CONNECTED) {
                    connectedRefreshIntervalMs
                } else {
                    disconnectedRefreshIntervalMs
                }
                delay(delayMs)
            }
        }
    }

    private fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    private fun mergeBootstrap(bootstrap: BootstrapResponse) {
        var mergedAgents = bootstrap.agents
        val existingEvents = _uiState.value.events.associateBy { it.id }.toMutableMap()
        for (event in bootstrap.events) {
            existingEvents[event.id] = event
            mergedAgents = applyConversationEvent(mergedAgents, event)
        }

        _uiState.value = _uiState.value.copy(
            agents = mergedAgents.sortedByDescending { it.lastSeenAt },
            events = existingEvents.values.sortedBy { it.timestamp }
        )
    }

    private fun appendOptimisticUserEvent(agentId: String, commandId: String, type: String, text: String?) {
        val optimisticEvent = TimelineEvent(
            id = "user_$commandId",
            agentId = agentId,
            eventType = "user_command",
            timestamp = Instant.now().toString(),
            title = "Command: $type",
            body = text,
            metadata = buildJsonObject {
                put("source", "android-client")
            }
        )

        _uiState.value = _uiState.value.copy(
            agents = applyConversationEvent(_uiState.value.agents, optimisticEvent),
            events = _uiState.value.events
                .filterNot { it.id == optimisticEvent.id }
                .plus(optimisticEvent)
                .sortedBy { it.timestamp }
        )
    }

    private fun applyConversationEvent(
        agents: List<AgentSnapshot>,
        event: TimelineEvent
    ): List<AgentSnapshot> {
        val summary = summarizeConversationEvent(event) ?: return agents
        return agents.map { agent ->
            if (agent.agentId != event.agentId) {
                agent
            } else {
                agent.copy(
                    lastSeenAt = event.timestamp,
                    lastMessage = summary
                )
            }
        }.sortedByDescending { it.lastSeenAt }
    }

    private fun summarizeConversationEvent(event: TimelineEvent): String? {
        val body = event.body?.trim()
        if (!body.isNullOrEmpty()) {
            return body
        }

        val caption = event.artifact?.caption?.trim()
        if (!caption.isNullOrEmpty()) {
            return caption
        }

        return when (event.eventType) {
            "need_approval" -> "Waiting for approval."
            "image_available" -> "Image preview available."
            "artifact_generated" -> "Artifact available."
            else -> null
        }
    }
}

data class Quadruple<A, B, C, D>(
    val first: A,
    val second: B,
    val third: C,
    val fourth: D
)
