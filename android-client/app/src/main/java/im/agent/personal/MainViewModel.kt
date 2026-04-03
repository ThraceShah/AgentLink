package im.agent.personal

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
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
    val selectedAgentId: String? = null,
    val isConnecting: Boolean = false,
    val isCreatingSession: Boolean = false,
    val connectionError: String? = null,
    val socketState: SocketConnectionState = SocketConnectionState.DISCONNECTED
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
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
                configStore.save(config)

                _uiState.value = _uiState.value.copy(
                    hubOrigin = config.origin,
                    agents = bootstrap.agents,
                    events = bootstrap.events,
                    profiles = profiles,
                    socketState = SocketConnectionState.CONNECTING
                )
                repository!!.connect(
                    onConnectionStateChange = { socketState ->
                        _uiState.value = _uiState.value.copy(socketState = socketState)
                        if (socketState == SocketConnectionState.CONNECTED) {
                            stopPolling()
                        } else {
                            startPolling()
                        }
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
                            events = _uiState.value.events + event
                        )
                    }
                )
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
        repository?.sendCommand(agentId, type)
    }

    fun sendInstruction(agentId: String, text: String) {
        repository?.sendCommand(agentId, "send_text", text)
    }

    fun createSession(profileId: String, sessionName: String) {
        if (profileId.isBlank() || sessionName.isBlank()) {
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            _uiState.value = _uiState.value.copy(isCreatingSession = true, connectionError = null)
            runCatching {
                repository?.createSession(sessionName = sessionName, profileId = profileId)
                repeat(12) {
                    delay(500)
                    val bootstrap = repository?.fetchBootstrap() ?: return@repeat
                    val profiles = repository?.fetchProfiles()?.profiles ?: emptyList()
                    mergeBootstrap(bootstrap)
                    _uiState.value = _uiState.value.copy(profiles = profiles)
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

    fun resolveArtifactUrl(relativeUrl: String): String {
        return repository?.resolveArtifactUrl(relativeUrl) ?: relativeUrl
    }

    override fun onCleared() {
        stopPolling()
        repository?.close()
        super.onCleared()
    }

    private suspend fun connectWithFallback(config: HubConfig): Triple<HubConfig, BootstrapResponse, List<AgentProfile>> {
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
                return Triple(candidate, bootstrap, profiles)
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
                if (_uiState.value.socketState == SocketConnectionState.CONNECTED) {
                    delay(5000)
                    continue
                }

                runCatching {
                    repository?.fetchBootstrap()
                }.onSuccess { bootstrap ->
                    if (bootstrap != null) {
                        mergeBootstrap(bootstrap)
                        _uiState.value = _uiState.value.copy(connectionError = null)
                    }
                }

                delay(5000)
            }
        }
    }

    private fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    private fun mergeBootstrap(bootstrap: BootstrapResponse) {
        val mergedAgents = bootstrap.agents.sortedByDescending { it.lastSeenAt }
        val existingEvents = _uiState.value.events.associateBy { it.id }.toMutableMap()
        for (event in bootstrap.events) {
            existingEvents.putIfAbsent(event.id, event)
        }

        _uiState.value = _uiState.value.copy(
            agents = mergedAgents,
            events = existingEvents.values.sortedBy { it.timestamp }
        )
    }
}
