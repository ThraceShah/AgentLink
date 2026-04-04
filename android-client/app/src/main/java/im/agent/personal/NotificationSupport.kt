package im.agent.personal

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

private const val notificationChannelId = "agent_updates"
private const val notificationChannelName = "Agent updates"
private const val notificationChannelDescription = "Messages, approvals, and results from your agents"
private const val serviceChannelId = "agent_background_service"
private const val serviceChannelName = "Agent background monitor"
private const val serviceChannelDescription = "Keeps private agent notifications active in the background"
const val openAgentIdKey = "open_agent_id"
private const val notificationLogTag = "AgentImNotify"

class AppVisibilityTracker : DefaultLifecycleObserver {
    @Volatile
    private var foreground = false

    init {
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
    }

    override fun onStart(owner: LifecycleOwner) {
        foreground = true
    }

    override fun onStop(owner: LifecycleOwner) {
        foreground = false
    }

    fun isForeground(): Boolean = foreground
}

class AgentNotificationManager(
    private val application: Application
) {
    private val notificationManager = NotificationManagerCompat.from(application)

    init {
        ensureChannel()
    }

    fun canPostNotifications(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true
        }

        return ContextCompat.checkSelfPermission(
            application,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun notifyAgentEvent(
        agent: AgentSnapshot,
        event: TimelineEvent,
        summary: String
    ) {
        if (!canPostNotifications()) {
            Log.w(notificationLogTag, "Notifications disabled; skip ${event.id}")
            return
        }

        val launchIntent = Intent(application, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(openAgentIdKey, agent.agentId)
        }

        val pendingIntent = PendingIntent.getActivity(
            application,
            agent.agentId.hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(application, notificationChannelId)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(agent.displayName)
            .setContentText(summary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(summary))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setGroup(agent.agentId)
            .setSubText(notificationAgentLabel(agent))

        notificationModelLabel(event)?.let {
            builder.setTicker("${agent.displayName}: $it")
        }

        Log.i(notificationLogTag, "notify(${agent.agentId.hashCode()}) title=${agent.displayName}")
        notificationManager.notify(agent.agentId.hashCode(), builder.build())
    }

    fun buildServiceNotification(): Notification {
        return NotificationCompat.Builder(application, serviceChannelId)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Agent IM background monitor")
            .setContentText("Watching for agent replies and approval requests")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val manager = application.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(notificationChannelId) == null) {
            val channel = NotificationChannel(
                notificationChannelId,
                notificationChannelName,
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = notificationChannelDescription
            }
            manager.createNotificationChannel(channel)
        }
        if (manager.getNotificationChannel(serviceChannelId) == null) {
            val channel = NotificationChannel(
                serviceChannelId,
                serviceChannelName,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = serviceChannelDescription
            }
            manager.createNotificationChannel(channel)
        }
    }
}

private fun notificationAgentLabel(agent: AgentSnapshot): String {
    return when (agent.kind.lowercase()) {
        "opencode", "open-code", "open_code" -> "opencode"
        "codex", "codex-bridge" -> "codex"
        "copilot", "github-copilot", "github_copilot" -> "copilot"
        "qwen", "qwen-cli", "qwen-coder" -> "qwen"
        "tmux", "tmux-agent" -> "tmux"
        else -> agent.kind.lowercase()
    }
}

private fun notificationModelLabel(event: TimelineEvent): String? {
    return event.metadata?.get("model")?.toString()?.trim('"')?.takeIf { it.isNotBlank() }
}
