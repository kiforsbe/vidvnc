import Foundation
import Observation

/// Everything the host UI reads and does. Views only see this protocol: `ServerHostModel`
/// supplies it from the server, and `FakeHostModel` from sample data for previews,
/// screenshots and the Scenario menu.
///
/// Settings properties apply when set, as macOS settings do: the model sends the change and,
/// if the server refuses it, sets `alert` and shows the server's value again.
@MainActor
protocol HostModel: AnyObject, Observable {
  // MARK: Identity and addresses

  var computerName: String { get }
  var hostname: String { get }
  /// The address viewers open, when the server has one ready.
  var viewerAddress: String? { get }
  var remoteAddress: String? { get }

  // MARK: Sharing

  var sharing: SharingState { get }
  /// What the server said when remote access couldn't start as asked.
  var sharingNotice: String? { get }
  var remoteAccessEnabled: Bool { get }
  /// Why viewers get no picture or sound, or nil.
  var mediaUnavailable: String? { get }
  /// Why keyboard and mouse don't reach this Mac, or nil.
  var inputUnavailable: String? { get }
  var https: HTTPSState { get }
  var tls: TLSReport? { get }
  var permissions: [PermissionKind: PermissionState] { get }
  var pendingNetworks: [PendingNetwork] { get }
  var hasSeenPermissionsIntro: Bool { get set }
  var alert: HostAlert? { get set }

  func startSharing(remoteAccess: Bool)
  func stopSharing()
  func restartServer()
  func answerNetwork(_ id: PendingNetwork.ID, allow: Bool)

  // MARK: Permissions

  /// Asks macOS for Screen Recording if it hasn't been asked, and says whether it is allowed.
  func requestScreenRecording() -> Bool
  /// Asks macOS to add VidVNC to Device Control & Data Access.
  func requestDeviceControl()
  /// Triggers the Local Network question by looking for VidVNC on the network.
  func requestLocalNetwork()
  func refreshPermissions()

  // MARK: Access

  var connectionMethod: ConnectionMethod { get set }
  var controlDefault: ControlDefault { get set }
  var maxConnectedDevices: Int { get set }
  var publicLoginName: String { get set }
  /// False while the settings are loading or a change is on its way.
  var accessEditable: Bool { get }

  func makeConnectionCode(_ kind: ConnectionCode.Kind) async throws -> ConnectionCode
  func newSessionKey() async throws -> ConnectionCode

  // MARK: Clients

  var clients: [ConnectedClient] { get }
  var pendingApprovals: [ApprovalRequest] { get }
  var approvedClients: [ApprovedClient] { get }

  func approve(_ id: ApprovalRequest.ID)
  func reject(_ id: ApprovalRequest.ID)
  func removeApproved(_ id: ApprovedClient.ID)
  func setPermission(_ permission: ClientPermission, for id: ApprovedClient.ID)
  func disconnect(_ id: ConnectedClient.ID)
  func disconnectOrdinarySessions()
  func grantControl(_ id: ConnectedClient.ID)
  func revokeControl(_ id: ConnectedClient.ID)
  func openDiagnostics()

  // MARK: Network

  var interfaces: [NetworkInterface] { get }
  var publicNames: [String] { get }
  var publicPort: Int? { get }
  var mediaPort: Int? { get }
  /// The enrolment page a device opens to trust this Mac's certificate.
  var enrolmentAddress: String? { get }

  func setRemoteAccess(_ enabled: Bool)
  func saveRemoteSettings(publicNames: [String], publicPort: Int?, mediaPort: Int?) async throws
  func regenerateCertificate()

  // MARK: Displays and streaming

  /// False while sharing is off: the policy is changed through the running server.
  var policyEditable: Bool { get }
  var displays: [DisplayInfo] { get }
  var profiles: [StreamProfile] { get }
  /// `auto` or a profile id.
  var defaultProfileID: String { get }
  var desktopAudio: Bool { get }
  var clientMode: String { get }
  var allowedOptions: AllowedOptions { get }
  var encoderBackend: String { get }
  var availableEncoders: [EncoderChoice] { get }
  /// Enabled codecs, in the order the host offers them.
  var videoCodecs: [String] { get }
  var availableCodecs: [String] { get }

  /// Changes the stream policy. Connected devices restart their streams when it applies.
  func updatePolicy(_ change: @escaping (inout StreamPolicy) -> Void)

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

  func profileName(_ id: String?) -> String {
    guard let id, id != "auto" else { return "Automatic" }
    return profiles.first { $0.id == id }?.name ?? id
  }

  /// Problems in the order they matter most. Overview, the sidebar footer and the menu bar
  /// all show the first one.
  var issues: [HostIssue] {
    var result: [HostIssue] = []
    if case .stoppedUnexpectedly(let reason) = sharing {
      result.append(
        HostIssue(
          id: "stopped", severity: .error, title: "Sharing stopped unexpectedly", detail: reason,
          action: .restart, actionTitle: "Start Again"))
    }
    if permissions[.screenRecording] == .missing {
      result.append(
        HostIssue(
          id: "screen", severity: .error, title: "Screen Recording not allowed",
          detail:
            "Viewers can't see this Mac until you allow VidVNC in Screen & System Audio Recording.",
          action: .openPermissions, actionTitle: "Review Permissions"))
    }
    if let network = pendingNetworks.first {
      result.append(
        HostIssue(
          id: "network", severity: .warning, title: "A new network is waiting",
          detail: "VidVNC doesn't listen on \(network.title) (\(network.subnets)) until you allow it.",
          action: .confirmNetwork, actionTitle: "Review\u{2026}"))
    }
    if let notice = sharingNotice, sharing == .running {
      result.append(
        HostIssue(
          id: "notice", severity: .warning, title: "Remote access is off", detail: notice,
          action: .openNetwork, actionTitle: "Network Settings"))
    }
    if sharing == .running, case .notReady(let reason) = https {
      result.append(
        HostIssue(
          id: "https", severity: .warning, title: "HTTPS isn't ready",
          detail: reason ?? "Viewers can connect once the certificate is ready.",
          action: .openNetwork, actionTitle: "Network Settings"))
    }
    if sharing == .running, let reason = mediaUnavailable {
      result.append(
        HostIssue(id: "media", severity: .error, title: "No picture or sound", detail: reason))
    }
    if sharing == .running, let reason = inputUnavailable {
      result.append(
        HostIssue(
          id: "input", severity: .warning, title: "Remote control unavailable",
          detail: "Viewers can watch, but keyboard and mouse don't reach this Mac. \(reason)",
          action: .openPermissions, actionTitle: "Review Permissions"))
    }
    if !pendingApprovals.isEmpty {
      let count = pendingApprovals.count
      result.append(
        HostIssue(
          id: "approval", severity: .warning,
          title: count == 1
            ? "A device is waiting for approval" : "\(count) devices are waiting for approval",
          detail: pendingApprovals.map(\.name).joined(separator: ", "),
          action: .reviewApprovals, actionTitle: "Review"))
    }
    return result
  }
}
