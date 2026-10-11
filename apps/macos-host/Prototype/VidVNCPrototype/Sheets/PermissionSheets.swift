import SwiftUI

/// Shown the first time sharing is turned on, before macOS asks for anything.
struct PermissionsIntroSheet: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("VidVNC Needs Three Permissions").font(.title2.weight(.semibold))
      Text("macOS will ask you about each of these. You can change them later in System Settings.")
        .foregroundStyle(.secondary)
      ForEach([PermissionKind.screenRecording, .deviceControl, .localNetwork]) { kind in
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: kind.symbol)
            .font(.title2).foregroundStyle(.tint).frame(width: 32)
          VStack(alignment: .leading, spacing: 2) {
            Text(kind.title).fontWeight(.medium)
            Text(kind.detail).foregroundStyle(.secondary)
          }
        }
      }
      HStack {
        Spacer()
        Button("Not Now") { presentation.cancelStart() }.keyboardShortcut(.cancelAction)
        Button("Continue") {
          model.hasSeenPermissionsIntro = true
          presentation.continueStart(model)
        }
        .keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 460)
  }
}

/// Asks before sharing on a network the host hasn't used before.
struct ConfirmNetworkSheet: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation

  var body: some View {
    let name = model.pendingNetwork ?? model.currentNetwork
    VStack(spacing: 16) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 40)).foregroundStyle(.orange)
      Text("Share on this network?").font(.title2.weight(.semibold))
      Text(
        "This Mac joined \u{201C}\(name)\u{201D}. Devices on this network will be able to find VidVNC and ask to connect."
      )
      .multilineTextAlignment(.center)
      .foregroundStyle(.secondary)
      HStack {
        Button("Don't Share") { presentation.cancelStart() }.keyboardShortcut(.cancelAction)
        Spacer()
        Button("Share on This Network") {
          model.confirmPendingNetwork()
          presentation.requestStart(model, remoteAccess: model.remoteAccessEnabled)
        }
        .keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 420)
  }
}

#Preview("Permissions Intro – Light") {
  PermissionsIntroSheet(model: FakeHostModel())
    .environment(Presentation())
    .preferredColorScheme(.light)
}

#Preview("Confirm Network – Dark") {
  ConfirmNetworkSheet(model: FakeHostModel(scenario: .newNetwork))
    .environment(Presentation())
    .preferredColorScheme(.dark)
}
