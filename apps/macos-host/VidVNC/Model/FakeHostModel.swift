import CoreGraphics
import Foundation
import Observation

/// Sample states the Scenario menu switches between.
enum Scenario: String, CaseIterable, Identifiable {
  case sharingOff = "Sharing off"
  case starting = "Starting"
  case localNetwork = "Local network"
  case remoteAccess = "Remote access"
  case controlling = "Someone controlling"
  case httpsNotReady = "HTTPS not ready"
  case noPicture = "No picture or sound"
  case inputUnavailable = "Input unavailable"
  case screenRecordingMissing = "Screen Recording missing"
  case newNetwork = "New network waiting"
  case stoppedUnexpectedly = "Server stopped unexpectedly"
  case approvalRequest = "Approval request"

  var id: Self { self }
}

/// In-memory host with sample data, for previews, screenshots and the Scenario menu (Debug
/// builds, `-scenario "Remote access"`). No server, no network, no privacy prompts.
@Observable
final class FakeHostModel: HostModel {
  let computerName = "Studio Mac"
  let hostname = "studio-mac.local"
  var viewerAddress: String? { sharing == .running ? "https://192.168.1.24:4443" : nil }
  var remoteAddress: String? {
    remoteAccessEnabled ? "https://\(publicNames.first ?? "studio.example.net")" : nil
  }

  private(set) var sharing: SharingState = .running
  private(set) var sharingNotice: String?
  private(set) var remoteAccessEnabled = false
  private(set) var mediaUnavailable: String?
  private(set) var inputUnavailable: String?
  private(set) var https: HTTPSState = .ready(expires: .now.addingTimeInterval(86_400 * 300))
  let tls: TLSReport? = TLSReport(
    mode: "auto", active: true, port: 4443, strategy: "self-signed", enrolmentStatus: "required",
    fingerprint: "SHA256:4F:21:9A:0C:77:E3:5B:12:9D:AA:40:6E:1F:83:C2:5D",
    expiry: "2027-08-07T10:00:00.000Z", expired: false, needsRenewal: false,
    httpViewerEnabled: false, viewerReady: true, localHttpUrls: ["http://192.168.1.24:4382/"],
    viewerUrls: ["https://192.168.1.24:4443/"], reason: nil)
  private(set) var permissions: [PermissionKind: PermissionState] = [:]
  private(set) var pendingNetworks: [PendingNetwork] = []
  var hasSeenPermissionsIntro = true
  var alert: HostAlert?

  var connectionMethod: ConnectionMethod = .sessionKey
  var controlDefault: ControlDefault = .requireApproval
  var maxConnectedDevices = 4
  var publicLoginName = "Studio"
  let accessEditable = true

  private(set) var clients: [ConnectedClient] = []
  private(set) var pendingApprovals: [ApprovalRequest] = []
  private(set) var approvedClients: [ApprovedClient] = []

  let interfaces: [NetworkInterface] = [
    NetworkInterface(name: "Wi-Fi", bsdName: "en0", address: "192.168.1.24", isLinkLocal: false, isServed: true),
    NetworkInterface(
      name: "Thunderbolt Ethernet", bsdName: "en5", address: "10.0.4.17", isLinkLocal: false, isServed: true),
    NetworkInterface(
      name: "Thunderbolt Bridge", bsdName: "bridge0", address: "169.254.12.9", isLinkLocal: true,
      isServed: false),
  ]
  private(set) var publicNames = ["studio.example.net"]
  private(set) var publicPort: Int? = 443
  private(set) var mediaPort: Int?
  let enrolmentAddress: String? = "http://192.168.1.24:4382/trust"

  var policyEditable: Bool { sharing == .running }
  private(set) var policy: StreamPolicy
  private(set) var displays: [DisplayInfo] = []
  var profiles: [StreamProfile] { policy.profiles }
  var defaultProfileID: String { policy.defaultProfileId }
  var desktopAudio: Bool { policy.allowAudio }
  var clientMode: String { policy.clientMode }
  var allowedOptions: AllowedOptions { policy.allowedOptions }
  var encoderBackend: String { policy.encoderBackend }
  let availableEncoders = [
    EncoderChoice(id: "auto", label: "Automatic"),
    EncoderChoice(id: "videotoolbox", label: "Apple VideoToolbox"),
  ]
  var videoCodecs: [String] { policy.videoCodecs }
  let availableCodecs = ["h265", "h264"]

  var openAtLogin = false
  var keepSharingWhenWindowCloses = true
  let versions = [
    VersionInfo(component: "VidVNC", version: "0.10.0 (sample data)"),
    VersionInfo(component: "Server", version: "0.10.0"),
    VersionInfo(component: "Node.js", version: "24.11.0"),
    VersionInfo(component: "GStreamer", version: "1.28.6"),
    VersionInfo(component: "macOS", version: ProcessInfo.processInfo.operatingSystemVersionString),
  ]

  @ObservationIgnored private var ticker: Timer?
  @ObservationIgnored private var startTask: Task<Void, Never>?
  @ObservationIgnored private var tick = 0

  init(scenario: Scenario = .localNetwork) {
    func profile(_ id: String, _ name: String, _ text: String, _ w: Int, _ h: Int, _ fps: Int, _ kbps: Int)
      -> ProfileData
    {
      ProfileData(
        id: id, name: name, description: text, enabled: true, width: w, height: h, fps: fps,
        bitrateKbps: kbps, bitrateMode: "cbr", quality: "balanced", frameDelivery: "fixed")
    }
    policy = StreamPolicy(
      schemaVersion: 1, revision: 3,
      profiles: [
        profile("balanced", "Balanced", "Everyday desktop use", 1920, 1080, 30, 4000),
        profile("desktop", "Desktop", "More detail for larger screens", 2560, 1440, 30, 6000),
        profile("mobile", "Mobile", "Compact picture for smaller screens", 1280, 720, 15, 2000),
      ],
      defaultProfileId: "auto", displayDefaults: ["b".repeated(64): "desktop"], displaySharing: nil,
      allowAudio: true, videoCodecs: ["h265", "h264"], encoderBackend: "auto", clientMode: "profiles",
      allowedOptions: AllowedOptions(
        resolutions: [
          Resolution(width: 1280, height: 720), Resolution(width: 1920, height: 1080),
        ], frameRates: [15, 30], bitratesKbps: [2000, 4000, 6000]))
    let rows: [(String, String, CGRect)] = [
      ("a".repeated(64), "Built-in Retina Display", CGRect(x: 0, y: 0, width: 1512, height: 982)),
      ("b".repeated(64), "Studio Display", CGRect(x: 1512, y: -300, width: 2560, height: 1440)),
    ]
    displays = rows.enumerated().map { index, row in
      DisplayInfo(
        id: row.0, number: index + 1, name: row.1, isPrimary: index == 0, frame: row.2, isShared: true,
        profileID: policy.displayDefaults[row.0])
    }
    apply(scenario)
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.advanceSamples() }
    }
  }

  // MARK: Scenarios

  func apply(_ scenario: Scenario) {
    startTask?.cancel()
    sharing = .running
    sharingNotice = nil
    remoteAccessEnabled = false
    mediaUnavailable = nil
    inputUnavailable = nil
    https = .ready(expires: .now.addingTimeInterval(86_400 * 300))
    permissions = [
      .screenRecording: .granted, .deviceControl: .granted, .localNetwork: .granted,
      .newNetworkConfirmation: .granted,
    ]
    pendingNetworks = []
    connectionMethod = .sessionKey
    clients = Self.sampleClients()
    pendingApprovals = []
    approvedClients = Self.sampleApproved()

    switch scenario {
    case .sharingOff:
      sharing = .off
      clients = []
    case .starting:
      sharing = .starting
      clients = []
    case .localNetwork:
      break
    case .remoteAccess:
      remoteAccessEnabled = true
      connectionMethod = .approvedOnly
    case .controlling:
      clients[0].isControlling = true
    case .httpsNotReady:
      https = .notReady(reason: "HTTPS has not started yet. VidVNC is creating this Mac's certificate.")
    case .noPicture:
      mediaUnavailable = "The media relay couldn't open UDP port 4384: another app is using it."
    case .inputUnavailable:
      inputUnavailable = "VidVNC isn't allowed in Device Control & Data Access."
      permissions[.deviceControl] = .missing
    case .screenRecordingMissing:
      sharing = .off
      clients = []
      permissions[.screenRecording] = .missing
    case .newNetwork:
      pendingNetworks = [PendingNetwork(id: "6361370af95a55dd", title: "Wi-Fi (en0)", subnets: "10.20.0.0/22")]
      permissions[.newNetworkConfirmation] = .needsAttention
    case .stoppedUnexpectedly:
      sharing = .stoppedUnexpectedly(reason: "The server exited with code 3.")
      clients = []
    case .approvalRequest:
      pendingApprovals = [
        ApprovalRequest(
          id: "7e7abb04", name: "Alex's iPad", kind: .iPad, detail: "Safari on iPadOS \u{00B7} Local network",
          requestedAt: .now.addingTimeInterval(-20))
      ]
    }
  }

  private static func sampleClients() -> [ConnectedClient] {
    [
      ConnectedClient(
        id: "iphone", name: "Sam's iPhone", kind: .iPhone, address: "192.168.1.31",
        connectedAt: .now.addingTimeInterval(-12 * 60), isControlling: false, health: "Smooth",
        streams: [sampleStream("Built-in Retina Display", "1280 \u{00D7} 720", "HEVC (H.265)")]),
      ConnectedClient(
        id: "pc", name: "Windows PC", kind: .windowsPC, address: "192.168.1.40",
        connectedAt: .now.addingTimeInterval(-47 * 60), isControlling: false, health: "Smooth",
        streams: [
          sampleStream("Built-in Retina Display", "1920 \u{00D7} 1080", "HEVC (H.265)"),
          sampleStream("Studio Display", "2560 \u{00D7} 1440", "H.264"),
        ]),
    ]
  }

  private static func sampleApproved() -> [ApprovedClient] {
    [
      ApprovedClient(
        id: "64fc7b66", name: "Windows PC", kind: .windowsPC, detail: "Edge on Windows \u{00B7} Local network",
        permission: .default, isConnected: true, lastSeen: .now),
      ApprovedClient(
        id: "8a1d22c0", name: "Work MacBook Air", kind: .mac, detail: "Safari on macOS \u{00B7} Internet",
        permission: .viewOnly, isConnected: false, lastSeen: .now.addingTimeInterval(-86_400 * 2)),
    ]
  }

  private static func sampleStream(_ display: String, _ resolution: String, _ codec: String) -> StreamStats {
    let now = Date()
    let samples = (0..<60).map { i in sample(at: now.addingTimeInterval(Double(i - 59)), step: i) }
    return StreamStats(
      id: UUID().uuidString, displayName: display, resolution: resolution, codec: codec, samples: samples)
  }

  private static func sample(at time: Date, step: Int, mediaAvailable: Bool = true) -> FPSSample {
    guard mediaAvailable else { return FPSSample(time: time, capture: nil, encode: nil, decode: nil) }
    let wobble = sin(Double(step) / 4) * 2
    let capture = 30 + wobble + Double.random(in: -0.5...0.5)
    let encode = capture - Double.random(in: 0...1.5)
    // Leave an occasional gap: missing data is shown as a gap, never as zero.
    let decode: Double? = step % 23 == 0 ? nil : encode - Double.random(in: 0...2.5)
    return FPSSample(time: time, capture: capture, encode: encode, decode: decode)
  }

  private func advanceSamples() {
    tick += 1
    let now = Date()
    for c in clients.indices {
      for s in clients[c].streams.indices {
        clients[c].streams[s].samples.append(
          Self.sample(at: now, step: tick, mediaAvailable: mediaUnavailable == nil))
        clients[c].streams[s].samples.removeAll { $0.time < now.addingTimeInterval(-60) }
      }
    }
  }

  // MARK: Sharing

  func startSharing(remoteAccess: Bool) {
    guard permissions[.screenRecording] == .granted else { return }
    remoteAccessEnabled = remoteAccess
    if remoteAccess { connectionMethod = .approvedOnly }
    sharing = .starting
    startTask?.cancel()
    startTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(1.5))
      guard !Task.isCancelled, let self, self.sharing == .starting else { return }
      self.sharing = .running
    }
  }

  func stopSharing() {
    startTask?.cancel()
    sharing = .off
    clients = []
  }

  func restartServer() { startSharing(remoteAccess: remoteAccessEnabled) }

  func answerNetwork(_ id: PendingNetwork.ID, allow: Bool) {
    pendingNetworks.removeAll { $0.id == id }
    permissions[.newNetworkConfirmation] = .granted
  }

  func requestScreenRecording() -> Bool { permissions[.screenRecording] == .granted }
  func requestDeviceControl() { permissions[.deviceControl] = .granted }
  func requestLocalNetwork() { permissions[.localNetwork] = .granted }
  func refreshPermissions() {}

  func makeConnectionCode(_ kind: ConnectionCode.Kind) async throws -> ConnectionCode {
    let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
    let code = (0..<2).map { _ in String((0..<4).map { _ in alphabet.randomElement()! }) }
      .joined(separator: "-")
    return ConnectionCode(
      kind: kind, code: code, link: "\(viewerAddress ?? "")/#key=\(code)",
      expires: kind == .sessionKey ? nil : .now.addingTimeInterval(300))
  }

  func newSessionKey() async throws -> ConnectionCode { try await makeConnectionCode(.sessionKey) }

  // MARK: Clients

  func approve(_ id: ApprovalRequest.ID) {
    guard let i = pendingApprovals.firstIndex(where: { $0.id == id }) else { return }
    let request = pendingApprovals.remove(at: i)
    approvedClients.append(
      ApprovedClient(
        id: request.id, name: request.name, kind: request.kind, detail: request.detail, permission: .default,
        isConnected: true, lastSeen: .now))
  }

  func reject(_ id: ApprovalRequest.ID) { pendingApprovals.removeAll { $0.id == id } }
  func removeApproved(_ id: ApprovedClient.ID) { approvedClients.removeAll { $0.id == id } }

  func setPermission(_ permission: ClientPermission, for id: ApprovedClient.ID) {
    guard let i = approvedClients.firstIndex(where: { $0.id == id }) else { return }
    approvedClients[i].permission = permission
  }

  func disconnect(_ id: ConnectedClient.ID) { clients.removeAll { $0.id == id } }
  func disconnectOrdinarySessions() { clients.removeAll() }

  func grantControl(_ id: ConnectedClient.ID) {
    for i in clients.indices { clients[i].isControlling = clients[i].id == id }
  }

  func revokeControl(_ id: ConnectedClient.ID) {
    for i in clients.indices where clients[i].id == id { clients[i].isControlling = false }
  }

  func openDiagnostics() {}

  // MARK: Network

  func setRemoteAccess(_ enabled: Bool) {
    remoteAccessEnabled = enabled
    if enabled { connectionMethod = .approvedOnly }
  }

  func saveRemoteSettings(publicNames: [String], publicPort: Int?, mediaPort: Int?) async throws {
    self.publicNames = publicNames
    self.publicPort = publicPort
    self.mediaPort = mediaPort
  }

  func regenerateCertificate() {
    https = .notReady(reason: "Creating a new certificate\u{2026}")
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(1))
      self?.https = .ready(expires: .now.addingTimeInterval(86_400 * 397))
    }
  }

  // MARK: Streaming

  func updatePolicy(_ change: @escaping (inout StreamPolicy) -> Void) {
    change(&policy)
    policy.revision += 1
    for i in displays.indices {
      displays[i].isShared = policy.displaySharing?[displays[i].id] ?? true
      displays[i].profileID = policy.displayDefaults[displays[i].id]
    }
  }
}

extension String {
  fileprivate func repeated(_ count: Int) -> String { String(repeating: self, count: count) }
}
