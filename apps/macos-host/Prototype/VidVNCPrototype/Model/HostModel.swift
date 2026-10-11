import Foundation
import Observation

/// Everything the host UI reads and does. Views only see this protocol: the prototype
/// supplies `FakeHostModel`, and the real app will supply a server-backed model.
@MainActor
protocol HostModel: AnyObject, Observable {
  // MARK: Identity and addresses

  var computerName: String { get }
  var hostname: String { get }
  var viewerAddress: String { get }
  var remoteAddress: String? { get }

  // MARK: Sharing

  var sharing: SharingState { get }
  var remoteAccessEnabled: Bool { get }
  var mediaAvailable: Bool { get }
  var inputAvailable: Bool { get }
  var certificate: CertificateState { get }
  var permissions: [PermissionKind: PermissionState] { get }
  /// A network the host has joined but not been told to share on.
  var pendingNetwork: String? { get }
  /// The network the host is on now.
  var currentNetwork: String { get }
  var hasSeenPermissionsIntro: Bool { get set }

  func startSharing(remoteAccess: Bool)
  func stopSharing()
  func restartServer()
  func confirmPendingNetwork()

  // MARK: Access

  var connectionMethod: ConnectionMethod { get set }
  var controlDefault: ControlDefault { get set }
  var maxConnectedDevices: Int { get set }
  var publicLoginName: String { get set }

  func makeConnectionCode(for method: ConnectionMethod) -> ConnectionCode

  // MARK: Clients

  var clients: [ConnectedClient] { get }
  var pendingApprovals: [ApprovalRequest] { get }
  var approvedClients: [ApprovedClient] { get }

  func approve(_ id: ApprovalRequest.ID)
  func reject(_ id: ApprovalRequest.ID)
  func removeApproved(_ id: ApprovedClient.ID)
  func disconnect(_ id: ConnectedClient.ID)
  func disconnectOrdinarySessions()
  func grantControl(_ id: ConnectedClient.ID)

  // MARK: Network

  var interfaces: [NetworkInterface] { get }
  var confirmedNetworks: [ConfirmedNetwork] { get }
  var publicNames: [String] { get set }
  var httpsPort: Int { get set }
  var mediaPort: Int { get set }

  func setRemoteAccess(_ enabled: Bool)
  func forgetNetwork(_ id: ConfirmedNetwork.ID)
  func regenerateCertificate()

  // MARK: Displays and streaming

  var displays: [DisplayInfo] { get set }
  var profiles: [StreamProfile] { get set }
  var defaultProfileID: StreamProfile.ID { get set }
  var desktopAudio: Bool { get set }
  var allowViewerResolutionChoice: Bool { get set }
  var allowViewerFrameRateChoice: Bool { get set }
  var encoder: String { get set }
  var availableEncoders: [String] { get }
  var enabledCodecs: Set<String> { get set }
  var availableCodecs: [String] { get }

  // MARK: App settings

  var openAtLogin: Bool { get set }
  var keepSharingWhenWindowCloses: Bool { get set }
  var versions: [VersionInfo] { get }
}

extension HostModel {
  var isSharing: Bool {
    switch sharing {
    case .running, .starting: true
    default: false
    }
  }

  var controllingClient: ConnectedClient? { clients.first(where: \.isControlling) }

  var defaultProfile: StreamProfile? { profiles.first { $0.id == defaultProfileID } }

  /// Problems in the order they matter most. Overview, the sidebar footer and the menu bar
  /// all show the first one.
  var issues: [HostIssue] {
    var result: [HostIssue] = []
    if case .stoppedUnexpectedly(let reason) = sharing {
      result.append(
        HostIssue(
          id: "stopped", severity: .error, title: "Stopped unexpectedly", detail: reason,
          action: .restart, actionTitle: "Restart"))
    }
    if permissions[.screenRecording] == .missing {
      result.append(
        HostIssue(
          id: "screen", severity: .error, title: "Screen Recording not allowed",
          detail: "Viewers can't see this Mac until you allow Screen & System Audio Recording.",
          action: .openPermissions, actionTitle: "Review Permissions"))
    }
    if let network = pendingNetwork {
      result.append(
        HostIssue(
          id: "network", severity: .warning, title: "Waiting for a new network",
          detail: "Sharing is paused until you confirm \u{201C}\(network)\u{201D}.",
          action: .confirmNetwork, actionTitle: "Review\u{2026}"))
    }
    if isSharing, certificate == .notReady {
      result.append(
        HostIssue(
          id: "https", severity: .warning, title: "HTTPS isn't ready",
          detail: "Browsers will warn until the certificate is ready.",
          action: .regenerateCertificate, actionTitle: "Regenerate"))
    }
    if isSharing, !mediaAvailable {
      result.append(
        HostIssue(
          id: "media", severity: .warning, title: "No picture or sound",
          detail: "The capture helper isn't responding. Viewers see a black screen."))
    }
    if isSharing, !inputAvailable {
      result.append(
        HostIssue(
          id: "input", severity: .warning, title: "Remote control unavailable",
          detail: "Viewers can watch, but keyboard and mouse input isn't available.",
          action: .openPermissions, actionTitle: "Review Permissions"))
    }
    if !pendingApprovals.isEmpty {
      let count = pendingApprovals.count
      result.append(
        HostIssue(
          id: "approval", severity: .warning,
          title: count == 1 ? "A device is waiting for approval" : "\(count) devices are waiting for approval",
          detail: pendingApprovals.map(\.name).joined(separator: ", "),
          action: .reviewApprovals, actionTitle: "Review"))
    }
    return result
  }
}
