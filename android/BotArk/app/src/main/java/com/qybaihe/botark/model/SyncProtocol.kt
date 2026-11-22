package com.qybaihe.botark.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import java.net.URI
import java.net.URLDecoder

@Serializable
enum class PlatformId(
    val wireId: String,
    val displayName: String,
    val shortLabel: String
) {
    @SerialName("meta-muse")
    META_MUSE("meta-muse", "Meta Muse", "Muse"),

    @SerialName("grok")
    GROK("grok", "Grok Bot", "Grok"),

    @SerialName("dot")
    DOT("dot", "ChatGPT Dot", "Dot"),

    @SerialName("hark")
    HARK("hark", "Hark", "Hark"),

    @SerialName("hermes")
    HERMES("hermes", "Hermes", "Hermes"),

    @SerialName("antigravity")
    ANTIGRAVITY("antigravity", "Antigravity", "Antigravity");

    val supportsQuickNewSession: Boolean
        get() = this == META_MUSE || this == GROK || this == HERMES || this == ANTIGRAVITY

    val defaultHomeUrl: String
        get() = when (this) {
            ANTIGRAVITY -> "https://antigravity.google.com"
            META_MUSE -> "https://muse.ai"
            GROK -> "https://grok.com"
            DOT -> "https://chatgpt.com/dots"
            HARK -> "https://app.hark.com"
            HERMES -> ""
        }

    val standaloneSubtitle: String
        get() = when (this) {
            ANTIGRAVITY -> "Google 云端 Agent"
            META_MUSE -> "Meta 个人智能体"
            GROK -> "xAI Grok"
            DOT -> "OpenAI Dot"
            HARK -> "Hark 个人助手"
            HERMES -> "开源 SSE 网关"
        }

    val standaloneTag: String
        get() = if (this == HERMES) "原生直连" else "独立登录"

    companion object {
        val pickerOrder: List<PlatformId> = listOf(
            ANTIGRAVITY, META_MUSE, GROK, DOT, HARK, HERMES
        )
    }
}

@Serializable
enum class ConnectionStatus {
    @SerialName("online") ONLINE,
    @SerialName("busy") BUSY,
    @SerialName("attention") ATTENTION,
    @SerialName("offline") OFFLINE,
    @SerialName("error") ERROR
}

@Serializable
data class SyncedGroup(
    val id: String,
    val name: String,
    val collapsed: Boolean = false
)

@Serializable
data class SyncedAccount(
    val id: String,
    val platformId: PlatformId,
    val displayName: String = "",
    val handle: String = "",
    val status: ConnectionStatus = ConnectionStatus.OFFLINE,
    val statusDetail: String? = null
)

@Serializable
data class SyncedBot(
    val id: String,
    val platformId: PlatformId,
    val name: String,
    val avatar: String? = null,
    val avatarShape: String? = null,
    val avatarColor: String? = null,
    val emoji: String? = null,
    val groupId: String = "default",
    val pinned: Boolean? = null,
    val activeAccountId: String,
    val activeSessionId: String? = null,
    val standaloneUrl: String? = null,
    val lastActivityAt: Double = 0.0
) {
    val isStandaloneWeb: Boolean
        get() = !standaloneUrl.isNullOrBlank()
}

@Serializable
data class SyncedToolCall(
    val id: String,
    val name: String,
    val toolType: String? = null,
    val status: String,
    val summary: String? = null
)

@Serializable
data class SyncedMediaPart(
    val kind: String,
    val path: String,
    val name: String? = null,
    val mimeType: String? = null
)

@Serializable
data class SyncedMessage(
    val id: String,
    val botId: String,
    val accountId: String = "",
    val role: String,
    val text: String = "",
    val createdAt: Double = 0.0,
    val delivery: String? = null,
    val error: String? = null,
    val tools: List<SyncedToolCall>? = null,
    val media: List<SyncedMediaPart>? = null,
    @Transient val isLocalRelayMessage: Boolean = false
) {
    val isUser: Boolean get() = role == "user"
}

@Serializable
data class SyncedApproval(
    val id: String,
    val status: String = "pending",
    val title: String,
    val detail: String? = null,
    val approvalType: String? = null,
    val host: String? = null,
    val decisionOptions: List<String>? = null,
    val reason: String? = null
)

@Serializable
data class WorkspaceSnapshot(
    val version: Int = 1,
    val updatedAtMs: Double = 0.0,
    val hostName: String = "",
    val selectedBotId: String? = null,
    val groups: List<SyncedGroup> = emptyList(),
    val bots: List<SyncedBot> = emptyList(),
    val accounts: Map<String, SyncedAccount> = emptyMap(),
    val messages: Map<String, List<SyncedMessage>> = emptyMap(),
    val approvals: Map<String, List<SyncedApproval>> = emptyMap()
) {
    companion object {
        val EMPTY = WorkspaceSnapshot()
    }

    internal fun carryingLocalRelayMessages(current: WorkspaceSnapshot): WorkspaceSnapshot {
        val previousBots = current.bots.associateBy { it.id }
        val merged = messages.toMutableMap()
        for (bot in bots) {
            val previous = previousBots[bot.id] ?: continue
            if (previous.activeAccountId != bot.activeAccountId || previous.activeSessionId != bot.activeSessionId) continue
            val received = messages[bot.id].orEmpty()
            val receivedIds = received.mapTo(hashSetOf()) { it.id }
            val pending = current.messages[bot.id].orEmpty().filter { it.isLocalRelayMessage && it.id !in receivedIds }
            if (pending.isNotEmpty()) merged[bot.id] = received + pending
        }
        return copy(messages = merged)
    }

    internal fun withoutLocalRelayMessages() =
        copy(messages = messages.mapValues { (_, list) -> list.filterNot { it.isLocalRelayMessage } })
}

@Serializable
data class DirectHermesCredential(
    val accountId: String,
    val botId: String? = null,
    val botName: String? = null,
    val baseUrl: String,
    val apiKey: String? = null,
    val model: String? = null,
    val displayName: String? = null
)

@Serializable
data class PairedDesktopInfo(
    val deviceId: String,
    val deviceToken: String,
    val hostName: String,
    val activeHost: String,
    val candidateHosts: List<String>,
    val port: Int,
    val fingerprint: String,
    val pairedAtMs: Double
)

data class PairingPayload(
    val version: Int,
    val hosts: List<String>,
    val port: Int,
    val token: String,
    val key: String,
    val name: String,
    val fp: String
) {
    companion object {
        fun parse(raw: String): PairingPayload? {
            val trimmed = raw.trim()
            val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
            if (!uri.scheme.equals("botark", ignoreCase = true)) return null
            if (!uri.host.equals("pair", ignoreCase = true)) return null
            val rawQuery = uri.rawQuery ?: return null
            val params = mutableMapOf<String, String>()
            for (pair in rawQuery.split("&")) {
                val idx = pair.indexOf('=')
                if (idx <= 0) continue
                val k = URLDecoder.decode(pair.substring(0, idx), "UTF-8")
                val v = URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
                params[k] = v
            }
            val hosts = (params["hosts"] ?: "")
                .split(",")
                .map { it.trim() }
                .filter { it.isNotEmpty() }
            val port = params["port"]?.toIntOrNull() ?: return null
            if (hosts.isEmpty() || port !in 1..65535) return null
            val token = params["token"]?.takeIf { it.isNotEmpty() } ?: return null
            val key = params["key"]?.takeIf { it.isNotEmpty() } ?: return null
            val version = params["v"]?.toIntOrNull() ?: 1
            val name = params["name"]?.takeIf { it.isNotEmpty() } ?: "BotArk Desktop"
            val fp = params["fp"] ?: ""
            return PairingPayload(version, hosts, port, token, key, name, fp)
        }
    }
}

@Serializable
data class PairApiResponse(
    val ok: Boolean = false,
    val message: String? = null,
    val deviceId: String? = null,
    val deviceToken: String? = null,
    val hostName: String? = null,
    val fp: String? = null,
    val snapshot: WorkspaceSnapshot? = null,
    val directCredentialsEnc: String? = null
)

@Serializable
data class OfflineSyncOuterBundle(
    val format: String = "",
    val cipher: String = "",
    val hostName: String? = null,
    val fingerprint: String? = null,
    val exportedAtMs: Double? = null,
    val payload: String = ""
)

@Serializable
data class OfflineSyncInnerPayload(
    val version: Int = 1,
    val exportedAtMs: Double = 0.0,
    val hostName: String = "",
    val snapshot: WorkspaceSnapshot = WorkspaceSnapshot.EMPTY,
    val directCredentials: List<DirectHermesCredential>? = null
)

@Serializable
data class MobileWsEnvelope(
    val type: String = "",
    val snapshot: WorkspaceSnapshot? = null,
    val botId: String? = null,
    val accountId: String? = null,
    val messageId: String? = null,
    val text: String? = null,
    val tools: List<SyncedToolCall>? = null,
    val media: List<SyncedMediaPart>? = null,
    val message: SyncedMessage? = null,
    val isTyping: Boolean? = null,
    val status: ConnectionStatus? = null,
    val detail: String? = null,
    val pending: List<SyncedApproval>? = null
)

data class PendingApprovalItem(
    val accountId: String,
    val botName: String,
    val platformId: PlatformId,
    val approval: SyncedApproval
) {
    val id: String get() = "$accountId::${approval.id}"
}

sealed interface BridgeConnectionState {
    data object Unpaired : BridgeConnectionState
    data object Connecting : BridgeConnectionState
    data class Connected(val hostName: String, val activeHost: String) : BridgeConnectionState
    data class Offline(val hostName: String) : BridgeConnectionState

    val isBridgeConnected: Boolean
        get() = this is Connected
}
