import SwiftUI

/// Shown the first time sharing is turned on, before macOS asks for anything.
struct PermissionsIntroSheet: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Before You Share This Mac").font(.title2.weight(.semibold))
      Text(
        "macOS asks you about these when you continue. You can change them later in System Settings or the Permissions section."
      )
      .foregroundStyle(.secondary)
      ForEach([PermissionKind.screenRecording, .localNetwork]) { kind in
        row(kind.symbol, kind.title, kind.detail)
      }
      row(
        PermissionKind.deviceControl.symbol, PermissionKind.deviceControl.title,
        "Asked later, the first time you let a viewer use the keyboard and mouse.")
      row(
        PermissionKind.newNetworkConfirmation.symbol, "Networks",
        "VidVNC asks you before it listens on a network for the first time.")
      HStack {
        Spacer()
        Button("Not Now") { presentation.cancelStart() }.keyboardShortcut(.cancelAction)
        Button("Continue") { presentation.continueStart(model) }
          .keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 480)
  }

  private func row(_ symbol: String, _ title: String, _ detail: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol)
        .font(.title2).foregroundStyle(.tint).frame(width: 32)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).fontWeight(.medium)
        Text(detail).foregroundStyle(.secondary)
      }
    }
  }
}

/// Asks before VidVNC listens on a network it hasn't been allowed on (Q2). The server binds
/// to it only after Allow.
struct ConfirmNetworkSheet: View {
  var model: any HostModel
  var networkID: PendingNetwork.ID
  @Environment(Presentation.self) private var presentation

  var body: some View {
    let network = model.pendingNetworks.first { $0.id == networkID }
    VStack(spacing: 16) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 40)).foregroundStyle(.orange)
      Text("Share on This Network?").font(.title2.weight(.semibold))
      if let network {
        Text(
          "This Mac is on a network VidVNC hasn't used: \(network.title), \(network.subnets). Devices on it will be able to find VidVNC and ask to connect."
        )
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
      } else {
        Text("The network has gone away.").foregroundStyle(.secondary)
      }
      HStack {
        Button("Later") { presentation.postponeNetwork(networkID) }
          .keyboardShortcut(.cancelAction)
        Spacer()
        Button("Don't Allow") {
          model.answerNetwork(networkID, allow: false)
          presentation.sheet = nil
        }
        .disabled(network == nil)
        Button("Allow") {
          model.answerNetwork(networkID, allow: true)
          presentation.sheet = nil
        }
        .keyboardShortcut(.defaultAction)
        .disabled(network == nil)
      }
    }
    .padding(24)
    .frame(width: 440)
  }
}

/// Explains Device Control & Data Access the first time it matters, then lets macOS ask.
struct DeviceControlSheet: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        Image(systemName: PermissionKind.deviceControl.symbol)
          .font(.title).foregroundStyle(.tint)
        Text("Allow Keyboard and Mouse Control").font(.title2.weight(.semibold))
      }
      Text(
        "Viewers can use this Mac's keyboard and mouse only after you switch VidVNC on in Privacy & Security \u{203A} Device Control & Data Access. Until then they can watch."
      )
      .foregroundStyle(.secondary)
      Text("You can turn it off there at any time.").foregroundStyle(.secondary)
      HStack {
        Spacer()
        Button("Not Now") { presentation.sheet = nil }.keyboardShortcut(.cancelAction)
        Button("Open System Settings") {
          model.requestDeviceControl()
          NSWorkspace.shared.open(PermissionKind.deviceControl.settingsURL)
          presentation.sheet = nil
        }
        .keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 460)
  }
}

#Preview("Permissions Intro – Light") {
  PermissionsIntroSheet(model: FakeHostModel())
    .environment(Presentation())
    .preferredColorScheme(.light)
}

#Preview("Confirm Network – Dark") {
  ConfirmNetworkSheet(model: FakeHostModel(scenario: .newNetwork), networkID: "6361370af95a55dd")
    .environment(Presentation())
    .preferredColorScheme(.dark)
}

#Preview("Device Control – Light") {
  DeviceControlSheet(model: FakeHostModel())
    .environment(Presentation())
    .preferredColorScheme(.light)
}
