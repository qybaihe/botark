import Foundation
import UIKit

public enum DesktopBridgeError: LocalizedError {
    case noReachableHost([String])
    case invalidResponse(String)
    case unauthorized
    case serverError(String)

    public var errorDescription: String? {
        switch self {
        case .noReachableHost(let hosts):
            return "无法连接到电脑端（已探测：\(hosts.joined(separator: ", "))）。请确认手机与电脑在同一 Wi-Fi / 热点或 Tailscale 网络下，且电脑端已开启同步桥。"
        case .invalidResponse(let msg):
            return "电脑端返回了无效数据：\(msg)"
        case .unauthorized:
            return "设备授权已失效或已被电脑端移除，请重新扫码配对。"
        case .serverError(let msg):
            return msg
        }
    }
}

public actor DesktopBridgeClient {
    private let session: URLSession
    private var wsTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?

    public init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 12
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    /// Probes all advertised LAN / Tailscale IP candidates in parallel and returns the fastest responsive host.
    public func probeBestHost(hosts: [String], port: Int) async -> String? {
        await withTaskGroup(of: String?.self) { group in
            for host in hosts {
                group.addTask { [session] in
                    guard let url = URL(string: "http://\(host):\(port)/api/mobile/v1/ping") else { return nil }
                    var req = URLRequest(url: url)
                    req.timeoutInterval = 3.0
                    do {
                        let (data, resp) = try await session.data(for: req)
                        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
                        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           obj["ok"] as? Bool == true {
                            return host
                        }
                        return nil
                    } catch {
                        return nil
                    }
                }
            }
            for await result in group {
                if let winner = result {
                    group.cancelAll()
                    return winner
                }
            }
            return nil
        }
    }

    /// Performs single-use QR pairing handshake and returns PairedDesktopInfo + initial snapshot + optional decrypted Hermes credentials.
    public func pair(
        payload: PairingPayload
    ) async throws -> (PairedDesktopInfo, WorkspaceSnapshot, [DirectHermesCredential]) {
        guard let activeHost = await probeBestHost(hosts: payload.hosts, port: payload.port) else {
            throw DesktopBridgeError.noReachableHost(payload.hosts)
        }
        guard let url = URL(string: "http://\(activeHost):\(payload.port)/api/mobile/v1/pair") else {
            throw DesktopBridgeError.invalidResponse("Bad pair URL")
        }

        let (deviceName, deviceModel) = await MainActor.run {
            (UIDevice.current.name, UIDevice.current.model)
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "pairToken": payload.token,
            "deviceName": deviceName,
            "deviceModel": deviceModel
        ])

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw DesktopBridgeError.invalidResponse("No HTTP status")
        }
        let decoded = try JSONDecoder().decode(PairApiResponse.self, from: data)
        guard http.statusCode == 200, decoded.ok,
              let deviceId = decoded.deviceId,
              let deviceToken = decoded.deviceToken else {
            throw DesktopBridgeError.serverError(decoded.message ?? "配对失败（HTTP \(http.statusCode)）")
        }

        var directCreds: [DirectHermesCredential] = []
        if let enc = decoded.directCredentialsEnc, !enc.isEmpty {
            if let plain = try? SyncCrypto.decryptAesGcmCombined(enc, keyBase64Url: payload.key),
               let parsed = try? JSONDecoder().decode([DirectHermesCredential].self, from: plain) {
                directCreds = parsed
            }
        }

        let info = PairedDesktopInfo(
            deviceId: deviceId,
            deviceToken: deviceToken,
            hostName: decoded.hostName ?? payload.name,
            activeHost: activeHost,
            candidateHosts: payload.hosts,
            port: payload.port,
            fingerprint: decoded.fp ?? payload.fp,
            pairedAtMs: Date().timeIntervalSince1970 * 1000
        )
        return (info, decoded.snapshot ?? .empty, directCreds)
    }

    public func fetchSnapshot(desktop: PairedDesktopInfo) async throws -> WorkspaceSnapshot {
        guard let url = URL(string: "http://\(desktop.activeHost):\(desktop.port)/api/mobile/v1/snapshot") else {
            throw DesktopBridgeError.invalidResponse("Invalid URL")
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(desktop.deviceToken)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw DesktopBridgeError.invalidResponse("No HTTP status")
        }
        if http.statusCode == 401 { throw DesktopBridgeError.unauthorized }
        guard http.statusCode == 200 else {
            throw DesktopBridgeError.serverError("同步快照失败（HTTP \(http.statusCode)）")
        }
        struct Wrapper: Decodable { let ok: Bool; let snapshot: WorkspaceSnapshot }
        return try JSONDecoder().decode(Wrapper.self, from: data).snapshot
    }

    public func sendMessage(desktop: PairedDesktopInfo, botId: String, text: String, clientMessageId: String) async throws -> String? {
        let pathSegment = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
        let encodedBot = botId.addingPercentEncoding(withAllowedCharacters: pathSegment) ?? botId
        guard let url = URL(string: "http://\(desktop.activeHost):\(desktop.port)/api/mobile/v1/bots/\(encodedBot)/send") else {
            throw DesktopBridgeError.invalidResponse("Invalid URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(desktop.deviceToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "text": text,
            "clientMessageId": clientMessageId
        ])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw DesktopBridgeError.invalidResponse("No status") }
        if http.statusCode == 401 { throw DesktopBridgeError.unauthorized }
        struct SendResponse: Decodable { let messageId: String?; let message: String? }
        let payload = try? JSONDecoder().decode(SendResponse.self, from: data)
        guard http.statusCode == 200 else {
            throw DesktopBridgeError.serverError(payload?.message ?? "发送失败（HTTP \(http.statusCode)）")
        }
        return payload?.messageId
    }

    public func stopGeneration(desktop: PairedDesktopInfo, botId: String) async {
        let encodedBot = botId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? botId
        guard let url = URL(string: "http://\(desktop.activeHost):\(desktop.port)/api/mobile/v1/bots/\(encodedBot)/stop") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(desktop.deviceToken)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    public func startNewSession(desktop: PairedDesktopInfo, botId: String) async {
        let encodedBot = botId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? botId
        guard let url = URL(string: "http://\(desktop.activeHost):\(desktop.port)/api/mobile/v1/bots/\(encodedBot)/new-session") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(desktop.deviceToken)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    public func decideApproval(
        desktop: PairedDesktopInfo,
        accountId: String,
        platformId: PlatformId,
        approvalId: String,
        decision: String
    ) async throws {
        let a = accountId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? accountId
        let p = approvalId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? approvalId
        guard let url = URL(string: "http://\(desktop.activeHost):\(desktop.port)/api/mobile/v1/approvals/\(a)/\(p)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(desktop.deviceToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "platformId": platformId.rawValue,
            "decision": decision
        ])
        let (_, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 401 {
            throw DesktopBridgeError.unauthorized
        }
    }

    /// Opens an authenticated live WebSocket stream to BotArk Desktop.
    public func connectWebSocket(
        desktop: PairedDesktopInfo,
        onEvent: @escaping @Sendable (MobileWsEnvelope) -> Void,
        onDisconnect: @escaping @Sendable (Error?) -> Void
    ) {
        disconnectWebSocket()
        guard let tokenParam = desktop.deviceToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "ws://\(desktop.activeHost):\(desktop.port)/api/mobile/v1/ws?token=\(tokenParam)") else {
            onDisconnect(DesktopBridgeError.invalidResponse("Bad WS URL"))
            return
        }

        let task = session.webSocketTask(with: url)
        self.wsTask = task
        task.resume()

        self.receiveTask = Task {
            let decoder = JSONDecoder()
            while !Task.isCancelled {
                do {
                    let msg = try await task.receive()
                    let rawData: Data?
                    switch msg {
                    case .string(let s): rawData = Data(s.utf8)
                    case .data(let d): rawData = d
                    @unknown default: rawData = nil
                    }
                    if let rawData, let env = try? decoder.decode(MobileWsEnvelope.self, from: rawData) {
                        if env.type != "pong" {
                            onEvent(env)
                        }
                    }
                } catch {
                    if !Task.isCancelled {
                        onDisconnect(error)
                    }
                    break
                }
            }
        }

        self.pingTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled else { break }
                try? await task.send(.string("{\"type\":\"ping\"}"))
            }
        }
    }

    public func disconnectWebSocket() {
        receiveTask?.cancel()
        receiveTask = nil
        pingTask?.cancel()
        pingTask = nil
        wsTask?.cancel(with: .normalClosure, reason: nil)
        wsTask = nil
    }
}
