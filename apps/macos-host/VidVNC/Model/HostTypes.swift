import CoreGraphics
import Foundation

/// Whether the server is sharing, and how it got there.
enum SharingState: Equatable {
  case off
  case starting
  case running
  case stopping
  /// The server exited without being asked, or couldn't start. The reason is shown as is.
  case stoppedUnexpectedly(reason: String)
}

/// How a new viewer proves it may connect (access-settings.mjs `connectionMode`).
enum ConnectionMethod: String, CaseIterable, Identifiable {
  case sessionKey = "session-key"
  case oneTimeKeys = "one-time-keys"
  case approvedOnly = "approved-only"

  var id: Self { self }

  var title: String {
    switch self {
    case .sessionKey: "Reusable session key"
    case .oneTimeKeys: "One-time connection keys"
    case .approvedOnly: "Approved clients only"
    }
  }

  var explanation: String {
    switch self {
    case .sessionKey:
      "Anyone on this network with the current key can connect until you change it."
    case .oneTimeKeys:
      "Each key works once. Create a new key for every device you connect."
    case .approvedOnly:
      "Only devices you have approved before can connect. New devices need a setup code."
    }
  }
}

/// Whether a viewer gets keyboard and mouse control without asking (`defaultControl`).
enum ControlDefault: String, CaseIterable, Identifiable {
  case requireApproval = "approval"
  case allowWhenAvailable = "available"

  var id: Self { self }

  var title: String {
    switch self {
    case .requireApproval: "Require host approval"
    case .allowWhenAvailable: "Allow when available"
    }
  }
}

/// What an approved client may do (approved-clients.mjs `CLIENT_PERMISSIONS`).
enum ClientPermission: String, CaseIterable, Identifiable {
  case `default` = "default"
  case approval
  case available
  case viewOnly = "view-only"

  var id: Self { self }

  var title: String {
    switch self {
    case .default: "Follow Access setting"
    case .approval: "Require host approval"
    case .available: "Allow when available"
    case .viewOnly: "View only"
    }
  }
}

enum PermissionKind: String, CaseIterable, Identifiable {
  case screenRecording
  case deviceControl
  case localNetwork
  case newNetworkConfirmation

  var id: Self { self }

  var title: String {
    switch self {
    case .screenRecording: "Screen & System Audio Recording"
    case .deviceControl: "Device Control & Data Access"
    case .localNetwork: "Local Network"
    case .newNetworkConfirmation: "New network confirmation"
    }
  }

  var detail: String {
    switch self {
    case .screenRecording: "Lets viewers see your screen and hear desktop audio."
    case .deviceControl: "Lets viewers use the keyboard and mouse when you allow it."
    case .localNetwork: "Lets devices on your network find and reach this Mac."
    case .newNetworkConfirmation: "VidVNC asks before sharing on a network you haven't used it on."
    }
  }

  var symbol: String {
    switch self {
    case .screenRecording: "record.circle"
    case .deviceControl: "keyboard"
    case .localNetwork: "network"
    case .newNetworkConfirmation: "wifi"
    }
  }

  /// Privacy & Security pane anchor. Opening a URL never triggers a privacy prompt.
  var settingsURL: URL {
    let anchor =
      switch self {
      case .screenRecording: "Privacy_ScreenCapture"
      case .deviceControl: "Privacy_Accessibility"
      case .localNetwork: "Privacy_LocalNetwork"
      case .newNetworkConfirmation: "Privacy"
      }
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
  }
}

enum PermissionState: Equatable {
  case granted
  case needsAttention
  case missing
  /// macOS hasn't asked yet, or there is no way to read the setting.
  case notDetermined

  var title: String {
    switch self {
    case .granted: "Allowed"
    case .needsAttention: "Waiting"
    case .missing: "Not allowed"
    case .notDetermined: "Not asked yet"
    }
  }
}

/// The HTTPS listener as the Overview and Network sections describe it.
enum HTTPSState: Equatable {
  /// HTTPS is turned off and viewers use local HTTP.
  case off
  case ready(expires: Date?)
  /// Still starting, or failed; the server's reason when it gave one.
  case notReady(reason: String?)
}

enum DeviceKind {
  case iPhone
  case iPad
  case windowsPC
  case mac
  case browser

  var symbol: String {
    switch self {
    case .iPhone: "iphone"
    case .iPad: "ipad"
    case .windowsPC: "pc"
    case .mac: "laptopcomputer"
    case .browser: "globe"
    }
  }

  /// A best guess from what the server knows about a device: its name and its browser.
  init(describing texts: String?...) {
    let text = texts.compactMap(\.self).joined(separator: " ").lowercased()
    if text.contains("ipad") {
      self = .iPad
    } else if text.contains("iphone") || text.contains("ios") {
      self = .iPhone
    } else if text.contains("windows") || text.contains(" pc") {
      self = .windowsPC
    } else if text.contains("mac") {
      self = .mac
    } else {
      self = .browser
    }
  }
}

struct DisplayInfo: Identifiable, Equatable {
  /// The server's display id: SHA-256 of the display's UUID (displays.mm).
  let id: String
  var number: Int
  var name: String
  var isPrimary: Bool
  /// Arrangement frame in points, top-left origin, as `CGDisplayBounds` reports it.
  var frame: CGRect
  var isShared: Bool
  /// The display's own default profile, or nil for the host default.
  var profileID: String?

  var sizeText: String { "\(Int(frame.width)) \u{00D7} \(Int(frame.height))" }
}

typealias StreamProfile = ProfileData

extension StreamProfile {
  /// The profiles a new install starts with, in order; keep in step with `defaultStreamPolicy()`
  /// (stream-policy.mjs) and the profile table (profiles.mjs).
  static let defaults: [StreamProfile] = [
    ("iphone-720p-test", "iPhone 720p", "Conservative starting point for iPhone", 1280, 720, 15, 1000),
    ("mobile", "Mobile", "Compact picture for smaller screens", 1280, 720, 15, 2000),
    ("balanced", "Balanced", "Everyday desktop use", 1920, 1080, 30, 4000),
    ("desktop", "Desktop", "More detail for larger screens", 2560, 1440, 30, 6000),
    ("low-bandwidth", "Low bandwidth", "Lower data use", 960, 540, 15, 1000),
  ].map {
    StreamProfile(
      id: $0.0, name: $0.1, description: $0.2, enabled: true, width: $0.3, height: $0.4, fps: $0.5,
      bitrateKbps: $0.6, bitrateMode: "cbr", quality: "balanced", frameDelivery: "fixed")
  }
}

struct FPSSample: Identifiable {
  var id: Date { time }
  let time: Date
  let capture: Double?
  let encode: Double?
  let decode: Double?
}

struct StreamStats: Identifiable {
  let id: String
  var displayName: String
  var resolution: String
  var codec: String
  var samples: [FPSSample]
  /// Why keyboard and mouse can't reach this display, or nil.
  var inputUnavailable: String?
}

struct ConnectedClient: Identifiable {
  let id: String
  var name: String
  var kind: DeviceKind
  var address: String
  var connectedAt: Date
  var isControlling: Bool
  var health: String
  var streams: [StreamStats]
}

struct ApprovalRequest: Identifiable {
  let id: String
  var name: String
  var kind: DeviceKind
  /// Browser and network, as the server describes them.
  var detail: String
  var requestedAt: Date?
}

struct ApprovedClient: Identifiable {
  let id: String
  var name: String
  var kind: DeviceKind
  var detail: String
  var permission: ClientPermission
  var isConnected: Bool
  var lastSeen: Date?
}

struct NetworkInterface: Identifiable {
  var id: String { bsdName + address }
  var name: String
  var bsdName: String
  var address: String
  var isLinkLocal: Bool
  /// Whether the server listens on this address now.
  var isServed: Bool
}

/// A network the server has seen and is waiting for the owner to allow or refuse.
struct PendingNetwork: Identifiable, Equatable {
  let id: String
  /// "Wi-Fi (en0)".
  var title: String
  /// "192.168.1.0/24".
  var subnets: String
}

/// Something the host wants the person to notice, shown on Overview and in the menu bar.
struct HostIssue: Identifiable, Equatable {
  enum Severity { case warning, error }
  enum Action: Equatable {
    case openPermissions
    case openNetwork
    case confirmNetwork
    case restart
    case reviewApprovals
  }

  let id: String
  var severity: Severity
  var title: String
  var detail: String
  var action: Action?
  var actionTitle: String?
}

/// A connection code handed to a new device.
struct ConnectionCode: Equatable {
  enum Kind { case sessionKey, oneTime, clientSetup }
  var kind: Kind
  var code: String
  var link: String
  var expires: Date?
}

/// An error or refusal to show in an alert.
struct HostAlert: Identifiable, Equatable {
  var id = UUID()
  var title: String
  var message: String
}

struct EncoderChoice: Identifiable, Equatable {
  var id: String
  var label: String
}

struct VersionInfo: Identifiable {
  var id: String { component }
  var component: String
  var version: String
}

/// Video codec ids and their names (video-codecs.mjs).
enum VideoCodec {
  static let all = ["av1", "h265", "h264"]

  static func title(_ id: String) -> String {
    switch id {
    case "h264": "H.264"
    case "h265": "HEVC (H.265)"
    case "av1": "AV1"
    default: id.uppercased()
    }
  }
}
