package im.agent.link

import android.app.Application
import android.os.Build
import java.net.URI

private const val preferencesName = "hub_config"
private const val hubOriginKey = "hub_origin"
private const val defaultHubOrigin = "http://10.0.2.2:8787"

data class HubConfig(
    val origin: String
) {
    val httpUrl: String = origin.trimEnd('/')
    val wsUrl: String = buildWebSocketUrl(httpUrl)

    fun connectionCandidates(): List<HubConfig> {
        if (!isEmulatorBuild()) {
            return listOf(this)
        }

        val uri = URI(httpUrl)
        val host = uri.host ?: return listOf(this)
        if (host != "10.0.2.2") {
            return listOf(this)
        }

        val port = if (uri.port == -1) 8787 else uri.port
        val scheme = uri.scheme ?: "http"
        val fallback = HubConfig.fromInput("$scheme://127.0.0.1:$port")
        return listOf(this, fallback).distinctBy { it.origin }
    }

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

private fun isEmulatorBuild(): Boolean {
    val fingerprint = Build.FINGERPRINT
    val model = Build.MODEL
    val product = Build.PRODUCT
    return fingerprint.startsWith("generic")
        || fingerprint.contains("emulator", ignoreCase = true)
        || model.contains("Emulator", ignoreCase = true)
        || model.contains("Android SDK", ignoreCase = true)
        || product.contains("sdk", ignoreCase = true)
}
