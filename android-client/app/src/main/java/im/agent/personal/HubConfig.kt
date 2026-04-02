package im.agent.personal

import android.app.Application
import java.net.URI

private const val preferencesName = "hub_config"
private const val hubOriginKey = "hub_origin"
private const val defaultHubOrigin = "http://127.0.0.1:8787"

data class HubConfig(
    val origin: String
) {
    val httpUrl: String = origin.trimEnd('/')
    val wsUrl: String = buildWebSocketUrl(httpUrl)

    companion object {
        fun fromInput(raw: String): HubConfig {
            val normalized = normalizeHubOrigin(raw)
            return HubConfig(origin = normalized)
        }
    }
}

class HubConfigStore(application: Application) {
    private val preferences = application.getSharedPreferences(preferencesName, 0)

    fun load(): HubConfig {
        val stored = preferences.getString(hubOriginKey, defaultHubOrigin) ?: defaultHubOrigin
        return HubConfig.fromInput(stored)
    }

    fun save(config: HubConfig) {
        preferences.edit().putString(hubOriginKey, config.origin).apply()
    }
}

fun normalizeHubOrigin(raw: String): String {
    val trimmed = raw.trim()
    val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        trimmed
    } else {
        "http://$trimmed"
    }
    val uri = URI(withScheme)
    val host = uri.host ?: throw IllegalArgumentException("Invalid hub host")
    val scheme = uri.scheme ?: "http"
    val port = if (uri.port == -1) {
        if (scheme == "https") 443 else 8787
    } else {
        uri.port
    }
    return "$scheme://$host:$port"
}

private fun buildWebSocketUrl(httpUrl: String): String {
    return when {
        httpUrl.startsWith("https://") -> "wss://${httpUrl.removePrefix("https://")}/ws"
        httpUrl.startsWith("http://") -> "ws://${httpUrl.removePrefix("http://")}/ws"
        else -> "ws://${httpUrl}/ws"
    }
}
