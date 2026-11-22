import XCTest
@testable import BotArk

final class SyncProtocolTests: XCTestCase {
    func testDesktopSnapshotReconcilesOptimisticSendByID() {
        let bot = SyncedBot(id: "bot", platformId: .hermes, name: "Fixture", groupId: "group",
                            activeAccountId: "account", activeSessionId: "session")
        var current = WorkspaceSnapshot.empty
        current.bots = [bot]
        var pending = SyncedMessage(id: "client-id", botId: "bot", accountId: "account", role: "user",
                                    text: "Draft", createdAt: 1, delivery: "sending")
        pending.isLocalRelayMessage = true
        current.messages = ["bot": [pending]]

        var incoming = WorkspaceSnapshot.empty
        incoming.bots = [bot]
        incoming.carryLocalRelayMessages(from: current)
        XCTAssertEqual(incoming.messages["bot"], [pending])
        XCTAssertEqual(incoming.withoutLocalRelayMessages.messages["bot"], [])

        var confirmed = pending
        confirmed.isLocalRelayMessage = false
        confirmed.delivery = "failed"
        incoming.messages = ["bot": [confirmed]]
        incoming.carryLocalRelayMessages(from: current)
        XCTAssertEqual(incoming.messages["bot"], [confirmed])

        incoming.messages = [:]
        incoming.bots[0].activeSessionId = "new-session"
        incoming.carryLocalRelayMessages(from: current)
        XCTAssertNil(incoming.messages["bot"])
    }

    func testParseValidPairingUriWithLanAndTailscaleHosts() {
        let uri = "botark://pair?v=1&hosts=192.168.1.24,100.88.12.5&port=19472&token=abc123token&key=QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI&name=MacBook%20Pro&fp=9A12BC34"
        let payload = PairingPayload.parse(uri)
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload?.version, 1)
        XCTAssertEqual(payload?.hosts, ["192.168.1.24", "100.88.12.5"])
        XCTAssertEqual(payload?.port, 19472)
        XCTAssertEqual(payload?.token, "abc123token")
        XCTAssertEqual(payload?.name, "MacBook Pro")
        XCTAssertEqual(payload?.fp, "9A12BC34")
    }

    func testRejectInvalidPairingUris() {
        XCTAssertNil(PairingPayload.parse("https://example.com/pair"))
        XCTAssertNil(PairingPayload.parse("botark://other?hosts=127.0.0.1&port=19472&token=x&key=y"))
        XCTAssertNil(PairingPayload.parse("botark://pair?hosts=&port=19472&token=x&key=y"))
        XCTAssertNil(PairingPayload.parse("botark://pair?hosts=127.0.0.1&port=99999&token=x&key=y"))
        XCTAssertNil(PairingPayload.parse("botark://pair?hosts=127.0.0.1&port=19472&token=&key=y"))
    }

    /// Exact cross-platform Node.js (`mobileSyncCrypto.ts`) <-> iOS Swift CryptoKit AES-256-GCM vector.
    /// Key = 32 x 0x42 (base64url), IV = 12 x 0x11, Plaintext = "BotArk-Zero-Server-2026".
    func testCrossPlatformNodeAesGcmDecryptionVector() throws {
        let keyB64Url = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"
        let nodeCombined = "ERERERERERERERER8QhfUh+nrX1Z7heaMOWG40BHL9Jxa+Y1CErghXDNameMDktFOYBf"

        let decrypted = try SyncCrypto.decryptAesGcmCombined(nodeCombined, keyBase64Url: keyB64Url)
        XCTAssertEqual(String(data: decrypted, encoding: .utf8), "BotArk-Zero-Server-2026")

        // Verify Swift encrypt with identical IV matches Node byte-for-byte
        let iv = Data(repeating: 0x11, count: 12)
        let reEncrypted = try SyncCrypto.encryptAesGcmCombined(
            Data("BotArk-Zero-Server-2026".utf8),
            keyBase64Url: keyB64Url,
            nonceData: iv
        )
        XCTAssertEqual(reEncrypted, nodeCombined)
    }

    func testAesGcmDecryptionRejectsWrongKey() {
        let wrongKey = SyncCrypto.encodeBase64Url(Data(repeating: 0x99, count: 32))
        let nodeCombined = "ERERERERERERERER8QhfUh+nrX1Z7heaMOWG40BHL9Jxa+Y1CErghXDNameMDktFOYBf"
        XCTAssertThrowsError(try SyncCrypto.decryptAesGcmCombined(nodeCombined, keyBase64Url: wrongKey))
    }

    func testHermesSseParserHandlesCrlfCommentsAndMultipleEvents() {
        var parser = HermesSseParser()
        XCTAssertNil(parser.feedLine(": keepalive\r"))
        XCTAssertNil(parser.feedLine("event: assistant.delta\r"))
        XCTAssertNil(parser.feedLine("data: {\"delta\":\"Hello\"}\r"))
        let first = parser.feedLine("\r")
        XCTAssertEqual(first?.event, "assistant.delta")
        XCTAssertEqual(first?.data, "{\"delta\":\"Hello\"}")

        XCTAssertNil(parser.feedLine("event: tool.started"))
        XCTAssertNil(parser.feedLine("data: {\"tool_name\":\"terminal\"}"))
        let second = parser.feedLine("")
        XCTAssertEqual(second?.event, "tool.started")
        XCTAssertEqual(second?.data, "{\"tool_name\":\"terminal\"}")

        XCTAssertNil(parser.feedLine("event: approval.request"))
        XCTAssertNil(parser.feedLine("data: {\"request_id\":\"req_1\",\"command\":\"git status\"}"))
        let third = parser.feedLine("")
        XCTAssertEqual(third?.event, "approval.request")
        XCTAssertEqual(third?.data, "{\"request_id\":\"req_1\",\"command\":\"git status\"}")
    }

    func testDirectHermesUrlNormalization() {
        XCTAssertEqual(DirectHermesClient.normalizeBaseUrl("127.0.0.1:8642/v1/chat/completions"), "http://127.0.0.1:8642")
        XCTAssertEqual(DirectHermesClient.normalizeBaseUrl("https://hermes.ts.net:8642/v1/"), "https://hermes.ts.net:8642")
        XCTAssertEqual(DirectHermesClient.normalizeBaseUrl("http://localhost:8642///"), "http://localhost:8642")
    }
}
