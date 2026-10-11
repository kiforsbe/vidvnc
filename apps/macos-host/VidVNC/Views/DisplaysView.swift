import SwiftUI

struct DisplaysView: View {
  var model: any HostModel
  @State private var draft: Draft?
  @State private var selection: DisplayInfo.ID?
  @State private var confirming = false

  /// Changes stay here until Apply, because applying can restart viewers' streams.
  private struct Draft: Equatable {
    var sharing: [String: Bool]
    var profiles: [String: String]
    var defaultProfileID: String
    var desktopAudio: Bool
  }

  private var saved: Draft {
    Draft(
      sharing: Dictionary(uniqueKeysWithValues: model.displays.map { ($0.id, $0.isShared) }),
      profiles: Dictionary(uniqueKeysWithValues: model.displays.compactMap { d in d.profileID.map { (d.id, $0) } }),
      defaultProfileID: model.defaultProfileID, desktopAudio: model.desktopAudio)
  }

  private var enabledProfiles: [StreamProfile] { model.profiles.filter(\.enabled) }

  var body: some View {
    let current = draft ?? saved
    let shown = model.displays.map { display in
      var display = display
      display.isShared = current.sharing[display.id] ?? true
      display.profileID = current.profiles[display.id]
      return display
    }
    Form {
      Section {
        DisplayArrangement(displays: shown, selection: $selection)
          .frame(height: 180)
          .padding(.vertical, 8)
      } footer: {
        Text("Select a display to change how it is shared. Numbers match Identify and the viewer's display list.")
          .font(.callout).foregroundStyle(.secondary)
      }

      if let display = shown.first(where: { $0.id == selection }) {
        Section("\(display.number). \(display.name)") {
          LabeledContent("Size", value: "\(display.sizeText) points")
          if display.isPrimary { LabeledContent("Main display", value: "Yes") }
          Toggle(
            "Share this display",
            isOn: bind({ display.isShared }, { on in edit { $0.sharing[display.id] = on } })
          )
          .toggleStyle(.switch)
          Picker(
            "Default profile",
            selection: bind({ display.profileID ?? "" }, { id in edit { $0.profiles[display.id] = id.isEmpty ? nil : id } })
          ) {
            Text("Host default (\(model.profileName(current.defaultProfileID)))").tag("")
            ForEach(enabledProfiles) { Text($0.name).tag($0.id) }
          }
          .disabled(!display.isShared)
        }
      }

      Section("Host Defaults") {
        Picker(
          "Default profile",
          selection: bind({ current.defaultProfileID }, { id in edit { $0.defaultProfileID = id } })
        ) {
          Text("Automatic").tag("auto")
          ForEach(enabledProfiles) { Text($0.name).tag($0.id) }
        }
        Toggle(
          "Share desktop audio",
          isOn: bind({ current.desktopAudio }, { on in edit { $0.desktopAudio = on } })
        )
        .toggleStyle(.switch)
      }

      Section {
        HStack {
          if !model.policyEditable {
            Text("Start sharing to change these settings.").font(.callout).foregroundStyle(.secondary)
          }
          Spacer()
          Button("Cancel") { draft = nil }
            .keyboardShortcut(.cancelAction)
            .disabled(draft == nil || draft == saved)
          Button("Apply") { model.clients.isEmpty ? apply() : (confirming = true) }
            .keyboardShortcut(.defaultAction)
            .disabled(draft == nil || draft == saved || !model.policyEditable)
        }
      }
    }
    .formStyle(.grouped)
    .toolbar {
      ToolbarItem {
        Button("Identify", systemImage: "number.square") { IdentifyOverlay.show(model.displays) }
          .help("Show each display's number on its screen")
      }
    }
    .onAppear { if selection == nil { selection = model.displays.first?.id } }
    .alert("Apply display changes?", isPresented: $confirming) {
      Button("Apply") { apply() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Connected devices whose streams change reconnect to them.")
    }
  }

  private func edit(_ change: (inout Draft) -> Void) {
    var next = draft ?? saved
    change(&next)
    draft = next
  }

  private func apply() {
    guard let draft else { return }
    let ids = model.displays.map(\.id)
    model.updatePolicy { policy in
      // Keep entries for displays that aren't connected now, so they keep their settings.
      var sharing = policy.displaySharing ?? [:]
      for id in ids { sharing[id] = draft.sharing[id] ?? true }
      policy.displaySharing = sharing
      for id in ids { policy.displayDefaults[id] = draft.profiles[id] }
      policy.defaultProfileId = draft.defaultProfileID
      policy.allowAudio = draft.desktopAudio
    }
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
