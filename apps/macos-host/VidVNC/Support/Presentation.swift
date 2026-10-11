import SwiftUI

enum SidebarSection: String, CaseIterable, Identifiable, Hashable {
  case overview, displays, streaming, connections, access, network, activity, permissions

  var id: Self { self }

  var title: String {
    switch self {
    case .overview: "Overview"
    case .connections: "Connections"
    case .access: "Access"
    case .network: "Network"
    case .activity: "Activity"
    case .displays: "Displays"
    case .streaming: "Streaming"
    case .permissions: "Permissions"
    }
  }

  var symbol: String {
    switch self {
    case .overview: "house"
    case .connections: "person.2"
    case .access: "lock"
    case .network: "network"
    case .activity: "waveform.path.ecg"
    case .displays: "display.2"
    case .streaming: "slider.horizontal.3"
    case .permissions: "hand.raised"
    }
  }
}

enum SheetKind: Identifiable, Equatable {
  case connectDevice
  case permissionsIntro
  case confirmNetwork(PendingNetwork.ID)
  case deviceControl

  var id: String {
    switch self {
    case .connectDevice: "connect"
    case .permissionsIntro: "intro"
    case .confirmNetwork(let network): "network-\(network)"
    case .deviceControl: "device-control"
    }
  }
}

/// Window-level UI state: which section is showing and which sheet is up. Shared by the main
/// window and the menu bar so either can open a sheet.
@MainActor
@Observable
final class Presentation {
  var section: SidebarSection = .overview
  var sheet: SheetKind?
  /// Set while a start is waiting on the permissions introduction.
  private var pendingStart: Bool?
  /// Networks the owner closed the sheet for without answering; a banner stays instead.
  private var postponedNetworks: Set<PendingNetwork.ID> = []

  /// Starts sharing, showing the permissions introduction first the first time. macOS asks
  /// for Screen Recording only now, after the owner turned sharing on (spec D5).
  func requestStart(_ model: any HostModel, remoteAccess: Bool = false) {
    if !model.hasSeenPermissionsIntro {
      pendingStart = remoteAccess
      sheet = .permissionsIntro
      return
    }
    start(model, remoteAccess: remoteAccess)
  }

  /// The introduction's Continue: ask macOS for each permission sharing needs now, then start.
  func continueStart(_ model: any HostModel) {
    model.hasSeenPermissionsIntro = true
    let remote = pendingStart ?? false
    pendingStart = nil
    sheet = nil
    model.requestLocalNetwork()
    start(model, remoteAccess: remote)
  }

  func cancelStart() {
    pendingStart = nil
    sheet = nil
  }

  private func start(_ model: any HostModel, remoteAccess: Bool) {
    if model.requestScreenRecording() {
      model.startSharing(remoteAccess: remoteAccess)
    } else {
      // Overview shows "Screen Recording not allowed" with a way to System Settings.
      section = .overview
    }
  }

  /// Gives control, explaining Device Control & Data Access first if VidVNC isn't allowed.
  func grantControl(_ id: ConnectedClient.ID, model: any HostModel) {
    model.grantControl(id)
    explainDeviceControl(model)
  }

  func explainDeviceControl(_ model: any HostModel) {
    if model.permissions[.deviceControl] != .granted { sheet = .deviceControl }
  }

  /// Shows the confirmation sheet for a network the server is waiting on, once per network.
  func networksChanged(_ model: any HostModel) {
    guard sheet == nil,
      let network = model.pendingNetworks.first(where: { !postponedNetworks.contains($0.id) })
    else { return }
    sheet = .confirmNetwork(network.id)
  }

  func postponeNetwork(_ id: PendingNetwork.ID) {
    postponedNetworks.insert(id)
    sheet = nil
  }

  func handle(_ action: HostIssue.Action, model: any HostModel) {
    switch action {
    case .openPermissions: section = .permissions
    case .openNetwork: section = .network
    case .confirmNetwork:
      if let network = model.pendingNetworks.first { sheet = .confirmNetwork(network.id) }
    case .restart: model.restartServer()
    case .reviewApprovals: section = .connections
    }
  }
}
