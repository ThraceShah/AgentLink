package im.agent.personal

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import java.util.UUID

class HubRepository(
    private val baseHttpUrl: String,
    private val baseWsUrl: String
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient()
    private var socket: WebSocket? = null

    suspend fun fetchBootstrap(): BootstrapResponse {
        val response = client.newCall(
            Request.Builder().url("$baseHttpUrl/api/bootstrap").build()
        ).execute()
        val body = response.body?.string().orEmpty()
        return json.decodeFromString(body)
    }

    fun connect(
        onAgentDelta: (AgentSnapshot) -> Unit,
        onTimelineEvent: (TimelineEvent) -> Unit
    ) {
        val request = Request.Builder().url(baseWsUrl).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val hello = HelloEnvelope(
                    client = ClientInfo(
                        clientId = UUID.randomUUID().toString(),
                        deviceName = "Android"
                    )
                )
                webSocket.send(json.encodeToString(hello))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val root = json.parseToJsonElement(text).jsonObject
                when (root["type"]?.jsonPrimitive?.content) {
                    "agent_delta" -> onAgentDelta(json.decodeFromString<AgentDeltaEnvelope>(text).agent)
                    "timeline_event" -> onTimelineEvent(json.decodeFromString<TimelineEnvelope>(text).event)
                }
            }
        })
    }

    fun sendCommand(agentId: String, type: String, text: String? = null) {
        val payload = CommandEnvelope(
            agentId = agentId,
            command = CommandPayload(
                id = UUID.randomUUID().toString(),
                type = type,
                text = text
            )
        )
        socket?.send(json.encodeToString(payload))
    }

    fun resolveArtifactUrl(path: String): String {
        return "${baseHttpUrl.trimEnd('/')}/" + path.trimStart('/')
    }

    fun close() {
        socket?.close(1000, "client closing")
        socket = null
    }
}
