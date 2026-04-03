package im.agent.personal

import android.util.Log
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

private const val logTag = "AgentImHub"

enum class SocketConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED
}

class HubRepository(
    private val baseHttpUrl: String,
    private val baseWsUrl: String
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient()
    private var socket: WebSocket? = null
    private var connectionState: SocketConnectionState = SocketConnectionState.DISCONNECTED
    private val pendingCommands = mutableListOf<CommandEnvelope>()

    suspend fun fetchBootstrap(): BootstrapResponse {
        val response = client.newCall(
            Request.Builder().url("$baseHttpUrl/api/bootstrap").build()
        ).execute()
        check(response.isSuccessful) {
            "Bootstrap request failed with HTTP ${response.code}"
        }
        val body = response.body?.string().orEmpty()
        return json.decodeFromString(body)
    }

    fun connect(
        onConnectionStateChange: (SocketConnectionState) -> Unit,
        onAgentDelta: (AgentSnapshot) -> Unit,
        onTimelineEvent: (TimelineEvent) -> Unit
    ) {
        close()
        connectionState = SocketConnectionState.CONNECTING
        onConnectionStateChange(connectionState)
        Log.i(logTag, "Opening WebSocket to $baseWsUrl")
        val request = Request.Builder().url(baseWsUrl).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val hello = HelloEnvelope(
                    client = ClientInfo(
                        clientId = UUID.randomUUID().toString(),
                        deviceName = "Android"
                    )
                )
                connectionState = SocketConnectionState.CONNECTED
                onConnectionStateChange(connectionState)
                Log.i(logTag, "WebSocket opened")
                webSocket.send(json.encodeToString(hello))
                flushPendingCommands()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val root = json.parseToJsonElement(text).jsonObject
                when (root["type"]?.jsonPrimitive?.content) {
                    "agent_delta" -> onAgentDelta(json.decodeFromString<AgentDeltaEnvelope>(text).agent)
                    "timeline_event" -> onTimelineEvent(json.decodeFromString<TimelineEnvelope>(text).event)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                connectionState = SocketConnectionState.DISCONNECTED
                onConnectionStateChange(connectionState)
                Log.i(logTag, "WebSocket closed: $code $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                connectionState = SocketConnectionState.DISCONNECTED
                onConnectionStateChange(connectionState)
                Log.e(
                    logTag,
                    "WebSocket failure: ${t.message ?: "unknown"}; response=${response?.code}",
                    t
                )
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
        if (connectionState == SocketConnectionState.CONNECTED && socket != null) {
            Log.i(logTag, "Sending command $type to $agentId")
            socket?.send(json.encodeToString(payload))
            return
        }

        pendingCommands += payload
        Log.w(logTag, "Queued command $type for $agentId because socket is not connected")
    }

    fun resolveArtifactUrl(path: String): String {
        return "${baseHttpUrl.trimEnd('/')}/" + path.trimStart('/')
    }

    fun close() {
        if (socket != null) {
            Log.i(logTag, "Closing WebSocket")
        }
        socket?.close(1000, "client closing")
        socket = null
        connectionState = SocketConnectionState.DISCONNECTED
    }

    private fun flushPendingCommands() {
        if (pendingCommands.isEmpty()) {
            return
        }

        val activeSocket = socket ?: return
        val queued = pendingCommands.toList()
        pendingCommands.clear()
        for (payload in queued) {
            Log.i(logTag, "Flushing queued command ${payload.command.type} to ${payload.agentId}")
            activeSocket.send(json.encodeToString(payload))
        }
    }
}
