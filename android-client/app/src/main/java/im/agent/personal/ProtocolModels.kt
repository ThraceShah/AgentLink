package im.agent.link

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class BootstrapResponse(
    val agents: List<AgentSnapshot>,
    val events: List<TimelineEvent>
)

@Serializable
data class SlashCommandNode(
    val id: String,
    val label: String,
    val description: String? = null,
    val commandType: String? = null,
    val requiresInput: Boolean? = null,
    val inputPlaceholder: String? = null,
    val keyValue: String? = null,
    val children: List<SlashCommandNode> = emptyList()
)

@Serializable
data class AgentSnapshot(
    val agentId: String,
    val displayName: String,
    val kind: String,
    val status: String,
    val sessionHint: String? = null,
    val capabilities: List<String> = emptyList(),
    val quickCommands: List<String> = emptyList(),
    val slashCommands: List<SlashCommandNode> = emptyList(),
    val lastSeenAt: String,
    val lastMessage: String? = null
)

@Serializable
data class TimelineEvent(
    val id: String,
    val agentId: String,
    val eventType: String,
    val timestamp: String,
    val title: String? = null,
    val body: String? = null,
    val status: String? = null,
    val metadata: JsonObject? = null,
    val artifact: Artifact? = null
)

@Serializable
data class Artifact(
    val artifactId: String,
    val kind: String,
    val fileName: String,
    val mimeType: String,
    val url: String,
    val caption: String? = null
)

@Serializable
data class CommandPayload(
    val id: String,
    val type: String,
    val text: String? = null,
    val args: JsonObject? = null
)

@Serializable
data class HelloEnvelope(
    val type: String = "hello",
    val role: String = "client",
    val client: ClientInfo
)

@Serializable
data class ClientInfo(
    val clientId: String,
    val deviceName: String,
    val platform: String = "android"
)

@Serializable
data class CommandEnvelope(
    val type: String = "command",
    val agentId: String,
    val command: CommandPayload
)

@Serializable
data class AgentDeltaEnvelope(
    @SerialName("type") val envelopeType: String,
    val agent: AgentSnapshot
)

@Serializable
data class TimelineEnvelope(
    @SerialName("type") val envelopeType: String,
    val event: TimelineEvent
)

@Serializable
data class AgentProfilesResponse(
    val profiles: List<AgentProfile>
)

@Serializable
data class SessionConfigResponse(
    val workspaceRootHint: String,
    val hostUsername: String = ""
)

@Serializable
data class AgentProfile(
    val id: String,
    val label: String
)

@Serializable
data class CreateSessionRequest(
    val sessionName: String,
    val profileId: String,
    val workdir: String
)

@Serializable
data class CreateSessionResponse(
    val sessionName: String,
    val profile: AgentProfile
)

@Serializable
data class DeleteSessionRequest(
    val sessionName: String
)

@Serializable
data class DeleteSessionResponse(
    val sessionName: String,
    val removedAgentId: String
)

@Serializable
data class PruneOfflineResponse(
    val removedAgentIds: List<String>
)

@Serializable
data class TuiMenuItem(
    val id: String,
    val label: String,
    val description: String? = null,
    val isInput: Boolean? = null,
    val inputPlaceholder: String? = null
)

@Serializable
data class TuiMenu(
    val type: String = "tui_menu",
    val agentId: String,
    val menuId: String,
    val title: String,
    val body: String? = null,
    val items: List<TuiMenuItem>,
    val timestamp: String
)

@Serializable
data class TuiMenuSelectEnvelope(
    val type: String = "tui_menu_select",
    val agentId: String,
    val menuId: String,
    val itemId: String,
    val inputValue: String? = null
)
