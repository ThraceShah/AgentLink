package im.agent.personal

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import java.time.Instant
import java.util.UUID

private const val logTag = "AgentImHub"
private const val heartbeatIntervalMs = 20_000L
private const val heartbeatTimeoutMs = 45_000L
private const val reconnectDelayCapMs = 15_000L

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
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var socket: WebSocket? = null
    private var connectionState: SocketConnectionState = SocketConnectionState.DISCONNECTED
    private val pendingCommands = mutableListOf<CommandEnvelope>()
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private var shouldStayConnected = false
    private var reconnectAttempts = 0
    private var lastInboundAt = 0L
    private var onConnectionStateChange: ((SocketConnectionState) -> Unit)? = null
    private var onAgentDelta: ((AgentSnapshot) -> Unit)? = null
    private var onTimelineEvent: ((TimelineEvent) -> Unit)? = null

    suspend fun fetchBootstrap(): BootstrapResponse {
        return get("/api/bootstrap")
    }

    suspend fun fetchProfiles(): AgentProfilesResponse {
        return get("/api/agent-profiles")
    }

    suspend fun fetchSessionConfig(): SessionConfigResponse {
        return get("/api/session-config")
    }

    suspend fun pruneOfflineSessions(): PruneOfflineResponse {
        return postEmpty("/api/admin/prune-offline")
    }

    suspend fun createSession(sessionName: String, profileId: String, workdir: String): CreateSessionResponse {
        return post(
            path = "/api/sessions",
            payload = CreateSessionRequest(
                sessionName = sessionName,
                profileId = profileId,
                workdir = workdir
            )
        )
    }

    suspend fun deleteSession(sessionName: String): DeleteSessionResponse {
        return post(
            path = "/api/sessions/delete",
            payload = DeleteSessionRequest(sessionName = sessionName)
        )
    }

    fun connect(
        onConnectionStateChange: (SocketConnectionState) -> Unit,
        onAgentDelta: (AgentSnapshot) -> Unit,
        onTimelineEvent: (TimelineEvent) -> Unit
    ) {
        this.onConnectionStateChange = onConnectionStateChange
        this.onAgentDelta = onAgentDelta
        this.onTimelineEvent = onTimelineEvent
        shouldStayConnected = true
        reconnectAttempts = 0
        openSocket()
    }

    fun resolveArtifactUrl(path: String): String {
        return "${baseHttpUrl.trimEnd('/')}/" + path.trimStart('/')
    }

    fun close() {
        shouldStayConnected = false
        reconnectJob?.cancel()
        reconnectJob = null
        stopHeartbeat()
        closeSocket()
        connectionState = SocketConnectionState.DISCONNECTED
        onConnectionStateChange?.invoke(connectionState)
    }

    private fun openSocket() {
        reconnectJob?.cancel()
        reconnectJob = null
        stopHeartbeat()
        closeSocket()
        connectionState = SocketConnectionState.CONNECTING
        onConnectionStateChange?.invoke(connectionState)
        Log.i(logTag, "Opening WebSocket to $baseWsUrl")
        val request = Request.Builder().url(baseWsUrl).build()
        val activeSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (socket !== webSocket) {
                    return
                }
                val hello = HelloEnvelope(
                    client = ClientInfo(
                        clientId = UUID.randomUUID().toString(),
                        deviceName = "Android"
                    )
                )
                reconnectAttempts = 0
                lastInboundAt = System.currentTimeMillis()
                connectionState = SocketConnectionState.CONNECTED
                onConnectionStateChange?.invoke(connectionState)
                Log.i(logTag, "WebSocket opened")
                webSocket.send(json.encodeToString(hello))
                startHeartbeat(webSocket)
                flushPendingCommands()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (socket !== webSocket) {
                    return
                }
                lastInboundAt = System.currentTimeMillis()
                val root = json.parseToJsonElement(text).jsonObject
                when (root["type"]?.jsonPrimitive?.content) {
                    "agent_delta" -> onAgentDelta?.invoke(json.decodeFromString<AgentDeltaEnvelope>(text).agent)
                    "timeline_event" -> onTimelineEvent?.invoke(json.decodeFromString<TimelineEnvelope>(text).event)
                    "heartbeat_ack" -> Log.v(logTag, "Heartbeat acknowledged")
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket !== webSocket) {
                    return
                }
                stopHeartbeat()
                connectionState = SocketConnectionState.DISCONNECTED
                onConnectionStateChange?.invoke(connectionState)
                Log.i(logTag, "WebSocket closed: $code $reason")
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (socket !== webSocket) {
                    return
                }
                stopHeartbeat()
                connectionState = SocketConnectionState.DISCONNECTED
                onConnectionStateChange?.invoke(connectionState)
                Log.e(
                    logTag,
                    "WebSocket failure: ${t.message ?: "unknown"}; response=${response?.code}",
                    t
                )
                scheduleReconnect()
            }
        })
        socket = activeSocket
    }

    fun sendCommand(agentId: String, type: String, text: String? = null, commandId: String = UUID.randomUUID().toString()): String {
        val payload = CommandEnvelope(
            agentId = agentId,
            command = CommandPayload(
                id = commandId,
                type = type,
                text = text
            )
        )
        postCommand(payload)
        return commandId
    }

    private fun startHeartbeat(webSocket: WebSocket) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive && shouldStayConnected) {
                delay(heartbeatIntervalMs)
                if (connectionState != SocketConnectionState.CONNECTED) {
                    continue
                }

                val now = System.currentTimeMillis()
                if (lastInboundAt != 0L && now - lastInboundAt > heartbeatTimeoutMs) {
                    Log.w(logTag, "Heartbeat timed out; forcing reconnect")
                    webSocket.close(4000, "heartbeat timeout")
                    break
                }

                val heartbeat = """
                    {"type":"heartbeat","timestamp":"${Instant.now()}"}
                """.trimIndent()
                webSocket.send(heartbeat)
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun scheduleReconnect() {
        if (!shouldStayConnected || reconnectJob?.isActive == true) {
            return
        }

        reconnectAttempts += 1
        val exponent = (reconnectAttempts - 1).coerceAtMost(4)
        val delayMs = minOf(1_000L * (1L shl exponent), reconnectDelayCapMs)
        reconnectJob = scope.launch {
            Log.i(logTag, "Scheduling reconnect in ${delayMs}ms")
            delay(delayMs)
            if (!shouldStayConnected) {
                return@launch
            }
            openSocket()
        }
    }

    private fun closeSocket() {
        val currentSocket = socket
        socket = null
        if (currentSocket != null) {
            Log.i(logTag, "Closing WebSocket")
        }
        currentSocket?.close(1000, "client closing")
    }

    private fun flushPendingCommands() {
        if (pendingCommands.isEmpty()) {
            return
        }

        val queued = pendingCommands.toList()
        pendingCommands.clear()
        for (payload in queued) {
            Log.i(logTag, "Flushing queued command ${payload.command.type} to ${payload.agentId}")
            postCommand(payload)
        }
    }

    private fun postCommand(payload: CommandEnvelope) {
        val body = json.encodeToString(payload).toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("$baseHttpUrl/api/commands")
            .post(body)
            .build()

        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                Log.e(logTag, "HTTP command failed: ${payload.command.type}", e)
                pendingCommands += payload
            }

            override fun onResponse(call: okhttp3.Call, response: Response) {
                response.use {
                    if (it.isSuccessful) {
                        Log.i(logTag, "HTTP command accepted: ${payload.command.type} -> ${payload.agentId}")
                        return
                    }

                    Log.w(
                        logTag,
                        "HTTP command rejected: ${payload.command.type} -> ${payload.agentId}; code=${it.code}"
                    )
                    pendingCommands += payload
                }
            }
        })
    }

    private suspend inline fun <reified T> get(path: String): T {
        val response = client.newCall(
            Request.Builder().url("$baseHttpUrl$path").build()
        ).execute()
        check(response.isSuccessful) {
            "Request to $path failed with HTTP ${response.code}"
        }
        val body = response.body?.string().orEmpty()
        return json.decodeFromString(body)
    }

    private suspend inline fun <reified T, reified P> post(path: String, payload: P): T {
        val body = json.encodeToString(payload).toRequestBody("application/json".toMediaType())
        val response = client.newCall(
            Request.Builder()
                .url("$baseHttpUrl$path")
                .post(body)
                .build()
        ).execute()
        check(response.isSuccessful) {
            "Request to $path failed with HTTP ${response.code}"
        }
        return json.decodeFromString(response.body?.string().orEmpty())
    }

    private suspend inline fun <reified T> postEmpty(path: String): T {
        val response = client.newCall(
            Request.Builder()
                .url("$baseHttpUrl$path")
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()
        ).execute()
        check(response.isSuccessful) {
            "Request to $path failed with HTTP ${response.code}"
        }
        return json.decodeFromString(response.body?.string().orEmpty())
    }
}
