package im.agent.personal

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class MainUiState(
    val hubOrigin: String = "",
    val agents: List<AgentSnapshot> = emptyList(),
    val events: List<TimelineEvent> = emptyList(),
    val selectedAgentId: String? = null,
    val isConnecting: Boolean = false,
    val connectionError: String? = null
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val configStore = HubConfigStore(application)
    private var repository: HubRepository? = null

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
                configStore.save(config)

                _uiState.value = _uiState.value.copy(
                    hubOrigin = config.origin,
                    agents = bootstrap.agents,
                    events = bootstrap.events
                )
                repository!!.connect(
                    onAgentDelta = { agent ->
                        val updated = _uiState.value.agents
                            .filterNot { it.agentId == agent.agentId } + agent
                        _uiState.value = _uiState.value.copy(
                            agents = updated.sortedByDescending { it.lastSeenAt }
                        )
                    },
                    onTimelineEvent = { event ->
                        _uiState.value = _uiState.value.copy(
                            events = _uiState.value.events + event
                        )
                    }
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    connectionError = error.message ?: "Failed to connect to hub"
                )
            }

            _uiState.value = _uiState.value.copy(isConnecting = false)
        }
    }

    fun selectAgent(agentId: String) {
        _uiState.value = _uiState.value.copy(selectedAgentId = agentId)
    }

    fun sendQuickCommand(agentId: String, type: String) {
        repository?.sendCommand(agentId, type)
    }

    fun sendInstruction(agentId: String, text: String) {
        repository?.sendCommand(agentId, "send_text", text)
    }

    fun resolveArtifactUrl(relativeUrl: String): String {
        return repository?.resolveArtifactUrl(relativeUrl) ?: relativeUrl
    }

    override fun onCleared() {
        repository?.close()
        super.onCleared()
    }

    private suspend fun connectWithFallback(config: HubConfig): Pair<HubConfig, BootstrapResponse> {
        var lastError: Throwable? = null

        for (candidate in config.connectionCandidates()) {
            try {
                repository?.close()
                val nextRepository = HubRepository(
                    baseHttpUrl = candidate.httpUrl,
                    baseWsUrl = candidate.wsUrl
                )
                val bootstrap = nextRepository.fetchBootstrap()
                repository = nextRepository
                return candidate to bootstrap
            } catch (error: Throwable) {
                lastError = error
            }
        }

        throw lastError ?: IllegalStateException("Failed to connect to hub")
    }
}
