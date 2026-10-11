import SwiftUI

struct DisplaysView: View {
  var model: any HostModel
  @State private var draft: Draft?
  @State private var selection: DisplayInfo.ID?
  @State private var editingProfile: StreamProfile?

  /// Changes stay here until Apply.
  private struct Draft: Equatable {
    var displays: [DisplayInfo]
    var defaultProfileID: StreamProfile.ID
    var desktopAudio: Bool
  }

  private var saved: Draft {
    Draft(
      displays: model.displays, defaultProfileID: model.defaultProfileID,
      desktopAudio: model.desktopAudio)
  }

  var body: some View {
    let current = draft ?? saved
    Form {
      Section {
        DisplayArrangement(displays: current.displays, selection: $selection)
          .frame(height: 180)
          .padding(.vertical, 8)
      } footer: {
        Text("Select a display to change how it is shared.")
          .font(.callout).foregroundStyle(.secondary)
      }

      if let index = current.displays.firstIndex(where: { $0.id == selection }) {
        let display = current.displays[index]
        Section(display.name) {
          LabeledContent("Resolution", value: display.pixelSize)
          LabeledContent("Type", value: display.isBuiltIn ? "Built-in" : "External")
          Toggle(
            "Share this display",
            isOn: bind({ display.isShared }, { on in edit { $0.displays[index].isShared = on } })
          )
          .toggleStyle(.switch)
          Picker(
            "Default profile",
            selection: bind({ display.profileID }, { id in edit { $0.displays[index].profileID = id } })
          ) {
            ForEach(model.profiles) { Text($0.name).tag($0.id) }
          }
          .disabled(!display.isShared)
        }
      }

      Section("Host Defaults") {
        HStack {
          Picker(
            "Default profile",
            selection: bind({ current.defaultProfileID }, { id in edit { $0.defaultProfileID = id } })
          ) {
            ForEach(model.profiles) { Text($0.name).tag($0.id) }
          }
          Button("Edit\u{2026}") {
            editingProfile = model.profiles.first { $0.id == current.defaultProfileID }
          }
        }
        Toggle(
          "Desktop audio",
          isOn: bind({ current.desktopAudio }, { on in edit { $0.desktopAudio = on } })
        )
        .toggleStyle(.switch)
      }

      Section {
        HStack {
          Spacer()
          Button("Cancel") { draft = nil }
            .keyboardShortcut(.cancelAction)
          Button("Apply") { apply() }
            .keyboardShortcut(.defaultAction)
        }
        .disabled(draft == nil || draft == saved)
      }
    }
    .formStyle(.grouped)
    .toolbar {
      ToolbarItem {
        Button("Identify", systemImage: "number.square") { IdentifyOverlay.show() }
          .help("Show each display's number on its screen")
      }
    }
    .onAppear { if selection == nil { selection = model.displays.first?.id } }
    .sheet(item: $editingProfile) { profile in
      ProfileEditorSheet(profile: profile) { updated in
        if let i = model.profiles.firstIndex(where: { $0.id == updated.id }) {
          model.profiles[i] = updated
        }
      }
    }
  }

  private func edit(_ change: (inout Draft) -> Void) {
    var next = draft ?? saved
    change(&next)
    draft = next
  }

  private func apply() {
    guard let draft else { return }
    model.displays = draft.displays
    model.defaultProfileID = draft.defaultProfileID
    model.desktopAudio = draft.desktopAudio
    self.draft = nil
  }
}

#Preview("Displays – Light") {
  DisplaysView(model: FakeHostModel())
    .frame(width: 620, height: 700)
    .preferredColorScheme(.light)
}

#Preview("Displays – Dark") {
  DisplaysView(model: FakeHostModel())
    .frame(width: 620, height: 700)
    .preferredColorScheme(.dark)
}
