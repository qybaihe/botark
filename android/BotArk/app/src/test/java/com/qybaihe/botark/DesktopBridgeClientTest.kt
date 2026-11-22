package com.qybaihe.botark

import com.qybaihe.botark.model.PairedDesktopInfo
import com.qybaihe.botark.model.PlatformId
import com.qybaihe.botark.service.DesktopBridgeClient
import com.qybaihe.botark.service.DesktopBridgeException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class DesktopBridgeClientTest {
    private val commands = mutableListOf<Request>()
    private val desktop = PairedDesktopInfo(
        deviceId = "test-device",
        deviceToken = "test-token",
        hostName = "Test Desktop",
        activeHost = "127.0.0.1",
        candidateHosts = listOf("127.0.0.1"),
        port = 19472,
        fingerprint = "00000000",
        pairedAtMs = 0.0
    )
    @Test
    fun postsCommandsToDesktopRoutesWithEncodedIds() {
        val send = "/api/mobile/v1/bots/bot%2Fone/send"
        val stop = "/api/mobile/v1/bots/bot%2Fone/stop"
        val newSession = "/api/mobile/v1/bots/bot%2Fone/new-session"
        val approve = "/api/mobile/v1/approvals/account%2Fone/request%23two"
        val paths = listOf(send, stop, newSession, approve)
        val bridge = bridgeResponding { request -> if (request.url.encodedPath in paths) 200 else 404 }

        runBlocking {
            bridge.sendMessage(desktop, "bot/one", "Hello", "client-1")
            bridge.stopGeneration(desktop, "bot/one")
            bridge.startNewSession(desktop, "bot/one")
            bridge.decideApproval(desktop, "account/one", PlatformId.HERMES, "request#two", "allow_once")
        }

        assertEquals(paths, commands.map { it.url.encodedPath })
        assertTrue(commands.all { it.method == "POST" && it.header("Authorization") == "Bearer test-token" })
        assertEquals(
            JsonObject(mapOf("text" to JsonPrimitive("Hello"), "clientMessageId" to JsonPrimitive("client-1"))),
            Json.parseToJsonElement(bodyOf(commands[0]))
        )
        assertTrue(bodyOf(commands[1]).isEmpty() && bodyOf(commands[2]).isEmpty())
        assertEquals(
            JsonObject(mapOf("platformId" to JsonPrimitive("hermes"), "decision" to JsonPrimitive("allow_once"))),
            Json.parseToJsonElement(bodyOf(commands[3]))
        )
    }

    @Test
    fun reportsRejectedStopAndNewSessionCommands() {
        val bridge = bridgeResponding { request -> if (request.url.encodedPath.endsWith("/stop")) 401 else 503 }

        val stopError = assertThrows(DesktopBridgeException::class.java) {
            runBlocking { bridge.stopGeneration(desktop, "bot") }
        }
        assertTrue(stopError.unauthorized)
        val sessionError = assertThrows(DesktopBridgeException::class.java) {
            runBlocking { bridge.startNewSession(desktop, "bot") }
        }
        assertTrue(sessionError.message.orEmpty().contains("HTTP 503"))
    }

    private fun bridgeResponding(status: (Request) -> Int) = DesktopBridgeClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            commands.add(request)
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(status(request))
                .message("Test response")
                .body("".toResponseBody())
                .build()
        }.build()
    )

    private fun bodyOf(request: Request): String = Buffer().use { buffer ->
        request.body?.writeTo(buffer)
        buffer.readUtf8()
    }
}
