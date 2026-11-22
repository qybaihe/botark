import Foundation

public enum PlatformId: String, Codable, CaseIterable, Identifiable, Sendable {
    case metaMuse = "meta-muse"
    case grok = "grok"
    case dot = "dot"
    case hark = "hark"
    case hermes = "hermes"
    case antigravity = "antigravity"

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .metaMuse: return "Meta Muse"
        case .grok: return "Grok Bot"
        case .dot: return "ChatGPT Dot"
        case .hark: return "Hark"
        case .hermes: return "Hermes"
        case .antigravity: return "Antigravity"
        }
    }

    public var shortLabel: String {
        switch self {
        case .metaMuse: return "Muse"
        case .grok: return "Grok"
        case .dot: return "Dot"
        case .hark: return "Hark"
        case .hermes: return "Hermes"
        case .antigravity: return "Antigravity"
        }
    }

    public var assetImageName: String {
        switch self {
        case .metaMuse: return "PlatformMuse"
        case .grok: return "PlatformGrok"
        case .dot: return "PlatformDot"
        case .hark: return "PlatformHark"
        case .hermes: return "PlatformHermes"
        case .antigravity: return "PlatformAntigravity"
        }
    }

    public var supportsQuickNewSession: Bool {
        self == .metaMuse || self == .grok || self == .hermes || self == .antigravity
    }

    public var defaultHomeUrl: String {
        switch self {
        case .antigravity: return "https://antigravity.google.com"
        case .metaMuse: return "https://muse.ai"
        case .grok: return "https://grok.com"
        case .dot: return "https://chatgpt.com/dots"
        case .hark: return "https://app.hark.com"
        case .hermes: return ""
        }
    }

    public var standaloneSubtitle: String {
        switch self {
        case .antigravity: return "Google 云端 Agent"
        case .metaMuse: return "Meta 个人智能体"
        case .grok: return "xAI Grok"
        case .dot: return "OpenAI Dot"
        case .hark: return "Hark 个人助手"
        case .hermes: return "开源 SSE 网关"
        }
    }

    public var standaloneTag: String {
        self == .hermes ? "原生直连" : "独立登录"
    }

    public static let pickerOrder: [PlatformId] = [
        .antigravity, .metaMuse, .grok, .dot, .hark, .hermes
    ]
}

public enum ConnectionStatus: String, Codable, Sendable {
    case online
    case busy
    case attention
    case offline
    case error

    public var isLive: Bool {
        self == .online || self == .busy || self == .attention
    }

    public var label: String {
        switch self {
        case .online: return "在线"
        case .busy: return "运行中"
        case .attention: return "待审批"
        case .offline: return "离线"
        case .error: return "异常"
        }
    }
}

public struct SyncedGroup: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let collapsed: Bool

    public init(id: String, name: String, collapsed: Bool = false) {
        self.id = id
        self.name = name
        self.collapsed = collapsed
    }
}

public struct SyncedAccount: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let platformId: PlatformId
    public var displayName: String
    public var handle: String
    public var status: ConnectionStatus
    public var statusDetail: String?

    public init(
        id: String,
        platformId: PlatformId,
        displayName: String,
        handle: String,
        status: ConnectionStatus,
        statusDetail: String? = nil
    ) {
        self.id = id
        self.platformId = platformId
        self.displayName = displayName
        self.handle = handle
        self.status = status
        self.statusDetail = statusDetail
    }
}

public struct SyncedBot: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let platformId: PlatformId
    public var name: String
    public var avatar: String?
    public var avatarShape: String?
    public var avatarColor: String?
    public var emoji: String?
    public var groupId: String
    public var pinned: Bool?
    public var activeAccountId: String
    public var activeSessionId: String?
    public var standaloneUrl: String?
    public var lastActivityAt: Double

    public var isStandaloneWeb: Bool {
        guard let url = standaloneUrl?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return !url.isEmpty
    }

    public init(
        id: String,
        platformId: PlatformId,
        name: String,
        avatar: String? = nil,
        avatarShape: String? = nil,
        avatarColor: String? = nil,
        emoji: String? = nil,
        groupId: String,
        pinned: Bool? = nil,
        activeAccountId: String,
        activeSessionId: String? = nil,
        standaloneUrl: String? = nil,
        lastActivityAt: Double = Date().timeIntervalSince1970 * 1000
    ) {
        self.id = id
        self.platformId = platformId
        self.name = name
        self.avatar = avatar
        self.avatarShape = avatarShape
        self.avatarColor = avatarColor
        self.emoji = emoji
        self.groupId = groupId
        self.pinned = pinned
        self.activeAccountId = activeAccountId
        self.activeSessionId = activeSessionId
        self.standaloneUrl = standaloneUrl
        self.lastActivityAt = lastActivityAt
    }
}

public struct SyncedToolCall: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public var toolType: String?
    public var status: String
    public var summary: String?

    public init(id: String, name: String, toolType: String? = nil, status: String, summary: String? = nil) {
        self.id = id
        self.name = name
        self.toolType = toolType
        self.status = status
        self.summary = summary
    }
}

public struct SyncedMediaPart: Codable, Equatable, Sendable {
    public let kind: String
    public let path: String
    public var name: String?
    public var mimeType: String?
}

public struct SyncedMessage: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let botId: String
    public let accountId: String
    public let role: String // "user" | "bot"
    public var text: String
    public var createdAt: Double
    public var delivery: String?
    public var error: String?
    public var tools: [SyncedToolCall]?
    public var media: [SyncedMediaPart]?
    var isLocalRelayMessage = false

    private enum CodingKeys: String, CodingKey {
        case id, botId, accountId, role, text, createdAt, delivery, error, tools, media
    }

    public var isUser: Bool { role == "user" }

    public init(
        id: String,
        botId: String,
        accountId: String,
        role: String,
        text: String,
        createdAt: Double,
        delivery: String? = nil,
        error: String? = nil,
        tools: [SyncedToolCall]? = nil,
        media: [SyncedMediaPart]? = nil
    ) {
        self.id = id
        self.botId = botId
        self.accountId = accountId
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.delivery = delivery
        self.error = error
        self.tools = tools
        self.media = media
    }
}

public struct SyncedApproval: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var status: String
    public var title: String
    public var detail: String?
    public var approvalType: String?
    public var host: String?
    public var decisionOptions: [String]?
    public var reason: String?

    public init(
        id: String,
        status: String = "pending",
        title: String,
        detail: String? = nil,
        approvalType: String? = nil,
        host: String? = nil,
        decisionOptions: [String]? = nil,
        reason: String? = nil
    ) {
        self.id = id
        self.status = status
        self.title = title
        self.detail = detail
        self.approvalType = approvalType
        self.host = host
        self.decisionOptions = decisionOptions
        self.reason = reason
    }
}

public struct WorkspaceSnapshot: Codable, Equatable, Sendable {
    public var version: Int
    public var updatedAtMs: Double
    public var hostName: String
    public var selectedBotId: String?
    public var groups: [SyncedGroup]
    public var bots: [SyncedBot]
    public var accounts: [String: SyncedAccount]
    public var messages: [String: [SyncedMessage]]
    public var approvals: [String: [SyncedApproval]]

    public static let empty = WorkspaceSnapshot(
        version: 1,
        updatedAtMs: 0,
        hostName: "",
        selectedBotId: nil,
        groups: [],
        bots: [],
        accounts: [:],
        messages: [:],
        approvals: [:]
    )

    mutating func carryLocalRelayMessages(from current: WorkspaceSnapshot) {
        for bot in bots {
            guard let previous = current.bots.first(where: { $0.id == bot.id }),
                  previous.activeAccountId == bot.activeAccountId,
                  previous.activeSessionId == bot.activeSessionId else { continue }
            let receivedIds = Set(messages[bot.id, default: []].map(\.id))
            let pending = current.messages[bot.id, default: []].filter {
                $0.isLocalRelayMessage && !receivedIds.contains($0.id)
            }
            if !pending.isEmpty { messages[bot.id, default: []].append(contentsOf: pending) }
        }
    }

    var withoutLocalRelayMessages: WorkspaceSnapshot {
        var result = self
        result.messages = messages.mapValues { $0.filter { !$0.isLocalRelayMessage } }
        return result
    }
}

public struct DirectHermesCredential: Codable, Identifiable, Equatable, Sendable {
    public var id: String { accountId }
    public let accountId: String
    public var botId: String?
    public var botName: String?
    public var baseUrl: String
    public var apiKey: String?
    public var model: String?
    public var displayName: String?

    public init(
        accountId: String,
        botId: String? = nil,
        botName: String? = nil,
        baseUrl: String,
        apiKey: String? = nil,
        model: String? = nil,
        displayName: String? = nil
    ) {
        self.accountId = accountId
        self.botId = botId
        self.botName = botName
        self.baseUrl = baseUrl
        self.apiKey = apiKey
        self.model = model
        self.displayName = displayName
    }
}

public struct PairedDesktopInfo: Codable, Equatable, Sendable {
    public var deviceId: String
    public var deviceToken: String
    public var hostName: String
    public var activeHost: String
    public var candidateHosts: [String]
    public var port: Int
    public var fingerprint: String
    public var pairedAtMs: Double
}

public struct PairingPayload: Equatable, Sendable {
    public let version: Int
    public let hosts: [String]
    public let port: Int
    public let token: String
    public let key: String
    public let name: String
    public let fp: String

    public static func parse(_ raw: String) -> PairingPayload? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "botark",
              components.host?.lowercased() == "pair" else {
            return nil
        }
        var map: [String: String] = [:]
        for item in components.queryItems ?? [] {
            if let value = item.value {
                map[item.name] = value
            }
        }
        let hosts = (map["hosts"] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !hosts.isEmpty,
              let port = Int(map["port"] ?? ""),
              port > 0, port <= 65535,
              let token = map["token"], !token.isEmpty,
              let key = map["key"], !key.isEmpty else {
            return nil
        }
        let version = Int(map["v"] ?? "1") ?? 1
        let name = (map["name"]?.isEmpty == false ? map["name"]! : "BotArk Desktop")
        let fp = map["fp"] ?? ""
        return PairingPayload(
            version: version,
            hosts: hosts,
            port: port,
            token: token,
            key: key,
            name: name,
            fp: fp
        )
    }
}

public struct PairApiResponse: Codable, Sendable {
    public let ok: Bool
    public let message: String?
    public let deviceId: String?
    public let deviceToken: String?
    public let hostName: String?
    public let fp: String?
    public let snapshot: WorkspaceSnapshot?
    public let directCredentialsEnc: String?
}

public struct OfflineSyncOuterBundle: Codable, Sendable {
    public let format: String
    public let cipher: String
    public let hostName: String?
    public let fingerprint: String?
    public let exportedAtMs: Double?
    public let payload: String
}

public struct OfflineSyncInnerPayload: Codable, Sendable {
    public let version: Int
    public let exportedAtMs: Double
    public let hostName: String
    public let snapshot: WorkspaceSnapshot
    public let directCredentials: [DirectHermesCredential]?
}

public struct MobileWsEnvelope: Codable, Sendable {
    public let type: String
    public let snapshot: WorkspaceSnapshot?
    public let botId: String?
    public let accountId: String?
    public let messageId: String?
    public let text: String?
    public let tools: [SyncedToolCall]?
    public let media: [SyncedMediaPart]?
    public let message: SyncedMessage?
    public let isTyping: Bool?
    public let status: ConnectionStatus?
    public let detail: String?
    public let pending: [SyncedApproval]?
}
