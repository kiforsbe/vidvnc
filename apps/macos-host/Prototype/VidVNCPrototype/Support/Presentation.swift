import SwiftUI

enum SidebarSection: String, CaseIterable, Identifiable, Hashable {
  case overview, connections, access, network, activity, displays, permissions

  var id: Self { self }

  var title: String {
    switch self {
    case .overview: "Overview"
    case .connections: "Connections"
    case .access: "Access"
    case .network: "Network"
    case .activity: "Activity"
    case .displays: "Displays"
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
    case .permissions: "hand.raised"
    }
  }
}

enum SheetKind: Identifiable {
  case connectDevice
  case permissionsIntro
  case confirmNetwork

  var id: Self { self }
}

/// Window-level UI state: which section is showing and which sheet is up. Shared by the main
/// window and the menu bar so either can open a sheet.
@MainActor
@Observable
final class Presentation {
  var section: SidebarSection = .overview
  var sheet: SheetKind?
  /// Set while a start is waiting on the permissions intro or a network confirmation.
  private var pendingStart: Bool?

  /// Starts sharing, showing the permissions intro and the network confirmation first when
  /// they apply, in that order.
  func requestStart(_ model: any HostModel, remoteAccess: Bool = false) {
    pendingStart = remoteAccess
    continueStart(model)
  }

  func continueStart(_ model: any HostModel) {
    guard let remote = pendingStart else {
      sheet = nil
      return
    }
    if !model.hasSeenPermissionsIntro {
      sheet = .permissionsIntro
    } else if model.pendingNetwork != nil {
      sheet = .confirmNetwork
    } else {
      sheet = nil
      pendingStart = nil
      model.startSharing(remoteAccess: remote)
    }
  }

  func cancelStart() {
    pendingStart = nil
    sheet = nil
  }

  func handle(_ action: HostIssue.Action, model: any HostModel) {
    switch action {
    case .openPermissions: section = .permissions
    case .confirmNetwork: sheet = .confirmNetwork
    case .restart: model.restartServer()
    case .regenerateCertificate: model.regenerateCertificate()
    case .reviewApprovals: section = .connections
    }
  }
}
