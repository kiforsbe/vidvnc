import SwiftUI

/// Each permission's live state, with a way to change it. Buttons that make macOS ask are
/// owner actions; nothing here asks on its own (spec D5).
struct PermissionsView: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Form {
      Section {
        ForEach(PermissionKind.allCases) { kind in
          let state = model.permissions[kind] ?? .notDetermined
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: kind.symbol)
              .font(.title3).frame(width: 24).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
              Text(kind.title)
              Text(kind.detail).font(.callout).foregroundStyle(.secondary)
              Label(state.title, systemImage: state.symbol)
                .font(.callout)
                .foregroundStyle(state.color)
                .padding(.top, 2)
                .accessibilityIdentifier("permission-\(kind.rawValue)")
              if let note = note(kind, state) {
                Text(note).font(.callout).foregroundStyle(.secondary)
              }
            }
            Spacer()
            actions(kind, state)
          }
          .padding(.vertical, 2)
        }
      } footer: {
        Text(
          "Changes in System Settings show here within a few seconds. If macOS asks you to quit and reopen VidVNC, do that; sharing starts again when you turn it on."
        )
        .font(.callout).foregroundStyle(.secondary)
      }

      Section {
        Button("Show Permissions Introduction\u{2026}") {
          presentation.sheet = .permissionsIntro
        }
      }
    }
    .formStyle(.grouped)
    .onAppear { model.refreshPermissions() }
  }

  @ViewBuilder
  private func actions(_ kind: PermissionKind, _ state: PermissionState) -> some View {
    switch kind {
    case .newNetworkConfirmation:
      Button("Review\u{2026}") { presentation.handle(.confirmNetwork, model: model) }
        .disabled(model.pendingNetworks.isEmpty)
    case .screenRecording where state == .notDetermined:
      Button("Allow\u{2026}") { _ = model.requestScreenRecording() }
    case .deviceControl where state != .granted:
      Button("Allow\u{2026}") {
        model.requestDeviceControl()
        NSWorkspace.shared.open(kind.settingsURL)
      }
    case .localNetwork where state != .granted:
      VStack(alignment: .trailing) {
        Button("Check Again") { model.requestLocalNetwork() }
        Button("Open System Settings") { NSWorkspace.shared.open(kind.settingsURL) }
      }
    default:
      Button("Open System Settings") { NSWorkspace.shared.open(kind.settingsURL) }
    }
  }

  private func note(_ kind: PermissionKind, _ state: PermissionState) -> String? {
    switch (kind, state) {
    case (.screenRecording, .notDetermined):
      "macOS asks the first time you turn sharing on."
    case (.deviceControl, .notDetermined):
      "Asked the first time you give a viewer control or choose Allow when available."
    case (.deviceControl, .missing):
      "Viewers can watch but not use the keyboard and mouse. Switch VidVNC on in the list."
    case (.localNetwork, .notDetermined):
      "macOS asks the first time sharing starts."
    case (.localNetwork, .needsAttention):
      "VidVNC can't read this setting directly. If viewers on your network can't connect, check that VidVNC is on in the list."
    case (.localNetwork, .missing):
      "Devices on your network can't reach this Mac. Switch VidVNC on in the list."
    case (.newNetworkConfirmation, .needsAttention):
      "VidVNC is waiting for you to allow or refuse a network."
    default: nil
    }
  }
}

#Preview("Permissions – Light") {
  PermissionsView(model: FakeHostModel(scenario: .screenRecordingMissing))
    .environment(Presentation())
    .frame(width: 620, height: 600)
    .preferredColorScheme(.light)
}

#Preview("Permissions – Dark") {
  PermissionsView(model: FakeHostModel(scenario: .inputUnavailable))
    .environment(Presentation())
    .frame(width: 620, height: 600)
    .preferredColorScheme(.dark)
}
