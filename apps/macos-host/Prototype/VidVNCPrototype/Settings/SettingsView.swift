import SwiftUI

struct SettingsView: View {
  var model: any HostModel

  var body: some View {
    TabView {
      Tab("General", systemImage: "gearshape") { GeneralSettings(model: model) }
      Tab("Streaming", systemImage: "play.rectangle") { StreamingSettings(model: model) }
      Tab("About", systemImage: "info.circle") { AboutSettings(model: model) }
    }
    .frame(width: 520)
  }
}

private struct GeneralSettings: View {
  var model: any HostModel
  @State private var showingInstallNote = false

  var body: some View {
    Form {
      Toggle("Open at login", isOn: bind({ model.openAtLogin }, { model.openAtLogin = $0 }))
      Toggle(
        "Keep sharing when the window closes",
        isOn: bind({ model.keepSharingWhenWindowCloses }, { model.keepSharingWhenWindowCloses = $0 }))
      Text(
        "Closing the window always leaves VidVNC in the menu bar. Turn this off to stop sharing when you close it."
      )
      .font(.callout).foregroundStyle(.secondary)
      LabeledContent("Command-line tool") {
        Button("Install\u{2026}") { showingInstallNote = true }
      }
      LabeledContent("Logs") {
        Button("Show in Finder") {
          let logs = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Logs")
          NSWorkspace.shared.activateFileViewerSelecting([logs])
        }
      }
    }
    .formStyle(.grouped)
    .alert("Install the Command-Line Tool", isPresented: $showingInstallNote) {
      Button("OK") {}
    } message: {
      Text("The prototype doesn't install anything. The real app links vidvnc into /usr/local/bin.")
    }
  }
}

private struct StreamingSettings: View {
  var model: any HostModel
  @State private var selection: StreamProfile.ID?
  @State private var editing: StreamProfile?

  var body: some View {
    Form {
      Section("Profiles") {
        List(selection: $selection) {
          ForEach(model.profiles) { profile in
            HStack {
              Text(profile.name)
              if profile.id == model.defaultProfileID {
                Text("Default").font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Text("\(profile.maxResolution) \u{00B7} \(profile.frameRate) fps \u{00B7} \(profile.codec)")
                .foregroundStyle(.secondary)
            }
            .tag(profile.id)
            .contextMenu { Button("Edit\u{2026}") { editing = profile } }
          }
          .onMove { model.profiles.move(fromOffsets: $0, toOffset: $1) }
        }
        .frame(height: 110)
        HStack(spacing: 4) {
          Button("Add", systemImage: "plus") {
            editing = StreamProfile(
              id: UUID(), name: "New Profile", maxResolution: "1920 × 1080", frameRate: 30,
              bitrateMbps: 8, codec: "H.264")
          }
          Button("Remove", systemImage: "minus") {
            model.profiles.removeAll { $0.id == selection && $0.id != model.defaultProfileID }
          }
          .disabled(selection == nil || selection == model.defaultProfileID)
          Spacer()
          Button("Edit\u{2026}") { editing = model.profiles.first { $0.id == selection } }
            .disabled(selection == nil)
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
      }

      Section("Viewers May Choose") {
        Toggle(
          "Resolution",
          isOn: bind({ model.allowViewerResolutionChoice }, { model.allowViewerResolutionChoice = $0 }))
        Toggle(
          "Frame rate",
          isOn: bind({ model.allowViewerFrameRateChoice }, { model.allowViewerFrameRateChoice = $0 }))
      }

      Section("Encoding") {
        Picker("Encoder", selection: bind({ model.encoder }, { model.encoder = $0 })) {
          ForEach(model.availableEncoders, id: \.self) { Text($0) }
        }
        ForEach(model.availableCodecs, id: \.self) { codec in
          Toggle(
            codec,
            isOn: bind({ model.enabledCodecs.contains(codec) }, { on in
              if on { model.enabledCodecs.insert(codec) } else { model.enabledCodecs.remove(codec) }
            }))
        }
      }
    }
    .formStyle(.grouped)
    .frame(height: 520)
    .sheet(item: $editing) { profile in
      ProfileEditorSheet(profile: profile) { updated in
        if let i = model.profiles.firstIndex(where: { $0.id == updated.id }) {
          model.profiles[i] = updated
        } else {
          model.profiles.append(updated)
        }
      }
    }
  }
}

private struct AboutSettings: View {
  var model: any HostModel

  var body: some View {
    Form {
      Section {
        ForEach(model.versions) { LabeledContent($0.component, value: $0.version) }
      }
      HStack {
        Spacer()
        Button("Copy Versions") {
          let text = model.versions.map { "\($0.component): \($0.version)" }
            .joined(separator: "\n")
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(text, forType: .string)
        }
      }
    }
    .formStyle(.grouped)
  }
}

#Preview("Settings – Light") {
  SettingsView(model: FakeHostModel()).preferredColorScheme(.light)
}

#Preview("Settings – Dark") {
  SettingsView(model: FakeHostModel()).preferredColorScheme(.dark)
}
