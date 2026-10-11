import CoreGraphics
import Foundation

/// Whether the server is sharing, and how it got there.
enum SharingState: Equatable {
  case off
  case starting
  case running
  case stoppedUnexpectedly(reason: String)
}

/// How a new viewer proves it may connect.
enum ConnectionMethod: String, CaseIterable, Identifiable {
  case sessionKey
  case oneTimeKeys
  case approvedOnly

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
      "Anyone with the current key can connect until you change it."
    case .oneTimeKeys:
      "Each key works once. Create a new key for every device you connect."
    case .approvedOnly:
      "Only devices you have approved before can connect. New devices ask you first."
    }
  }
}

/// Whether a viewer gets keyboard and mouse control without asking.
enum ControlDefault: String, CaseIterable, Identifiable {
  case requireApproval
  case allowWhenAvailable

  var id: Self { self }

  var title: String {
    switch self {
    case .requireApproval: "Require host approval"
    case .allowWhenAvailable: "Allow when available"
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
    case .newNetworkConfirmation: "Asks before sharing on a network you have not used before."
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

enum PermissionState {
  case granted
  case needsAttention
  case missing

  var title: String {
    switch self {
    case .granted: "Allowed"
    case .needsAttention: "Waiting"
    case .missing: "Not allowed"
    }
  }
}

enum CertificateState: Equatable {
  case ready(expires: Date)
  case notReady
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
}

struct DisplayInfo: Identifiable, Equatable {
  let id: Int
  var name: String
  var isBuiltIn: Bool
  /// Arrangement frame in points, as the system reports it.
  var frame: CGRect
  var pixelSize: String
  var isShared: Bool
  var profileID: StreamProfile.ID
}

struct StreamProfile: Identifiable, Equatable {
  let id: UUID
  var name: String
  var maxResolution: String
  var frameRate: Int
  var bitrateMbps: Int
  var codec: String
}

struct FPSSample: Identifiable {
  var id: Date { time }
  let time: Date
  let capture: Double?
  let encode: Double?
  let decode: Double?
}

struct StreamStats: Identifiable {
  let id: UUID
  var displayName: String
  var resolution: String
  var codec: String
  var samples: [FPSSample]
}

struct ConnectedClient: Identifiable {
  let id: UUID
  var name: String
  var kind: DeviceKind
  var address: String
  var connectedAt: Date
  var isControlling: Bool
  var isOrdinary: Bool
  var streams: [StreamStats]
}

struct ApprovalRequest: Identifiable {
  let id: UUID
  var name: String
  var kind: DeviceKind
  var address: String
  var requestedAt: Date
}

struct ApprovedClient: Identifiable {
  let id: UUID
  var name: String
  var kind: DeviceKind
  var approvedAt: Date
  var lastSeen: Date?
}

struct NetworkInterface: Identifiable {
  var id: String { name + address }
  var name: String
  var address: String
  var isLinkLocal: Bool
}

struct ConfirmedNetwork: Identifiable {
  let id: UUID
  var name: String
  var confirmedAt: Date
}

/// Something the host wants the person to notice, shown on Overview and in the menu bar.
struct HostIssue: Identifiable, Equatable {
  enum Severity { case warning, error }
  enum Action: Equatable {
    case openPermissions
    case confirmNetwork
    case restart
    case regenerateCertificate
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
struct ConnectionCode {
  var code: String
  var link: String
}

struct VersionInfo: Identifiable {
  var id: String { component }
  var component: String
  var version: String
}
