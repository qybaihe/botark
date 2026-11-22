package com.qybaihe.botark

import com.qybaihe.botark.model.PairingPayload
import com.qybaihe.botark.model.PlatformId
import com.qybaihe.botark.model.SyncedBot
import com.qybaihe.botark.model.SyncedMessage
import com.qybaihe.botark.model.WorkspaceSnapshot
import com.qybaihe.botark.service.DirectHermesClient
import com.qybaihe.botark.service.HermesSseParser
import com.qybaihe.botark.service.SyncCrypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class SyncProtocolTest {
    @Test
    fun desktopSnapshotReconcilesOptimisticSendById() {
        val bot = SyncedBot("bot", PlatformId.HERMES, "Fixture", activeAccountId = "account", activeSessionId = "session")
        val pending = SyncedMessage("client-id", "bot", role = "user", text = "Draft", delivery = "sending", isLocalRelayMessage = true)
        val desktop = WorkspaceSnapshot(bots = listOf(bot))
        val current = desktop.copy(messages = mapOf("bot" to listOf(pending)))

        val merged = desktop.carryingLocalRelayMessages(current)
        assertEquals(listOf(pending), merged.messages["bot"])
        assertEquals(emptyList<SyncedMessage>(), merged.withoutLocalRelayMessages().messages["bot"])

        val confirmed = pending.copy(isLocalRelayMessage = false, delivery = "failed")
        val desktopWithReceipt = desktop.copy(messages = mapOf("bot" to listOf(confirmed)))
        assertEquals(listOf(confirmed), desktopWithReceipt.carryingLocalRelayMessages(current).messages["bot"])

        val fresh = desktop.copy(bots = listOf(bot.copy(activeSessionId = "new-session")))
        assertNull(fresh.carryingLocalRelayMessages(current).messages["bot"])
    }

    @Test
    fun parseValidPairingUriWithLanAndTailscaleHosts() {
        val uri = "botark://pair?v=1&hosts=192.168.1.24,100.88.12.5&port=19472&token=abc123token&key=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI&name=MacBook%20Pro&fp=9A12BC34"
        val payload = PairingPayload.parse(uri)
        assertNotNull(payload)
        assertEquals(1, payload!!.version)
        assertEquals(listOf("192.168.1.24", "100.88.12.5"), payload.hosts)
        assertEquals(19472, payload.port)
        assertEquals("abc123token", payload.token)
        assertEquals("MacBook Pro", payload.name)
        assertEquals("9A12BC34", payload.fp)
    }

    @Test
    fun rejectInvalidPairingUris() {
        assertNull(PairingPayload.parse("https://example.com/pair"))
        assertNull(PairingPayload.parse("botark://other?hosts=127.0.0.1&port=19472&token=x&key=y"))
        assertNull(PairingPayload.parse("botark://pair?hosts=&port=19472&token=x&key=y"))
        assertNull(PairingPayload.parse("botark://pair?hosts=127.0.0.1&port=99999&token=x&key=y"))
    }

    /**
     * Exact 3-way cross-platform vector: Node.js (`mobileSyncCrypto.ts`) <-> Swift CryptoKit <-> Kotlin JCA AES-256-GCM.
     * Key = 32 x 0x42 (base64url), IV = 12 x 0x11, Plaintext = "BotArk-Zero-Server-2026".
     */
    @Test
    fun crossPlatformNodeAesGcmDecryptionVector() {
        val keyB64Url = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"
        val nodeCombined = "ERERERERERERERER8QhfUh+nrX1Z7heaMOWG40BHL9Jxa+Y1CErghXDNameMDktFOYBf"

        val plain = SyncCrypto.decryptAesGcmCombined(nodeCombined, keyB64Url).toString(Charsets.UTF_8)
        assertEquals("BotArk-Zero-Server-2026", plain)

        val iv = ByteArray(12) { 0x11.toByte() }
        val reEncrypted = SyncCrypto.encryptAesGcmCombined(
            "BotArk-Zero-Server-2026".toByteArray(Charsets.UTF_8),
            keyB64Url,
            iv
        )
        assertEquals(nodeCombined, reEncrypted)
    }

    @Test
    fun aesGcmRejectsWrongKey() {
        val wrongKey = SyncCrypto.encodeBase64Url(ByteArray(32) { 0x99.toByte() })
        val nodeCombined = "ERERERERERERERER8QhfUh+nrX1Z7heaMOWG40BHL9Jxa+Y1CErghXDNameMDktFOYBf"
        assertThrows(Exception::class.java) {
            SyncCrypto.decryptAesGcmCombined(nodeCombined, wrongKey)
        }
    }

    @Test
    fun hermesSseParserHandlesCrlfAndEvents() {
        val parser = HermesSseParser()
        assertNull(parser.feedLine(": keepalive\r"))
        assertNull(parser.feedLine("event: assistant.delta\r"))
        assertNull(parser.feedLine("data: {\"delta\":\"Hello\"}\r"))
        val first = parser.feedLine("\r")
        assertEquals("assistant.delta", first?.event)
        assertEquals("{\"delta\":\"Hello\"}", first?.data)

        assertNull(parser.feedLine("event: approval.request"))
        assertNull(parser.feedLine("data: {\"request_id\":\"req_1\"}"))
        val second = parser.feedLine("")
        assertEquals("approval.request", second?.event)
        assertEquals("{\"request_id\":\"req_1\"}", second?.data)
    }

    @Test
    fun normalizeDirectHermesUrls() {
        assertEquals("http://127.0.0.1:8642", DirectHermesClient.normalizeBaseUrl("127.0.0.1:8642/v1/chat/completions"))
        assertEquals("https://hermes.ts.net:8642", DirectHermesClient.normalizeBaseUrl("https://hermes.ts.net:8642/v1/"))
    }
}
