import Foundation

// The owner protocol's messages, as the server sends them (docs/ARCHITECTURE.md, "Owner
// protocol"). apps/server/tests/fixtures/owner-protocol/ holds an example of each; the unit
// tests decode every one of them. Only the fields the host reads are declared: a field the
// server adds later is ignored rather than refused.

/// The server's `tls` field: the HTTPS listener and the addresses viewers may use.
nonisolated struct TLSReport: Codable, Equatable, Sendable {
  var mode: String
  var active: Bool
  var port: Int?
  var strategy: String?
  var enrolmentStatus: String?
  var fingerprint: String?
  /// The certificate's expiry as an ISO 8601 string, or nil.
  var expiry: String?
  var expired: Bool
  var needsRenewal: Bool
  var httpViewerEnabled: Bool
  var viewerReady: Bool
  var localHttpUrls: [String]
  var viewerUrls: [String]
  var reason: String?

  var expiryDate: Date? {
    guard let expiry else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: expiry) ?? ISO8601DateFormatter().date(from: expiry)
  }
}

nonisolated struct DisplayRow: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var primary: Bool
  var persistent: Bool
  var x: Int
  var y: Int
  var width: Int
  var height: Int
  var rotation: Int
  /// The number Identify shows; only `displays` lines carry it.
  var number: Int?
}

nonisolated struct ProfileData: Codable, Equatable, Sendable, Identifiable {
  var id: String
  var name: String
  var description: String
  var enabled: Bool
  var width: Int
  var height: Int
  var fps: Int
  var bitrateKbps: Int
  var bitrateMode: String
  var quality: String
  var frameDelivery: String
  /// `height`, `width`, `scale` or `fixed` (stream-policy.mjs SIZINGS).
  var sizing: String
  /// For `scale`: the shared screen's size times this, 10 to 400.
  var scalePercent: Int
  /// For `fixed`: `keep` the screen's shape, `fit` with bars, or `stretch`.
  var aspect: String

  /// How the size follows the shared screen, in a few words.
  var sizeText: String {
    switch sizing {
    case "height": "\(height)p, screen's shape"
    case "width": "\(width) wide, screen's shape"
    case "scale": "\(scalePercent)% of the screen"
    default:
      switch aspect {
      case "keep": "Up to \(width) \u{00D7} \(height)"
      case "stretch": "\(width) \u{00D7} \(height), stretched"
      default: "\(width) \u{00D7} \(height) with bars"
      }
    }
  }
}

nonisolated struct Resolution: Codable, Hashable, Sendable {
  var width: Int
  var height: Int
}

nonisolated struct AllowedOptions: Codable, Equatable, Sendable {
  var resolutions: [Resolution]
  var frameRates: [Int]
  var bitratesKbps: [Int]
}

/// The stream policy (stream-policy.mjs). Every field is declared, because `policy-set`
/// replaces the whole policy and the server refuses unknown fields.
nonisolated struct StreamPolicy: Codable, Equatable, Sendable {
  var schemaVersion: Int
  var revision: Int
  var profiles: [ProfileData]
  /// `auto` or a profile id.
  var defaultProfileId: String
  /// Display id to profile id; a display without an entry uses the host default.
  var displayDefaults: [String: String]
  /// Display id to shared or not; nil shares every display.
  var displaySharing: [String: Bool]?
  var allowAudio: Bool
  var videoCodecs: [String]
  var encoderBackend: String
  /// `profiles` or `options`.
  var clientMode: String
  var allowedOptions: AllowedOptions

  // `displaySharing: null` must be written as null, not left out.
  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(schemaVersion, forKey: .schemaVersion)
    try container.encode(revision, forKey: .revision)
    try container.encode(profiles, forKey: .profiles)
    try container.encode(defaultProfileId, forKey: .defaultProfileId)
    try container.encode(displayDefaults, forKey: .displayDefaults)
    if let displaySharing {
      try container.encode(displaySharing, forKey: .displaySharing)
    } else {
      try container.encodeNil(forKey: .displaySharing)
    }
    try container.encode(allowAudio, forKey: .allowAudio)
    try container.encode(videoCodecs, forKey: .videoCodecs)
    try container.encode(encoderBackend, forKey: .encoderBackend)
    try container.encode(clientMode, forKey: .clientMode)
    try container.encode(allowedOptions, forKey: .allowedOptions)
  }
}

/// Access settings (access-settings.mjs).
nonisolated struct AccessSnapshot: Codable, Equatable, Sendable {
  var revision: Int
  /// `approval` or `available`.
  var defaultControl: String
  /// `session-key`, `one-time-keys` or `approved-only`.
  var connectionMode: String
  var maxSessions: Int
  var defaultCodeAlphabet: String
  var publicName: String
  var remoteAccess: Bool
  var publicHostnames: [String]
  var publicPort: Int?
  var mediaPort: Int?
}

nonisolated struct PendingClientRow: Codable, Equatable, Sendable {
  var id: String
  var deviceName: String
  var username: String?
  var client: String?
  var network: String?
  var requestedAt: Double?
}

nonisolated struct ApprovedClientRow: Codable, Equatable, Sendable {
  var id: String
  var deviceName: String
  var username: String?
  var client: String?
  var network: String?
  var connected: Bool
  /// `default`, `approval`, `available` or `view-only` (approved-clients.mjs).
  var permission: String
  var lastConnectedAt: Double?
}

nonisolated struct ClientsStatus: Codable, Equatable, Sendable {
  var pending: [PendingClientRow]
  var approved: [ApprovedClientRow]
}

nonisolated struct EncoderBackendRow: Codable, Equatable, Sendable {
  var id: String
  var label: String
  var codecs: [String]
}

nonisolated struct ReadyMessage: Decodable, Sendable {
  var sharingNotice: String?
  var urls: [String]
  var tls: TLSReport
  var password: String
  var width: Int
  var height: Int
  var displays: [DisplayRow]
  var policy: StreamPolicy
  var access: AccessSnapshot
  var clients: ClientsStatus
  var codecs: [String]
  var backends: [EncoderBackendRow]
  var versions: [String: String]
}

nonisolated struct StabilityRow: Codable, Equatable, Sendable {
  nonisolated struct Generated: Codable, Equatable, Sendable {
    var at: Double
    var captureFps: Double?
    var encodeFps: Double?
  }
  nonisolated struct Point: Codable, Equatable, Sendable {
    var at: Double
    var fps: Double?
  }
  var at: Double
  var stale: Bool
  var serverStale: Bool
  var generated: [Generated]
  var points: [Point]
}

nonisolated struct EncoderInfo: Codable, Equatable, Sendable {
  var backend: String?
  var label: String?
}

nonisolated struct StreamRow: Codable, Equatable, Sendable {
  var id: String?
  var name: String
  var displayId: String?
  var sourceWidth: Int?
  var sourceHeight: Int?
  var profile: String?
  var width: Int?
  var height: Int?
  var fps: Double?
  var targetFps: Double?
  var stability: StabilityRow?
  var state: String?
  var codec: String?
  var encoder: EncoderInfo?
  /// Why keyboard and mouse can't reach this display, or nil when they can.
  var inputUnavailable: String?
}

nonisolated struct SessionRow: Codable, Equatable, Sendable {
  var id: String
  var device: String
  var address: String
  var connectedAt: Double
  var health: String
  /// `Granted` while this session holds keyboard and mouse control.
  var control: String
  var audio: Bool
  var streams: [StreamRow]
}

nonisolated struct RelayStatus: Codable, Equatable, Sendable {
  /// `listening`, `starting` or `unavailable`.
  var state: String
  var port: Int?
  var reason: String?
}

nonisolated struct EncoderStatus: Codable, Equatable, Sendable {
  var available: [EncoderBackendRow]
  var setting: String
}

/// A network the server has seen but the owner has not answered for (`--confirm-networks`).
nonisolated struct PendingNetworkRow: Codable, Equatable, Sendable, Identifiable {
  var id: String
  var subnets: [String]
  var router: String?
  var interface: String?
  /// `wifi`, `ethernet` or another kind the worker reports.
  var kind: String?
  var firstSeenAt: Double?
}

nonisolated struct StatusMessage: Decodable, Sendable {
  var sessions: [SessionRow]
  var streamCount: Int
  var relay: RelayStatus?
  var encoders: EncoderStatus?
  var tls: TLSReport?
  var networks: [PendingNetworkRow]?
}

nonisolated struct DisplaysMessage: Decodable, Sendable {
  var displays: [DisplayRow]
}

/// Every `*-result` reply: `ok`, and on failure `error` (`reason` for tls-regenerate-result).
nonisolated struct OwnerReply: Decodable, Sendable {
  var type: String
  var requestId: String?
  var ok: Bool
  var error: String?
  var reason: String?
  var key: String?
  var expiresAt: Double?
  var alphabet: String?
  var sessionKey: String?
  var disconnected: Int?
  var token: String?
  var url: String?
  var access: AccessSnapshot?
  var policy: StreamPolicy?

  var failure: String? { ok ? nil : (error ?? reason ?? "The server refused the change.") }
}

/// One line from the server's stdout, by its `type`.
nonisolated enum ServerLine: Sendable {
  case ready(ReadyMessage)
  case status(StatusMessage)
  case clients(ClientsStatus)
  case displays([DisplayRow])
  case reply(OwnerReply)
  case other(String)

  private struct Kind: Decodable { var type: String }

  /// Decodes one line. Returns nil for a line that is not a JSON object with a `type`.
  static func decode(_ data: Data) throws -> ServerLine? {
    let decoder = JSONDecoder()
    guard let kind = try? decoder.decode(Kind.self, from: data) else { return nil }
    switch kind.type {
    case "ready": return .ready(try decoder.decode(ReadyMessage.self, from: data))
    case "status": return .status(try decoder.decode(StatusMessage.self, from: data))
    case "clients": return .clients(try decoder.decode(ClientsStatus.self, from: data))
    case "displays": return .displays(try decoder.decode(DisplaysMessage.self, from: data).displays)
    case let type where type.hasSuffix("-result"):
      return .reply(try decoder.decode(OwnerReply.self, from: data))
    default: return .other(kind.type)
    }
  }
}
