import SwiftUI

/// Shows each permission's state from the model. The prototype never asks the system for
/// permission state or triggers a privacy prompt; buttons only open System Settings.
struct PermissionsView: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation

  var body: some View {
    Form {
      Section {
        ForEach(PermissionKind.allCases) { kind in
          let state = model.permissions[kind] ?? .missing
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
            }
            Spacer()
            if kind == .newNetworkConfirmation {
              Button("Review\u{2026}") { presentation.sheet = .confirmNetwork }
                .disabled(model.pendingNetwork == nil)
            } else {
              Button("Open System Settings") { NSWorkspace.shared.open(kind.settingsURL) }
            }
          }
          .padding(.vertical, 2)
        }
      } footer: {
        Text("Changes in System Settings take effect the next time sharing starts.")
          .font(.callout).foregroundStyle(.secondary)
      }

      Section {
        Button("Show Permissions Introduction\u{2026}") {
          presentation.sheet = .permissionsIntro
        }
      }
    }
    .formStyle(.grouped)
  }
}

#Preview("Permissions – Light") {
  PermissionsView(model: FakeHostModel(scenario: .screenRecordingMissing))
    .environment(Presentation())
    .frame(width: 620, height: 520)
    .preferredColorScheme(.light)
}

#Preview("Permissions – Dark") {
  PermissionsView(model: FakeHostModel(scenario: .inputUnavailable))
    .environment(Presentation())
    .frame(width: 620, height: 520)
    .preferredColorScheme(.dark)
}
