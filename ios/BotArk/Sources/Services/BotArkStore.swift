import Foundation
import Observation
import UserNotifications

public enum BridgeConnectionState: Equatable {
    case unpaired
    case connecting
    case connected(hostName: String, activeHost: String)
    case offline(hostName: String)

    public var isBridgeConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

public struct PendingApprovalItem: Identifiable, Equatable {
    public var id: String { "\(accountId)::\(approval.id)" }
    public let accountId: String
    public let botName: String
    public let platformId: PlatformId
    public let approval: SyncedApproval
}

@Observable
@MainActor
public final class BotArkStore {
    public var snapshot: WorkspaceSnapshot = .empty
    public var pairedDesktop: PairedDesktopInfo?
    public var directHermesCredentials: [DirectHermesCredential] = []
    public var connectionState: BridgeConnectionState = .unpaired
    public var typingByBotId: [String: Bool] = [:]
    public var lastError: String?
    public var pairingBusy = false

    private let bridge = DesktopBridgeClient()
    private let directHermes = DirectHermesClient()
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempt: Int = 0
    private var activeDirectTasks: [String: Task<Void, Never>] = [:]

    private static var cacheUrl: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("BotArk", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("workspace-cache.json")
    }

    public init() {
        self.pairedDesktop = KeychainStore.loadPairedDesktop()
        self.directHermesCredentials = KeychainStore.loadDirectHermesCredentials()
        loadCacheFromDisk()
        if let desktop = pairedDesktop {
            connectionState = .offline(hostName: desktop.hostName)
            Task { await reconnectDesktop() }
        }
    }

    // MARK: - Derived Helpers

    public var pendingApprovals: [PendingApprovalItem] {
        var list: [PendingApprovalItem] = []
        for (accountId, items) in snapshot.approvals {
            let bot = snapshot.bots.first { $0.activeAccountId == accountId }
            let acc = snapshot.accounts[accountId]
            let platform = bot?.platformId ?? acc?.platformId ?? .metaMuse
            let name = bot?.name ?? acc?.displayName ?? platform.displayName
            for apr in items where apr.status == "pending" {
                list.append(PendingApprovalItem(accountId: accountId, botName: name, platformId: platform, approval: apr))
            }
        }
        return list
    }

    public func status(for bot: SyncedBot) -> ConnectionStatus {
        if bot.isStandaloneWeb { return .online }
        if let acc = snapshot.accounts[bot.activeAccountId] {
            if !connectionState.isBridgeConnected && bot.platformId == .hermes && directCredential(for: bot) != nil {
                return .online
            }
            return acc.status
        }
        return directCredential(for: bot) != nil ? .online : .offline
    }

    public var hasStandaloneBots: Bool {
        !directHermesCredentials.isEmpty || snapshot.bots.contains(where: \.isStandaloneWeb)
    }

    public func directCredential(for bot: SyncedBot) -> DirectHermesCredential? {
        guard bot.platformId == .hermes else { return nil }
        return directHermesCredentials.first { $0.accountId == bot.activeAccountId || $0.botId == bot.id }
    }

    public func canSend(to bot: SyncedBot) -> Bool {
        if bot.isStandaloneWeb { return true }
        if connectionState.isBridgeConnected { return true }
        return directCredential(for: bot) != nil
    }

    public func transportSummary(for bot: SyncedBot) -> String {
        if bot.isStandaloneWeb {
            return "手机独立直连"
        }
        if case .connected(let hostName, _) = connectionState {
            return "经 \(hostName) 实时桥接"
        }
        if directCredential(for: bot) != nil {
            return "Hermes 脱机直连"
        }
        return "离线只读缓存（回到同一局域网自动重连）"
    }

    // MARK: - Zero-Server QR Pairing

    public func pair(withUri rawUri: String) async {
        guard let payload = PairingPayload.parse(rawUri) else {
            lastError = "二维码格式无效，请扫描 BotArk 电脑端「iOS 扫码同步」中的配对码。"
            return
        }
        pairingBusy = true
        lastError = nil
        defer { pairingBusy = false }

        do {
            let (info, initialSnapshot, directCreds) = try await bridge.pair(payload: payload)
            self.pairedDesktop = info
            KeychainStore.savePairedDesktop(info)
            if !directCreds.isEmpty {
                mergeDirectHermesCredentials(directCreds)
            }
            applySnapshot(initialSnapshot)
            connectionState = .connected(hostName: info.hostName, activeHost: info.activeHost)
            openLiveSocket(for: info)
            if ProcessInfo.processInfo.environment["BOTARK_TEST_PAIR_URI"] == nil {
                requestNotificationPermission()
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func reconnectDesktop() async {
        guard var desktop = pairedDesktop else {
            connectionState = .unpaired
            return
        }
        connectionState = .connecting
        lastError = nil

        var hostsToTry = [desktop.activeHost]
        for h in desktop.candidateHosts where !hostsToTry.contains(h) {
            hostsToTry.append(h)
        }

        if let best = await bridge.probeBestHost(hosts: hostsToTry, port: desktop.port) {
            desktop.activeHost = best
            self.pairedDesktop = desktop
            KeychainStore.savePairedDesktop(desktop)
            do {
                let fresh = try await bridge.fetchSnapshot(desktop: desktop)
                applySnapshot(fresh)
                reconnectAttempt = 0
                connectionState = .connected(hostName: desktop.hostName, activeHost: best)
                openLiveSocket(for: desktop)
                return
            } catch DesktopBridgeError.unauthorized {
                lastError = DesktopBridgeError.unauthorized.localizedDescription
                connectionState = .offline(hostName: desktop.hostName)
                return
            } catch {
                lastError = error.localizedDescription
            }
        }
        connectionState = .offline(hostName: desktop.hostName)
    }

    public func unpairDesktop() {
        reconnectTask?.cancel()
        reconnectTask = nil
        Task { await bridge.disconnectWebSocket() }
        KeychainStore.clearPairedDesktop()
        pairedDesktop = nil
        connectionState = .unpaired
    }

    public func wipeAllLocalData() {
        unpairDesktop()
        KeychainStore.clearDirectHermesCredentials()
        directHermesCredentials = []
        snapshot = .empty
        typingByBotId = [:]
        try? FileManager.default.removeItem(at: Self.cacheUrl)
    }

    // MARK: - Encrypted AirDrop Offline Bundle Import (.botark-sync)

    public func importOfflineBundle(fileData: Data, transferKey: String) throws {
        let outer = try JSONDecoder().decode(OfflineSyncOuterBundle.self, from: fileData)
        guard outer.format == "botark-sync-v1" else {
            throw DesktopBridgeError.invalidResponse("不支持的同步包格式：\(outer.format)")
        }
        let plainData = try SyncCrypto.decryptAesGcmCombined(outer.payload, keyBase64Url: transferKey)
        let inner = try JSONDecoder().decode(OfflineSyncInnerPayload.self, from: plainData)
        if let creds = inner.directCredentials, !creds.isEmpty {
            mergeDirectHermesCredentials(creds)
        }
        applySnapshot(inner.snapshot)
        lastError = nil
    }

    // MARK: - Standalone Add Hermes Server (No Computer Needed)

    public func addStandaloneHermes(name: String, baseUrl: String, apiKey: String?, model: String?) async throws {
        let normalizedUrl = DirectHermesClient.normalizeBaseUrl(baseUrl)
        let (_, defaultModel) = try await directHermes.probe(baseUrl: normalizedUrl, apiKey: apiKey)
        let finalModel = (model?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ? model!.trimmingCharacters(in: .whitespacesAndNewlines) : defaultModel

        let accountId = "acc_ios_hermes_\(UUID().uuidString.prefix(8).lowercased())"
        let botId = "bot_ios_hermes_\(UUID().uuidString.prefix(8).lowercased())"
        let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Hermes" : name.trimmingCharacters(in: .whitespacesAndNewlines)

        let cred = DirectHermesCredential(
            accountId: accountId,
            botId: botId,
            botName: displayName,
            baseUrl: normalizedUrl,
            apiKey: apiKey?.trimmingCharacters(in: .whitespacesAndNewlines),
            model: finalModel,
            displayName: displayName
        )
        mergeDirectHermesCredentials([cred])

        let groupId: String
        if let firstGroup = snapshot.groups.first {
            groupId = firstGroup.id
        } else {
            groupId = "grp_standalone"
            snapshot.groups.append(SyncedGroup(id: groupId, name: "个人智能体", collapsed: false))
        }
        snapshot.accounts[accountId] = SyncedAccount(
            id: accountId,
            platformId: .hermes,
            displayName: displayName,
            handle: normalizedUrl,
            status: .online
        )
        snapshot.bots.insert(
            SyncedBot(
                id: botId,
                platformId: .hermes,
                name: displayName,
                avatarShape: "clover",
                avatarColor: "green",
                groupId: groupId,
                activeAccountId: accountId
            ),
            at: 0
        )
        snapshot.messages[botId] = []
        saveCacheToDisk()
    }

    @discardableResult
    public func addStandaloneWebBot(platformId: PlatformId, name: String, customUrl: String? = nil) -> SyncedBot {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = trimmedName.isEmpty ? platformId.displayName : trimmedName
        let rawUrl = (customUrl?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? customUrl!.trimmingCharacters(in: .whitespacesAndNewlines)
            : platformId.defaultHomeUrl
        let finalUrl = rawUrl.hasPrefix("http://") || rawUrl.hasPrefix("https://")
            ? rawUrl
            : "https://\(rawUrl)"
        let host = URL(string: finalUrl)?.host ?? finalUrl

        let suffix = UUID().uuidString.prefix(8).lowercased()
        let accountId = "acc_ios_\(platformId.rawValue)_\(suffix)"
        let botId = "bot_ios_\(platformId.rawValue)_\(suffix)"

        let groupId: String
        if let firstGroup = snapshot.groups.first {
            groupId = firstGroup.id
        } else {
            groupId = "grp_standalone"
            snapshot.groups.append(SyncedGroup(id: groupId, name: "个人智能体", collapsed: false))
        }

        snapshot.accounts[accountId] = SyncedAccount(
            id: accountId,
            platformId: platformId,
            displayName: displayName,
            handle: host,
            status: .online
        )
        let bot = SyncedBot(
            id: botId,
            platformId: platformId,
            name: displayName,
            groupId: groupId,
            activeAccountId: accountId,
            standaloneUrl: finalUrl
        )
        snapshot.bots.insert(bot, at: 0)
        snapshot.messages[botId] = []
        saveCacheToDisk()
        return bot
    }

    public func removeStandaloneBot(botId: String) {
        guard let removed = snapshot.bots.first(where: { $0.id == botId }) else { return }
        snapshot.bots.removeAll { $0.id == botId }
        snapshot.accounts.removeValue(forKey: removed.activeAccountId)
        snapshot.messages.removeValue(forKey: botId)
        directHermesCredentials.removeAll { $0.botId == botId || $0.accountId == removed.activeAccountId }
        KeychainStore.saveDirectHermesCredentials(directHermesCredentials)
        saveCacheToDisk()
    }

    // MARK: - Messaging & Approvals (Dual-Mode: Desktop Bridge or Direct Hermes)

    public func sendMessage(to bot: SyncedBot, text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let clientMsgId = "ios_msg_\(UUID().uuidString.lowercased())"
        var userMsg = SyncedMessage(
            id: clientMsgId,
            botId: bot.id,
            accountId: bot.activeAccountId,
            role: "user",
            text: trimmed,
            createdAt: Date().timeIntervalSince1970 * 1000,
            delivery: "sending"
        )
        if let desktop = pairedDesktop, connectionState.isBridgeConnected {
            userMsg.isLocalRelayMessage = true
            appendOrUpdateMessage(botId: bot.id, message: userMsg)
            do {
                let messageId = try await bridge.sendMessage(desktop: desktop, botId: bot.id, text: trimmed, clientMessageId: clientMsgId)
                if messageId != clientMsgId {
                    // Older desktops publish their own ID in the next snapshot.
                    snapshot.messages[bot.id]?.removeAll { $0.id == clientMsgId && $0.isLocalRelayMessage }
                }
            } catch {
                if let index = snapshot.messages[bot.id]?.firstIndex(where: { $0.id == clientMsgId && $0.isLocalRelayMessage }) {
                    snapshot.messages[bot.id]?[index].delivery = "failed"
                    snapshot.messages[bot.id]?[index].error = error.localizedDescription
                }
            }
            return
        }
        appendOrUpdateMessage(botId: bot.id, message: userMsg)

        // Path 2: Standalone Direct Hermes SSE (computer asleep / away!)
        if let cred = directCredential(for: bot) {
            markMessageDelivery(botId: bot.id, messageId: clientMsgId, delivery: "sent", error: nil)
            typingByBotId[bot.id] = true
            activeDirectTasks[bot.id]?.cancel()
            activeDirectTasks[bot.id] = Task {
                do {
                    let result = try await directHermes.streamChat(
                        credential: cred,
                        botId: bot.id,
                        sessionId: bot.activeSessionId,
                        text: trimmed,
                        onDelta: { [weak self] msgId, partialText, tools, sid in
                            Task { @MainActor in
                                guard let self else { return }
                                if let sid, let idx = self.snapshot.bots.firstIndex(where: { $0.id == bot.id }) {
                                    self.snapshot.bots[idx].activeSessionId = sid
                                }
                                self.appendOrUpdateMessage(
                                    botId: bot.id,
                                    message: SyncedMessage(
                                        id: msgId,
                                        botId: bot.id,
                                        accountId: bot.activeAccountId,
                                        role: "bot",
                                        text: partialText,
                                        createdAt: Date().timeIntervalSince1970 * 1000,
                                        tools: tools.isEmpty ? nil : tools
                                    )
                                )
                            }
                        },
                        onApproval: { [weak self] approvals in
                            Task { @MainActor in
                                self?.snapshot.approvals[bot.activeAccountId] = approvals
                                if let first = approvals.first {
                                    self?.postLocalNotification(title: "\(bot.name) 需要审批", body: first.title)
                                }
                            }
                        }
                    )
                    if let sid = result.sessionId, let idx = self.snapshot.bots.firstIndex(where: { $0.id == bot.id }) {
                        self.snapshot.bots[idx].activeSessionId = sid
                    }
                    self.appendOrUpdateMessage(
                        botId: bot.id,
                        message: SyncedMessage(
                            id: result.messageId,
                            botId: bot.id,
                            accountId: bot.activeAccountId,
                            role: "bot",
                            text: result.finalText,
                            createdAt: Date().timeIntervalSince1970 * 1000,
                            tools: result.tools.isEmpty ? nil : result.tools
                        )
                    )
                    self.typingByBotId[bot.id] = false
                    self.saveCacheToDisk()
                } catch {
                    self.typingByBotId[bot.id] = false
                    self.markMessageDelivery(botId: bot.id, messageId: clientMsgId, delivery: "failed", error: error.localizedDescription)
                    self.lastError = error.localizedDescription
                }
            }
            return
        }

        markMessageDelivery(botId: bot.id, messageId: clientMsgId, delivery: "failed", error: "电脑端未连接，无法向该平台发送消息")
    }

    public func stopGeneration(for bot: SyncedBot) {
        typingByBotId[bot.id] = false
        activeDirectTasks[bot.id]?.cancel()
        activeDirectTasks.removeValue(forKey: bot.id)
        if let desktop = pairedDesktop, connectionState.isBridgeConnected {
            Task { await bridge.stopGeneration(desktop: desktop, botId: bot.id) }
        }
    }

    public func startNewSession(for bot: SyncedBot) {
        if let desktop = pairedDesktop, connectionState.isBridgeConnected {
            Task { await bridge.startNewSession(desktop: desktop, botId: bot.id) }
        } else if let idx = snapshot.bots.firstIndex(where: { $0.id == bot.id }) {
            snapshot.bots[idx].activeSessionId = nil
            snapshot.messages[bot.id] = []
            saveCacheToDisk()
        }
    }

    public func decideApproval(item: PendingApprovalItem, decision: String) async {
        // Optimistically remove card
        if var list = snapshot.approvals[item.accountId] {
            list.removeAll { $0.id == item.approval.id }
            snapshot.approvals[item.accountId] = list
        }
        if let desktop = pairedDesktop, connectionState.isBridgeConnected {
            do {
                try await bridge.decideApproval(
                    desktop: desktop,
                    accountId: item.accountId,
                    platformId: item.platformId,
                    approvalId: item.approval.id,
                    decision: decision
                )
            } catch {
                lastError = error.localizedDescription
            }
        } else if item.platformId == .hermes,
                  let cred = directHermesCredentials.first(where: { $0.accountId == item.accountId }) {
            try? await directHermes.decideApproval(credential: cred, approvalId: item.approval.id, decision: decision)
        }
    }

    // MARK: - Live WebSocket Handling

    private func openLiveSocket(for desktop: PairedDesktopInfo) {
        reconnectTask?.cancel()
        Task {
            await bridge.connectWebSocket(
                desktop: desktop,
                onEvent: { [weak self] env in
                    Task { @MainActor in
                        self?.handleWsEnvelope(env)
                    }
                },
                onDisconnect: { [weak self] _ in
                    Task { @MainActor in
                        guard let self, let current = self.pairedDesktop else { return }
                        self.connectionState = .offline(hostName: current.hostName)
                        self.scheduleReconnect()
                    }
                }
            )
        }
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectAttempt = min(reconnectAttempt + 1, 4)
        let delaySec = min(24, 3 * (1 << max(0, reconnectAttempt - 1)))
        reconnectTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delaySec) * 1_000_000_000)
            guard !Task.isCancelled, pairedDesktop != nil else { return }
            await reconnectDesktop()
        }
    }

    private func handleWsEnvelope(_ env: MobileWsEnvelope) {
        switch env.type {
        case "snapshot":
            if let snap = env.snapshot {
                applySnapshot(snap)
            }
        case "message_delta":
            if let botId = env.botId, let msgId = env.messageId {
                typingByBotId[botId] = true
                appendOrUpdateMessage(
                    botId: botId,
                    message: SyncedMessage(
                        id: msgId,
                        botId: botId,
                        accountId: env.accountId ?? "",
                        role: "bot",
                        text: env.text ?? "",
                        createdAt: Date().timeIntervalSince1970 * 1000,
                        tools: env.tools,
                        media: env.media
                    )
                )
            }
        case "message":
            if let botId = env.botId, let msg = env.message {
                typingByBotId[botId] = false
                appendOrUpdateMessage(botId: botId, message: msg)
                saveCacheToDisk()
                if !msg.isUser, let botName = snapshot.bots.first(where: { $0.id == botId })?.name {
                    postLocalNotification(title: botName, body: String(msg.text.prefix(120)))
                }
            }
        case "typing":
            if let botId = env.botId, let isTyping = env.isTyping {
                typingByBotId[botId] = isTyping
            }
        case "status":
            if let accountId = env.accountId, let status = env.status, var acc = snapshot.accounts[accountId] {
                acc.status = status
                acc.statusDetail = env.detail
                snapshot.accounts[accountId] = acc
            }
        case "approvals":
            if let accountId = env.accountId, let pending = env.pending {
                snapshot.approvals[accountId] = pending
                if let first = pending.first {
                    let botName = snapshot.bots.first { $0.activeAccountId == accountId }?.name ?? "BotArk"
                    postLocalNotification(title: "\(botName) 需要安全审批", body: first.title)
                }
            }
        default:
            break
        }
    }

    // MARK: - Local Cache & Notifications

    private func applySnapshot(_ incoming: WorkspaceSnapshot) {
        let localOnlyBots = snapshot.bots.filter { bot in
            (bot.isStandaloneWeb || bot.id.hasPrefix("bot_ios_")) &&
            !incoming.bots.contains(where: { $0.id == bot.id })
        }
        var merged = incoming
        merged.carryLocalRelayMessages(from: snapshot)
        if !localOnlyBots.isEmpty {
            let fallbackGroupId = merged.groups.first?.id ?? "grp_standalone"
            if merged.groups.isEmpty {
                merged.groups.append(SyncedGroup(id: fallbackGroupId, name: "个人智能体", collapsed: false))
            }
            for var bot in localOnlyBots {
                if !merged.groups.contains(where: { $0.id == bot.groupId }) {
                    bot.groupId = fallbackGroupId
                }
                merged.bots.append(bot)
                if let acc = snapshot.accounts[bot.activeAccountId] {
                    merged.accounts[bot.activeAccountId] = acc
                }
                if let msgs = snapshot.messages[bot.id] {
                    merged.messages[bot.id] = msgs
                }
            }
        }
        self.snapshot = merged
        saveCacheToDisk()
    }

    private func mergeDirectHermesCredentials(_ incoming: [DirectHermesCredential]) {
        var map = Dictionary(uniqueKeysWithValues: directHermesCredentials.map { ($0.accountId, $0) })
        for c in incoming { map[c.accountId] = c }
        directHermesCredentials = Array(map.values)
        KeychainStore.saveDirectHermesCredentials(directHermesCredentials)
    }

    private func appendOrUpdateMessage(botId: String, message: SyncedMessage) {
        var list = snapshot.messages[botId] ?? []
        if let idx = list.firstIndex(where: { $0.id == message.id }) {
            list[idx] = message
        } else {
            list.append(message)
        }
        snapshot.messages[botId] = list
    }

    private func markMessageDelivery(botId: String, messageId: String, delivery: String, error: String?) {
        guard var list = snapshot.messages[botId],
              let idx = list.firstIndex(where: { $0.id == messageId }) else { return }
        list[idx].delivery = delivery
        list[idx].error = error
        snapshot.messages[botId] = list
    }

    private func saveCacheToDisk() {
        if let data = try? JSONEncoder().encode(snapshot.withoutLocalRelayMessages) {
            try? data.write(to: Self.cacheUrl, options: [.atomic, .completeFileProtection])
        }
    }

    private func loadCacheFromDisk() {
        guard let data = try? Data(contentsOf: Self.cacheUrl),
              let cached = try? JSONDecoder().decode(WorkspaceSnapshot.self, from: data) else { return }
        self.snapshot = cached
    }

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func postLocalNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }
}
