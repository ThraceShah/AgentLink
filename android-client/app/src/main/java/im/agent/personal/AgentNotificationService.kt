package im.agent.personal

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val serviceLogTag = "AgentImNotifyService"
private const val serviceNotificationId = 1001
private const val hubOriginExtraKey = "hub_origin"

class AgentNotificationService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val visibilityTracker = AppVisibilityTracker()
    private lateinit var notificationManager: AgentNotificationManager
    private var repository: HubRepository? = null
    private var pollingJob: Job? = null
    private var hasInitialBootstrap = false
    private val knownEventIds = linkedSetOf<String>()

    override fun onCreate() {
        super.onCreate()
        notificationManager = AgentNotificationManager(application)
        startForeground(serviceNotificationId, notificationManager.buildServiceNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val origin = intent?.getStringExtra(hubOriginExtraKey)
            ?.takeIf { it.isNotBlank() }
            ?: HubConfigStore(application).load().origin

        repository?.close()
        repository = HubRepository(
            baseHttpUrl = HubConfig.fromInput(origin).httpUrl,
            baseWsUrl = HubConfig.fromInput(origin).wsUrl
        )

        if (pollingJob?.isActive != true) {
            pollingJob = serviceScope.launch {
                runPollingLoop()
            }
        }

        Log.i(serviceLogTag, "Notification service started for $origin")
        return START_STICKY
    }

    override fun onDestroy() {
        pollingJob?.cancel()
        repository?.close()
        serviceScope.coroutineContext[Job]?.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun runPollingLoop() {
        while (serviceScope.isActive) {
            runCatching {
                repository?.fetchBootstrap()
            }.onSuccess { bootstrap ->
                if (bootstrap != null) {
                    processBootstrap(bootstrap)
                }
            }.onFailure { error ->
                Log.w(serviceLogTag, "Background poll failed: ${error.message}")
            }

            delay(2000)
        }
    }

    private fun processBootstrap(bootstrap: BootstrapResponse) {
        if (!hasInitialBootstrap) {
            bootstrap.events.forEach { knownEventIds += it.id }
            hasInitialBootstrap = true
            return
        }

        for (event in bootstrap.events) {
            if (knownEventIds.contains(event.id)) {
                continue
            }
            knownEventIds += event.id
            if (!shouldNotifyForEvent(event) || visibilityTracker.isForeground()) {
                continue
            }

            val summary = summarizeNotificationEvent(event) ?: continue
            val agent = bootstrap.agents.firstOrNull { it.agentId == event.agentId } ?: AgentSnapshot(
                agentId = event.agentId,
                displayName = event.agentId,
                kind = "agent",
                status = event.status ?: "online",
                lastSeenAt = event.timestamp
            )
            Log.i(serviceLogTag, "Background notification for ${event.eventType} from ${agent.agentId}")
            notificationManager.notifyAgentEvent(agent = agent, event = event, summary = summary)
        }
    }

    private fun shouldNotifyForEvent(event: TimelineEvent): Boolean {
        return when (event.eventType) {
            "text_output",
            "need_approval",
            "need_user_input",
            "task_failed",
            "artifact_generated",
            "image_available" -> true
            else -> false
        }
    }

    private fun summarizeNotificationEvent(event: TimelineEvent): String? {
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
            "need_user_input" -> "Waiting for input."
            "image_available" -> "Image preview available."
            "artifact_generated" -> "Artifact available."
            else -> null
        }
    }

    companion object {
        fun start(context: Context, hubOrigin: String) {
            val intent = Intent(context, AgentNotificationService::class.java).apply {
                putExtra(hubOriginExtraKey, hubOrigin)
            }
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
