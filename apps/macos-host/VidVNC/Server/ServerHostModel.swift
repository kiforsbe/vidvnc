import AppKit
import Foundation
import Observation
import os
import SystemConfiguration
import UserNotifications

/// The host model backed by the real server, spoken to over the owner protocol.
///
/// The server is started with `--desktop --await-owner --confirm-networks` and reads one
/// approval line before it opens any port. After `ready`, settings changes are owner
/// commands; while sharing is off they go through the offline `config` command instead, as on
/// Windows. Every reply carries the server's current settings, which replace the local copy.
@Observable
final class ServerHostModel: HostModel {
  @ObservationIgnored private let log = Logger(subsystem: "io.github.kiforsbe.vidvnc", category: "server")
  // MARK: State from the server

  private(set) var sharing: SharingState = .off
  private(set) var sharingNotice: String?
  private var requestedRemote = false
  private var password: String?
  private var tlsReport: TLSReport?
  private var access: AccessSnapshot?
  private var policy: StreamPolicy?
  private var displayRows: [DisplayRow] = LocalDisplays.current()
  private var sessions: [SessionRow] = []
  private var clientsStatus = ClientsStatus(pending: [], approved: [])
  private var relay: RelayStatus?
  private var encoders: EncoderStatus?
  private var backends: [EncoderBackendRow] = []
  private var hostCodecs: [String] = []
  private var serverVersions: [String: String] = [:]
  private var networkRows: [PendingNetworkRow] = []
  private var accessSaving = false
  private var offlineLoaded = false

  // MARK: Local state

  private(set) var permissions: [PermissionKind: PermissionState] = [:]
  var alert: HostAlert?
  private(set) var interfaces: [NetworkInterface] = []

  @ObservationIgnored private var process: ServerProcess?
  @ObservationIgnored private var stopRequested = false
  @ObservationIgnored private var replies: [String: CheckedContinuation<OwnerReply, any Error>] = [:]
  @ObservationIgnored private var tlsReply: CheckedContinuation<OwnerReply, any Error>?
  @ObservationIgnored private var exitWaiters: [CheckedContinuation<Void, Never>] = []
  @ObservationIgnored private var poller: Timer?
  @ObservationIgnored private let localNetwork = LocalNetworkProbe()
  @ObservationIgnored private var localNetworkState: PermissionState = .notDetermined
  @ObservationIgnored private var notifiedApprovals: Set<String> = []
  @ObservationIgnored private let defaults = UserDefaults.standard

  enum Failure: LocalizedError {
    case notSharing
    case noReply

    var errorDescription: String? {
      switch self {
      case .notSharing: "Start sharing first."
      case .noReply: "The server didn't answer."
      }
    }
  }

  init() {
    defaults.register(defaults: ["keepSharingWhenWindowCloses": true])
    hasSeenPermissionsIntro = defaults.bool(forKey: "hasSeenPermissionsIntro")
    keepSharingWhenWindowCloses = defaults.bool(forKey: "keepSharingWhenWindowCloses")
    if defaults.bool(forKey: "askedLocalNetwork") { localNetworkState = .needsAttention }
    refreshPermissions()
    refreshInterfaces()
    // Permissions, displays and addresses change in System Settings while VidVNC runs.
    poller = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.refreshPermissions()
        self?.refreshInterfaces()
        if self?.process == nil { self?.displayRows = LocalDisplays.current() }
      }
    }
    Task { await loadOfflineSettings() }
    #if DEBUG
      // `-startSharing YES`: the process-tree test starts sharing without clicking.
      if defaults.bool(forKey: "startSharing") { startSharing(remoteAccess: false) }
    #endif
  }

  // MARK: Identity and addresses

  var computerName: String {
    SCDynamicStoreCopyComputerName(nil, nil) as String? ?? "This Mac"
  }

  var hostname: String {
    (SCDynamicStoreCopyLocalHostName(nil) as String?).map { "\($0).local" }
      ?? ProcessInfo.processInfo.hostName
  }

  var viewerAddress: String? {
    guard sharing == .running, let tls = tlsReport, tls.viewerReady else { return nil }
    return Self.origin(tls.viewerUrls, scheme: "https") ?? Self.origin(tls.viewerUrls, scheme: "http")
  }

  var remoteAddress: String? {
    guard remoteAccessEnabled, let name = access?.publicHostnames.first else { return nil }
    let port = access?.publicPort ?? tlsReport?.port
    return "https://\(name)" + (port.map { $0 == 443 ? "" : ":\($0)" } ?? "")
  }

  var enrolmentAddress: String? {
    guard let tls = tlsReport, let root = Self.origin(tls.localHttpUrls, scheme: "http") else {
      return nil
    }
    return root + "/trust"
  }

  /// The first address in `urls` with `scheme` and a non-loopback host, as scheme://host:port.
  static func origin(_ urls: [String], scheme: String) -> String? {
    for text in urls {
      guard let url = URL(string: text), url.scheme == scheme, let host = url.host(),
        host != "127.0.0.1", host != "::1", host != "localhost"
      else { continue }
      var components = URLComponents()
      components.scheme = scheme
      components.host = host
      components.port = url.port
      if let origin = components.string { return origin }
    }
    return nil
  }

  // MARK: Sharing

  var remoteAccessEnabled: Bool { sharing == .running && access?.remoteAccess == true }

  var mediaUnavailable: String? {
    guard let relay, relay.state == "unavailable" else { return nil }
    return relay.reason ?? "The media relay isn't running."
  }

  var inputUnavailable: String? {
    sessions.lazy.flatMap(\.streams).compactMap(\.inputUnavailable).first
  }

  var https: HTTPSState {
    guard let tls = tlsReport else { return .notReady(reason: nil) }
    if tls.mode == "off" { return .off }
    if tls.active, tls.reason == nil { return .ready(expires: tls.expiryDate) }
    return .notReady(reason: tls.reason)
  }

  var tls: TLSReport? { tlsReport }

  var pendingNetworks: [PendingNetwork] {
    networkRows.map { row in
      let port = NetworkInterfaces.displayName(row.interface) ?? row.kind.map(Self.kindName) ?? "Network"
      let title = row.interface.map { "\(port) (\($0))" } ?? port
      return PendingNetwork(id: row.id, title: title, subnets: row.subnets.joined(separator: ", "))
    }
  }

  private static func kindName(_ kind: String) -> String {
    switch kind {
    case "wifi": "Wi-Fi"
    case "ethernet": "Ethernet"
    default: kind.capitalized
    }
  }

  var hasSeenPermissionsIntro: Bool {
    didSet { defaults.set(hasSeenPermissionsIntro, forKey: "hasSeenPermissionsIntro") }
  }

  func startSharing(remoteAccess: Bool) {
    switch sharing {
    case .off, .stoppedUnexpectedly: break
    default: return
    }
    guard Privacy.screenRecordingAllowed else {
      refreshPermissions()
      return
    }
    requestedRemote = remoteAccess
    sharingNotice = nil
    stopRequested = false
    sharing = .starting
    do {
      guard let filename = RuntimeManifest.defaultFilename() else {
        throw RuntimeManifest.Failure.invalid(
          "VidVNC can't find its runtime. Run npm run prepare:host, or set VIDVNC_RUNTIME_MANIFEST.")
      }
      let manifest = try RuntimeManifest.load(filename)
      let launch = try manifest.serverLaunch(
        extraArguments: ["--await-owner", "--confirm-networks"],
        inspect: ProcessInfo.processInfo.environment["VIDVNC_INSPECT"] == "1")
      let process = try ServerProcess.start(
        launch,
        onLine: { [weak self] line in
          DispatchQueue.main.async { MainActor.assumeIsolated { self?.receive(line) } }
        },
        onExit: { [weak self] exit in
          DispatchQueue.main.async { MainActor.assumeIsolated { self?.exited(exit) } }
        })
      self.process = process
      log.notice("Server started: pid \(process.pid, privacy: .public)")
      // Exactly one of the approval lines the server's owner gate accepts (owner-start.mjs).
      try process.send(
        remoteAccess ? #"{"type":"start","sharing":"remote"}"# : #"{"type":"start","sharing":"local"}"#)
    } catch {
      log.error("Couldn't start sharing: \(error.localizedDescription, privacy: .public)")
      process?.kill()
      process = nil
      sharing = .stoppedUnexpectedly(reason: error.localizedDescription)
    }
  }

  func stopSharing() {
    guard let process, sharing != .stopping else { return }
    stopRequested = true
    sharing = .stopping
    try? process.send(#"{"type":"stop"}"#)
    // A server that doesn't stop within five seconds is ended, with its relay and workers.
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(5))
      guard let self, self.process === process else { return }
      process.kill()
    }
  }

  /// Stops sharing and waits for the server to exit, for Quit.
  func shutdown() async {
    guard process != nil else { return }
    await withCheckedContinuation { continuation in
      exitWaiters.append(continuation)
      stopSharing()
    }
  }

  func restartServer() {
    if process == nil { startSharing(remoteAccess: requestedRemote) }
  }

  func answerNetwork(_ id: PendingNetwork.ID, allow: Bool) {
    perform("Couldn't answer for the network") {
      _ = try await self.request(["type": "network-confirm", "id": id, "allow": allow])
      self.networkRows.removeAll { $0.id == id }
    }
  }

  private func receive(_ data: Data) {
    let line: ServerLine?
    do {
      line = try ServerLine.decode(data)
    } catch {
      // A line the host can't read is skipped; the next status line brings the state again.
      return
    }
    switch line {
    case .ready(let ready):
      log.notice("Sharing started")
      sharing = .running
      sharingNotice = ready.sharingNotice
      password = ready.password
      tlsReport = ready.tls
      policy = ready.policy
      access = ready.access
      clientsStatus = ready.clients
      backends = ready.backends
      hostCodecs = ready.codecs
      serverVersions = ready.versions
      if !ready.displays.isEmpty { displayRows = Self.numbered(ready.displays) }
    case .status(let status):
      sessions = status.sessions
      relay = status.relay
      encoders = status.encoders
      if let tls = status.tls { tlsReport = tls }
      networkRows = status.networks ?? []
    case .clients(let clients):
      clientsStatus = clients
      notifyApprovals()
    case .displays(let rows):
      displayRows = Self.numbered(rows)
    case .reply(let reply):
      if let id = reply.requestId, let continuation = replies.removeValue(forKey: id) {
        continuation.resume(returning: reply)
      } else if reply.type == "tls-regenerate-result", let continuation = tlsReply {
        tlsReply = nil
        continuation.resume(returning: reply)
      }
    case .other, nil:
      break
    }
  }

  /// Rows with their Identify numbers: the server's when it sent them, else by id order.
  private static func numbered(_ rows: [DisplayRow]) -> [DisplayRow] {
    rows.sorted { $0.id < $1.id }.enumerated().map { index, row in
      var row = row
      row.number = row.number ?? index + 1
      return row
    }
  }

  private func exited(_ exit: ServerProcess.Exit) {
    log.notice(
      "Server exited: code \(exit.code ?? -1, privacy: .public), signal \(exit.signal ?? 0, privacy: .public)")
    process = nil
    let expected = stopRequested
    stopRequested = false
    if expected || exit.code == 0 {
      sharing = .off
    } else {
      let detail = exit.errors.split(separator: "\n").last.map(String.init)
      sharing = .stoppedUnexpectedly(
        reason: detail
          ?? (exit.code.map { "The server exited with code \($0)." }
            ?? "The server was stopped by signal \(exit.signal ?? 0)."))
    }
    for continuation in replies.values { continuation.resume(throwing: Failure.noReply) }
    replies.removeAll()
    tlsReply?.resume(throwing: Failure.noReply)
    tlsReply = nil
    sessions = []
    relay = nil
    networkRows = []
    sharingNotice = nil
    password = nil
    displayRows = LocalDisplays.current()
    for waiter in exitWaiters { waiter.resume() }
    exitWaiters.removeAll()
    Task { await loadOfflineSettings() }
  }

  // MARK: Owner commands

  /// Sends a command with a fresh `requestId` and waits for its reply. A refusal throws the
  /// server's reason.
  private func request(_ command: [String: Any], timeout: Double = 15) async throws -> OwnerReply {
    guard let process else { throw Failure.notSharing }
    let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    var command = command
    command["requestId"] = id
    let line = String(decoding: try JSONSerialization.data(withJSONObject: command), as: UTF8.self)
    let reply = try await withCheckedThrowingContinuation { continuation in
      replies[id] = continuation
      do {
        try process.send(line)
      } catch {
        replies.removeValue(forKey: id)?.resume(throwing: error)
        return
      }
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(timeout))
        self?.replies.removeValue(forKey: id)?.resume(throwing: Failure.noReply)
      }
    }
    if let failure = reply.failure {
      // Replies carry the settings as they now are, so a refusal still redraws them.
      if let access = reply.access { self.access = access }
      if let policy = reply.policy { self.policy = policy }
      throw RuntimeManifest.Failure.invalid(failure)
    }
    return reply
  }

  /// Runs `work`, and shows what went wrong under `title` if it fails.
  private func perform(_ title: String, _ work: @escaping () async throws -> Void) {
    Task {
      do {
        try await work()
      } catch {
        alert = HostAlert(title: title, message: error.localizedDescription)
      }
    }
  }

  // MARK: Offline settings

  private func manifest() throws -> RuntimeManifest {
    guard let filename = RuntimeManifest.defaultFilename() else {
      throw RuntimeManifest.Failure.invalid(
        "VidVNC can't find its runtime. Run npm run prepare:host, or set VIDVNC_RUNTIME_MANIFEST.")
    }
    return try RuntimeManifest.load(filename)
  }

  private func loadOfflineSettings() async {
    guard process == nil else { return }
    do {
      let saved = try await OfflineSettings.show(try manifest())
      guard process == nil else { return }
      policy = saved.policy
      var access = saved.access
      // Remote access is chosen each time sharing starts.
      access.remoteAccess = false
      self.access = access
    } catch {
      // Shown as defaults; starting to share reports the real problem.
    }
    offlineLoaded = true
  }

  // MARK: Permissions

  func refreshPermissions() {
    var next: [PermissionKind: PermissionState] = [:]
    next[.screenRecording] =
      Privacy.screenRecordingAllowed ? .granted : (hasSeenPermissionsIntro ? .missing : .notDetermined)
    next[.deviceControl] =
      Privacy.deviceControlAllowed
      ? .granted : (inputUnavailable != nil || defaults.bool(forKey: "askedDeviceControl") ? .missing : .notDetermined)
    next[.localNetwork] = localNetworkState
    next[.newNetworkConfirmation] = networkRows.isEmpty ? .granted : .needsAttention
    if next != permissions { permissions = next }
  }

  func requestScreenRecording() -> Bool {
    let allowed = Privacy.screenRecordingAllowed || Privacy.requestScreenRecording()
    refreshPermissions()
    return allowed
  }

  func requestDeviceControl() {
    defaults.set(true, forKey: "askedDeviceControl")
    Privacy.requestDeviceControl()
    refreshPermissions()
  }

  func requestLocalNetwork() {
    defaults.set(true, forKey: "askedLocalNetwork")
    if localNetworkState == .notDetermined { localNetworkState = .needsAttention }
    localNetwork.run { [weak self] result in
      guard let self else { return }
      switch result {
      case .allowed: self.localNetworkState = .granted
      case .denied: self.localNetworkState = .missing
      case .unknown: break
      }
      self.refreshPermissions()
    }
    // Approval requests post a notification. Provisional authorisation never prompts.
    UNUserNotificationCenter.current().requestAuthorization(options: [.provisional, .alert, .sound]) {
      _, _ in
    }
  }

  private func notifyApprovals() {
    let fresh = clientsStatus.pending.filter { !notifiedApprovals.contains($0.id) }
    notifiedApprovals.formUnion(fresh.map(\.id))
    guard !fresh.isEmpty, !NSApp.isActive else { return }
    for request in fresh {
      let content = UNMutableNotificationContent()
      content.title = "\(request.deviceName) wants to connect"
      content.body = "Open VidVNC to approve or reject it."
      content.sound = .default
      UNUserNotificationCenter.current().add(
        UNNotificationRequest(identifier: request.id, content: content, trigger: nil))
    }
  }

  private func refreshInterfaces() {
    let served = Set(
      ((tlsReport?.viewerUrls ?? []) + (tlsReport?.localHttpUrls ?? [])).compactMap {
        URL(string: $0)?.host()
      })
    let next = NetworkInterfaces.current(served: process == nil ? [] : served)
    if next.map(\.id) != interfaces.map(\.id) || next.map(\.isServed) != interfaces.map(\.isServed) {
      interfaces = next
    }
  }

  // MARK: Access

  var connectionMethod: ConnectionMethod {
    get { access.flatMap { ConnectionMethod(rawValue: $0.connectionMode) } ?? .sessionKey }
    set { changeAccess(["connectionMode": newValue.rawValue], offline: ["connection-mode", newValue.rawValue]) }
  }

  var controlDefault: ControlDefault {
    get { access.flatMap { ControlDefault(rawValue: $0.defaultControl) } ?? .requireApproval }
    set { changeAccess(["defaultControl": newValue.rawValue], offline: ["access", newValue.rawValue]) }
  }

  var maxConnectedDevices: Int {
    get { access?.maxSessions ?? 4 }
    set { changeAccess(["maxSessions": newValue], offline: ["max-devices", "\(newValue)"]) }
  }

  var publicLoginName: String {
    get { access?.publicName ?? "" }
    set {
      let name = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !name.isEmpty, name != access?.publicName else { return }
      changeAccess(["publicName": name], offline: ["public-name", name])
    }
  }

  var accessEditable: Bool {
    !accessSaving && sharing != .starting && sharing != .stopping && (process != nil || offlineLoaded)
      && access != nil
  }

  /// Sends `changes` with `access-set` while sharing, or runs `config <offline>` while not.
  private func changeAccess(_ changes: [String: Any], offline: [String]) {
    guard let current = access, !accessSaving else { return }
    accessSaving = true
    perform("Couldn't change the access settings") {
      defer { self.accessSaving = false }
      if self.process != nil {
        var command: [String: Any] = ["type": "access-set", "revision": current.revision]
        command.merge(changes) { $1 }
        let reply = try await self.request(command)
        if let access = reply.access { self.access = access }
        if let key = reply.sessionKey { self.password = key }
      } else {
        var saved = try await OfflineSettings.access(try self.manifest(), offline)
        saved.remoteAccess = false
        self.access = saved
      }
    }
  }

  func makeConnectionCode(_ kind: ConnectionCode.Kind) async throws -> ConnectionCode {
    let alphabet = access?.defaultCodeAlphabet ?? "letters-digits"
    switch kind {
    case .sessionKey:
      guard let password else { throw Failure.notSharing }
      return try code(kind, password, expires: nil)
    case .oneTime:
      let reply = try await request(["type": "connection-once-create", "alphabet": alphabet])
      return try code(kind, reply.key ?? "", expires: reply.expiresAt)
    case .clientSetup:
      let reply = try await request(["type": "client-setup-create", "alphabet": alphabet])
      return try code(kind, reply.key ?? "", expires: reply.expiresAt)
    }
  }

  func newSessionKey() async throws -> ConnectionCode {
    let alphabet = access?.defaultCodeAlphabet ?? "letters-digits"
    let reply = try await request(["type": "session-password-rotate", "alphabet": alphabet])
    password = reply.key
    return try code(.sessionKey, reply.key ?? "", expires: nil)
  }

  /// The secret goes after `#`: browsers never send a fragment, and the web client removes it
  /// before it calls the server (as the Windows host's ConnectionQrUrl).
  private func code(_ kind: ConnectionCode.Kind, _ key: String, expires: Double?) throws
    -> ConnectionCode
  {
    guard let address = viewerAddress else { throw Failure.notSharing }
    let fragment = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key
    return ConnectionCode(
      kind: kind, code: key, link: "\(address)/#key=\(fragment)",
      expires: expires.map { Date(timeIntervalSince1970: $0 / 1000) })
  }

  // MARK: Clients

  var clients: [ConnectedClient] {
    sessions.map { session in
      ConnectedClient(
        id: session.id, name: session.device, kind: DeviceKind(describing: session.device),
        address: session.address, connectedAt: Date(timeIntervalSince1970: session.connectedAt / 1000),
        isControlling: session.control == "Granted", health: session.health,
        streams: session.streams.enumerated().map { index, stream in
          StreamStats(
            id: stream.id ?? "\(session.id)-\(index)", displayName: stream.name,
            resolution: [stream.width, stream.height].contains(nil)
              ? "" : "\(stream.width!) \u{00D7} \(stream.height!)",
            codec: stream.codec.map(VideoCodec.title) ?? "", samples: Self.samples(stream.stability),
            inputUnavailable: stream.inputUnavailable)
        })
    }
  }

  /// Capture and encode rates from the server and decode rates from the viewer, by second.
  private static func samples(_ stability: StabilityRow?) -> [FPSSample] {
    guard let stability else { return [] }
    var bySecond: [Int: (capture: Double?, encode: Double?, decode: Double?)] = [:]
    for sample in stability.generated {
      let second = Int(sample.at / 1000)
      bySecond[second, default: (nil, nil, nil)].capture = sample.captureFps
      bySecond[second, default: (nil, nil, nil)].encode = sample.encodeFps
    }
    for point in stability.points {
      bySecond[Int(point.at / 1000), default: (nil, nil, nil)].decode = point.fps
    }
    return bySecond.keys.sorted().map { second in
      let values = bySecond[second]!
      return FPSSample(
        time: Date(timeIntervalSince1970: Double(second)), capture: values.capture,
        encode: values.encode, decode: values.decode)
    }
  }

  var pendingApprovals: [ApprovalRequest] {
    clientsStatus.pending.map { row in
      ApprovalRequest(
        id: row.id, name: row.deviceName, kind: DeviceKind(describing: row.deviceName, row.client),
        detail: [row.client, row.network].compactMap(\.self).joined(separator: " \u{00B7} "),
        requestedAt: row.requestedAt.map { Date(timeIntervalSince1970: $0 / 1000) })
    }
  }

  var approvedClients: [ApprovedClient] {
    clientsStatus.approved.map { row in
      ApprovedClient(
        id: row.id, name: row.deviceName, kind: DeviceKind(describing: row.deviceName, row.client),
        detail: [row.client, row.network].compactMap(\.self).joined(separator: " \u{00B7} "),
        permission: ClientPermission(rawValue: row.permission) ?? .default,
        isConnected: row.connected,
        lastSeen: row.lastConnectedAt.map { Date(timeIntervalSince1970: $0 / 1000) })
    }
  }

  func approve(_ id: ApprovalRequest.ID) {
    perform("Couldn't approve the device") {
      _ = try await self.request(["type": "client-request-command", "action": "approve", "id": id])
    }
  }

  func reject(_ id: ApprovalRequest.ID) {
    perform("Couldn't reject the device") {
      _ = try await self.request(["type": "client-request-command", "action": "reject", "id": id])
    }
  }

  func removeApproved(_ id: ApprovedClient.ID) {
    perform("Couldn't remove the device") {
      _ = try await self.request(["type": "approved-client-command", "action": "remove", "id": id])
    }
  }

  func setPermission(_ permission: ClientPermission, for id: ApprovedClient.ID) {
    perform("Couldn't change what the device may do") {
      _ = try await self.request([
        "type": "approved-client-command", "action": "permission", "id": id,
        "permission": permission.rawValue,
      ])
    }
  }

  func disconnect(_ id: ConnectedClient.ID) {
    // `disconnect` has no reply; the next status line drops the session.
    let line = String(
      decoding: (try? JSONSerialization.data(withJSONObject: ["type": "disconnect", "id": id])) ?? Data(),
      as: UTF8.self)
    try? process?.send(line)
  }

  func disconnectOrdinarySessions() {
    perform("Couldn't disconnect the sessions") {
      _ = try await self.request(["type": "ordinary-sessions-disconnect"])
    }
  }

  func grantControl(_ id: ConnectedClient.ID) {
    perform("Couldn't give control") {
      _ = try await self.request(["type": "session-command", "action": "grant", "sessionId": id])
    }
  }

  func revokeControl(_ id: ConnectedClient.ID) {
    perform("Couldn't take back control") {
      _ = try await self.request(["type": "session-command", "action": "revoke", "sessionId": id])
    }
  }

  func openDiagnostics() {
    perform("Couldn't open Diagnostics") {
      let reply = try await self.request(["type": "diagnostics-capability-create"])
      // Only the loopback diagnostics page, and the token only in the fragment.
      guard let token = reply.token, token.count == 43, let text = reply.url,
        let url = URL(string: text), url.scheme == "http", url.host() == "127.0.0.1",
        url.path() == "/diagnostics", url.query() == nil, url.fragment() == nil,
        let launch = URL(
          string: text + "#capability=" + (token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""))
      else { throw RuntimeManifest.Failure.invalid("The server returned an invalid diagnostics address.") }
      NSWorkspace.shared.open(launch)
    }
  }

  // MARK: Network

  var publicNames: [String] { access?.publicHostnames ?? [] }
  var publicPort: Int? { access?.publicPort }
  var mediaPort: Int? { access?.mediaPort }

  func setRemoteAccess(_ enabled: Bool) {
    if process == nil {
      if enabled { startSharing(remoteAccess: true) }
      return
    }
    guard let current = access else { return }
    if enabled, current.publicHostnames.isEmpty {
      alert = HostAlert(
        title: "Add a public name first",
        message: "Remote access needs the name or address internet devices use for this Mac. Add it under Remote Access, then turn it on.")
      return
    }
    // Remote access requires approved clients only; the server refuses anything else.
    var changes: [String: Any] = ["remoteAccess": enabled]
    if enabled { changes["connectionMode"] = ConnectionMethod.approvedOnly.rawValue }
    accessSaving = true
    perform("Couldn't change remote access") {
      defer { self.accessSaving = false }
      var command: [String: Any] = ["type": "access-set", "revision": current.revision]
      command.merge(changes) { $1 }
      let reply = try await self.request(command)
      if let access = reply.access { self.access = access }
      if let key = reply.sessionKey { self.password = key }
      self.sharingNotice = nil
    }
  }

  func saveRemoteSettings(publicNames: [String], publicPort: Int?, mediaPort: Int?) async throws {
    if remoteAccessEnabled, publicNames.isEmpty {
      throw RuntimeManifest.Failure.invalid("Turn remote access off before removing every public name.")
    }
    accessSaving = true
    defer { accessSaving = false }
    if process != nil, let current = access {
      let reply = try await request([
        "type": "access-set", "revision": current.revision, "publicHostnames": publicNames,
        "publicPort": publicPort.map { $0 as Any } ?? NSNull(),
        "mediaPort": mediaPort.map { $0 as Any } ?? NSNull(),
      ])
      if let access = reply.access { self.access = access }
    } else {
      let manifest = try manifest()
      _ = try await OfflineSettings.access(
        manifest, publicNames.isEmpty ? ["public-hosts", "clear"] : ["public-hosts"] + publicNames)
      _ = try await OfflineSettings.access(manifest, ["public-port", publicPort.map(String.init) ?? "same"])
      var saved = try await OfflineSettings.access(
        manifest, ["media-port", mediaPort.map(String.init) ?? "auto"])
      saved.remoteAccess = false
      access = saved
    }
  }

  func regenerateCertificate() {
    guard let process, tlsReply == nil else { return }
    perform("Couldn't regenerate the certificate") {
      let reply = try await withCheckedThrowingContinuation { continuation in
        self.tlsReply = continuation
        do {
          try process.send(#"{"type":"tls-regenerate"}"#)
        } catch {
          self.tlsReply = nil
          continuation.resume(throwing: error)
        }
      }
      if let failure = reply.failure { throw RuntimeManifest.Failure.invalid(failure) }
    }
  }

  // MARK: Displays and streaming

  var policyEditable: Bool { sharing == .running && policy != nil }

  var displays: [DisplayInfo] {
    displayRows.map { row in
      DisplayInfo(
        id: row.id, number: row.number ?? 0, name: row.name, isPrimary: row.primary,
        frame: CGRect(x: row.x, y: row.y, width: row.width, height: row.height),
        isShared: policy?.displaySharing?[row.id] ?? true,
        profileID: policy?.displayDefaults[row.id])
    }
  }

  var profiles: [StreamProfile] { policy?.profiles ?? [] }
  var defaultProfileID: String { policy?.defaultProfileId ?? "auto" }
  var desktopAudio: Bool { policy?.allowAudio ?? true }
  var clientMode: String { policy?.clientMode ?? "profiles" }
  var allowedOptions: AllowedOptions {
    policy?.allowedOptions ?? AllowedOptions(resolutions: [], frameRates: [], bitratesKbps: [])
  }
  var encoderBackend: String { policy?.encoderBackend ?? "auto" }

  var availableEncoders: [EncoderChoice] {
    let rows = encoders?.available ?? backends
    return [EncoderChoice(id: "auto", label: "Automatic")]
      + rows.map { EncoderChoice(id: $0.id, label: $0.label) }
  }

  var videoCodecs: [String] { policy?.videoCodecs ?? ["h264"] }

  /// Only the codecs this Mac can encode (the server's `ready.codecs`): AV1 stays in the saved
  /// policy for the Windows host's sake, but VideoToolbox has no AV1 encoder, so it isn't
  /// offered here. Before sharing starts nothing is known, so only H.264 is listed.
  var availableCodecs: [String] {
    VideoCodec.all.filter { hostCodecs.isEmpty ? $0 == "h264" : hostCodecs.contains($0) }
  }

  func updatePolicy(_ change: @escaping (inout StreamPolicy) -> Void) {
    guard var next = policy, process != nil else { return }
    let revision = next.revision
    change(&next)
    let encoder = JSONEncoder()
    perform("Couldn't change the streaming settings") {
      let object = try JSONSerialization.jsonObject(with: try encoder.encode(next))
      // Devices whose stream the change affects reconnect; the views confirm that first.
      let reply = try await self.request([
        "type": "policy-set", "revision": revision, "policy": object, "disconnect": true,
      ])
      if let policy = reply.policy { self.policy = policy }
    }
  }

  // MARK: App settings

  var openAtLogin: Bool {
    get {
      _ = loginItemChanged
      return LoginItem.isEnabled
    }
    set {
      do {
        try LoginItem.set(newValue)
      } catch {
        alert = HostAlert(title: "Couldn't change Open at Login", message: error.localizedDescription)
      }
      loginItemChanged += 1
    }
  }
  private var loginItemChanged = 0

  var keepSharingWhenWindowCloses: Bool {
    didSet { defaults.set(keepSharingWhenWindowCloses, forKey: "keepSharingWhenWindowCloses") }
  }

  var versions: [VersionInfo] {
    let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    var result = [VersionInfo(component: "VidVNC", version: app)]
    for (key, name) in [("server", "Server"), ("node", "Node.js"), ("gstreamer", "GStreamer")] {
      if let version = serverVersions[key] { result.append(VersionInfo(component: name, version: version)) }
    }
    result.append(
      VersionInfo(component: "macOS", version: ProcessInfo.processInfo.operatingSystemVersionString))
    return result
  }
}
