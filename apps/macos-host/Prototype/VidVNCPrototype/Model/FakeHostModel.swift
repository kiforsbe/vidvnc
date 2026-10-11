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

/// In-memory host with sample data. No server, no network, no privacy prompts.
@Observable
final class FakeHostModel: HostModel {
  let computerName = "Studio Mac"
  let hostname = "studio-mac.local"
  let viewerAddress = "https://192.168.1.24:8443"
  var remoteAddress: String? {
    remoteAccessEnabled ? "https://\(publicNames.first ?? "studio.example.net"):\(httpsPort)" : nil
  }

  private(set) var sharing: SharingState = .running
  private(set) var remoteAccessEnabled = false
  private(set) var mediaAvailable = true
  private(set) var inputAvailable = true
  private(set) var certificate: CertificateState = .ready(
    expires: Date().addingTimeInterval(86_400 * 300))
  private(set) var permissions: [PermissionKind: PermissionState] = [
    .screenRecording: .granted, .deviceControl: .granted, .localNetwork: .granted,
    .newNetworkConfirmation: .granted,
  ]
  private(set) var pendingNetwork: String?
  var currentNetwork = "Studio Wi-Fi"
  var hasSeenPermissionsIntro = true

  var connectionMethod: ConnectionMethod = .sessionKey
  var controlDefault: ControlDefault = .requireApproval
  var maxConnectedDevices = 4
  var publicLoginName = "studio"

  private(set) var clients: [ConnectedClient] = []
  private(set) var pendingApprovals: [ApprovalRequest] = []
  private(set) var approvedClients: [ApprovedClient] = []

  let interfaces: [NetworkInterface] = [
    NetworkInterface(name: "Wi-Fi (en0)", address: "192.168.1.24", isLinkLocal: false),
    NetworkInterface(name: "Thunderbolt Ethernet (en5)", address: "10.0.4.17", isLinkLocal: false),
    NetworkInterface(name: "Thunderbolt Bridge (bridge0)", address: "169.254.12.9", isLinkLocal: true),
  ]
  private(set) var confirmedNetworks: [ConfirmedNetwork] = [
    ConfirmedNetwork(id: UUID(), name: "Studio Wi-Fi", confirmedAt: .now.addingTimeInterval(-86_400 * 40)),
    ConfirmedNetwork(id: UUID(), name: "Office LAN", confirmedAt: .now.addingTimeInterval(-86_400 * 12)),
  ]
  var publicNames = ["studio.example.net"]
  var httpsPort = 8443
  var mediaPort = 4384

  var displays: [DisplayInfo]
  var profiles: [StreamProfile]
  var defaultProfileID: StreamProfile.ID
  var desktopAudio = true
  var allowViewerResolutionChoice = true
  var allowViewerFrameRateChoice = false
  var encoder = "Automatic (VideoToolbox)"
  let availableEncoders = ["Automatic (VideoToolbox)", "VideoToolbox (hardware)", "Software"]
  var enabledCodecs: Set<String> = ["H.264", "HEVC"]
  let availableCodecs = ["H.264", "HEVC", "AV1"]

  var openAtLogin = false
  var keepSharingWhenWindowCloses = true
  let versions = [
    VersionInfo(component: "VidVNC", version: "0.10.0 (prototype)"),
    VersionInfo(component: "Server", version: "0.10.0"),
    VersionInfo(component: "Capture helper", version: "0.10.0"),
    VersionInfo(component: "macOS", version: ProcessInfo.processInfo.operatingSystemVersionString),
  ]

  @ObservationIgnored private var ticker: Timer?
  @ObservationIgnored private var startTask: Task<Void, Never>?
  @ObservationIgnored private var tick = 0

  init(scenario: Scenario = .localNetwork) {
    let balanced = StreamProfile(
      id: UUID(), name: "Balanced", maxResolution: "1920 × 1080", frameRate: 30, bitrateMbps: 8,
      codec: "H.264")
    let sharp = StreamProfile(
      id: UUID(), name: "Sharp Text", maxResolution: "Native", frameRate: 30, bitrateMbps: 20,
      codec: "HEVC")
    let smooth = StreamProfile(
      id: UUID(), name: "Smooth Motion", maxResolution: "1920 × 1080", frameRate: 60,
      bitrateMbps: 15, codec: "HEVC")
    profiles = [balanced, sharp, smooth]
    defaultProfileID = balanced.id
    displays = [
      DisplayInfo(
        id: 1, name: "Built-in Retina Display", isBuiltIn: true,
        frame: CGRect(x: 0, y: 0, width: 1512, height: 982), pixelSize: "3024 × 1964",
        isShared: true, profileID: sharp.id),
      DisplayInfo(
        id: 2, name: "Studio Display", isBuiltIn: false,
        frame: CGRect(x: 1512, y: -300, width: 2560, height: 1440), pixelSize: "5120 × 2880",
        isShared: true, profileID: balanced.id),
    ]
    apply(scenario)
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.advanceSamples() }
    }
  }

  // MARK: Scenarios

  func apply(_ scenario: Scenario) {
    startTask?.cancel()
    sharing = .running
    remoteAccessEnabled = false
    mediaAvailable = true
    inputAvailable = true
    certificate = .ready(expires: .now.addingTimeInterval(86_400 * 300))
    for kind in PermissionKind.allCases { permissions[kind] = .granted }
    pendingNetwork = nil
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
      certificate = .notReady
    case .noPicture:
      mediaAvailable = false
    case .inputUnavailable:
      inputAvailable = false
      permissions[.deviceControl] = .needsAttention
    case .screenRecordingMissing:
      sharing = .off
      clients = []
      permissions[.screenRecording] = .missing
    case .newNetwork:
      sharing = .off
      clients = []
      pendingNetwork = "Café Guest"
      permissions[.newNetworkConfirmation] = .needsAttention
    case .stoppedUnexpectedly:
      sharing = .stoppedUnexpectedly(reason: "The server exited with code 3 at 09:41.")
      clients = []
    case .approvalRequest:
      pendingApprovals = [
        ApprovalRequest(
          id: UUID(), name: "Alex's iPad", kind: .iPad, address: "192.168.1.52",
          requestedAt: .now.addingTimeInterval(-20))
      ]
    }
  }

  private static func sampleClients() -> [ConnectedClient] {
    [
      ConnectedClient(
        id: UUID(), name: "iPhone", kind: .iPhone, address: "192.168.1.31",
        connectedAt: .now.addingTimeInterval(-12 * 60), isControlling: false, isOrdinary: true,
        streams: [sampleStream("Built-in Retina Display", "1512 × 982", "HEVC")]),
      ConnectedClient(
        id: UUID(), name: "Windows PC", kind: .windowsPC, address: "192.168.1.40",
        connectedAt: .now.addingTimeInterval(-47 * 60), isControlling: false, isOrdinary: true,
        streams: [
          sampleStream("Built-in Retina Display", "3024 × 1964", "HEVC"),
          sampleStream("Studio Display", "1920 × 1080", "H.264"),
        ]),
    ]
  }

  private static func sampleApproved() -> [ApprovedClient] {
    [
      ApprovedClient(
        id: UUID(), name: "Windows PC", kind: .windowsPC,
        approvedAt: .now.addingTimeInterval(-86_400 * 9), lastSeen: .now),
      ApprovedClient(
        id: UUID(), name: "Work MacBook Air", kind: .mac,
        approvedAt: .now.addingTimeInterval(-86_400 * 30),
        lastSeen: .now.addingTimeInterval(-86_400 * 2)),
    ]
  }

  private static func sampleStream(_ display: String, _ resolution: String, _ codec: String)
    -> StreamStats
  {
    let now = Date()
    let samples = (0..<60).map { i in
      sample(at: now.addingTimeInterval(Double(i - 59)), step: i)
    }
    return StreamStats(
      id: UUID(), displayName: display, resolution: resolution, codec: codec, samples: samples)
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
          Self.sample(at: now, step: tick, mediaAvailable: mediaAvailable))
        let cutoff = now.addingTimeInterval(-60)
        clients[c].streams[s].samples.removeAll { $0.time < cutoff }
      }
    }
  }

  // MARK: Sharing

  func startSharing(remoteAccess: Bool) {
    guard pendingNetwork == nil else { return }
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

  func confirmPendingNetwork() {
    guard let name = pendingNetwork else { return }
    confirmedNetworks.append(ConfirmedNetwork(id: UUID(), name: name, confirmedAt: .now))
    currentNetwork = name
    pendingNetwork = nil
    permissions[.newNetworkConfirmation] = .granted
  }

  func makeConnectionCode(for method: ConnectionMethod) -> ConnectionCode {
    let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
    let code = (0..<3).map { _ in String((0..<4).map { _ in alphabet.randomElement()! }) }
      .joined(separator: "-")
    let kind =
      switch method {
      case .sessionKey: "key"
      case .oneTimeKeys: "once"
      case .approvedOnly: "pair"
      }
    return ConnectionCode(code: code, link: "\(viewerAddress)/#\(kind)=\(code)")
  }

  // MARK: Clients

  func approve(_ id: ApprovalRequest.ID) {
    guard let i = pendingApprovals.firstIndex(where: { $0.id == id }) else { return }
    let request = pendingApprovals.remove(at: i)
    approvedClients.append(
      ApprovedClient(
        id: UUID(), name: request.name, kind: request.kind, approvedAt: .now, lastSeen: .now))
    if isSharing {
      clients.append(
        ConnectedClient(
          id: UUID(), name: request.name, kind: request.kind, address: request.address,
          connectedAt: .now, isControlling: false, isOrdinary: true,
          streams: [Self.sampleStream("Built-in Retina Display", "1180 × 820", "HEVC")]))
    }
  }

  func reject(_ id: ApprovalRequest.ID) { pendingApprovals.removeAll { $0.id == id } }

  func removeApproved(_ id: ApprovedClient.ID) { approvedClients.removeAll { $0.id == id } }

  func disconnect(_ id: ConnectedClient.ID) { clients.removeAll { $0.id == id } }

  func disconnectOrdinarySessions() { clients.removeAll(where: \.isOrdinary) }

  func grantControl(_ id: ConnectedClient.ID) {
    for i in clients.indices { clients[i].isControlling = clients[i].id == id }
  }

  // MARK: Network

  func setRemoteAccess(_ enabled: Bool) {
    remoteAccessEnabled = enabled
    if enabled { connectionMethod = .approvedOnly }
  }

  func forgetNetwork(_ id: ConfirmedNetwork.ID) { confirmedNetworks.removeAll { $0.id == id } }

  func regenerateCertificate() {
    certificate = .notReady
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(1))
      self?.certificate = .ready(expires: .now.addingTimeInterval(86_400 * 397))
    }
  }
}
