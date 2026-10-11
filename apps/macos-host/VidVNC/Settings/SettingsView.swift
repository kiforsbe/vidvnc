import SwiftUI

struct SettingsView: View {
  var model: any HostModel

  var body: some View {
    TabView {
      Tab("General", systemImage: "gearshape") { GeneralSettings(model: model) }
      Tab("About", systemImage: "info.circle") { AboutSettings(model: model) }
    }
    .frame(width: 480)
  }
}

private struct GeneralSettings: View {
  var model: any HostModel

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
      CommandLineToolRow()
      LabeledContent("Logs") {
        Button("Show in Finder") {
          let logs = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/VidVNC/logs")
          if FileManager.default.fileExists(atPath: logs.path) {
            NSWorkspace.shared.activateFileViewerSelecting([logs])
          } else {
            NSWorkspace.shared.open(logs.deletingLastPathComponent())
          }
        }
      }
    }
    .formStyle(.grouped)
  }
}

/// Install Command-Line Tool, with what is there now.
private struct CommandLineToolRow: View {
  private let tool = CommandLineTool.shared

  var body: some View {
    LabeledContent {
      switch tool.state {
      case .installed: Button("Remove") { tool.uninstall() }
      case .unavailable: EmptyView()
      case .notInstalled, .other: Button("Install…") { tool.install() }
      }
    } label: {
      Text("Command-line tool")
      Text(summary)
    }
    .onAppear { tool.refresh() }
  }

  private var summary: String {
    switch tool.state {
    case .installed: "vidvnc is installed in \(tool.link.deletingLastPathComponent().path)."
    case .notInstalled: "Run the server from Terminal with vidvnc, using the app's settings."
    case .other: "Another vidvnc command is installed in \(tool.link.deletingLastPathComponent().path)."
    case .unavailable: "Only installed copies of VidVNC include the command-line tool."
    }
  }
}

nonisolated extension Resolution: Comparable {
  static func < (a: Resolution, b: Resolution) -> Bool {
    (a.width * a.height, a.width) < (b.width * b.height, b.width)
  }
}

private struct AboutSettings: View {
  var model: any HostModel

  var body: some View {
    Form {
      Section {
        ForEach(model.versions) { LabeledContent($0.component, value: $0.version) }
      } footer: {
        Text("Server, Node.js and GStreamer versions appear once sharing has started.")
          .font(.callout).foregroundStyle(.secondary)
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
