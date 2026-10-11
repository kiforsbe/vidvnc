import SwiftUI

/// The menu bar window: state, address, connected devices and the main actions.
struct MenuBarContent: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation
  @Environment(\.openWindow) private var openWindow
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let status = HostStatus(model)
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        StatusDot(color: status.color)
        Text(status.summary).font(.headline)
      }
      if let address = model.viewerAddress {
        CopyableText(text: address).font(.callout)
      }
      if let issue = model.issues.first {
        Text(issue.detail).font(.callout).foregroundStyle(.secondary)
      }

      if !model.clients.isEmpty {
        Divider()
        Text("Connected Devices").font(.callout).foregroundStyle(.secondary)
        ForEach(model.clients) { client in
          HStack {
            Image(systemName: client.kind.symbol).frame(width: 18)
            Text(client.name)
            if client.isControlling {
              Image(systemName: "cursorarrow.rays").foregroundStyle(.tint)
                .help("Controlling")
            }
            Spacer()
            Button("Disconnect") { model.disconnect(client.id) }.controlSize(.small)
          }
        }
      }

      Divider()
      VStack(alignment: .leading, spacing: 2) {
        if model.isSharing || model.sharing == .stopping {
          MenuButton("Stop Sharing") { model.stopSharing() }
            .disabled(model.sharing == .stopping)
        } else {
          MenuButton("Start Sharing") { start(remoteAccess: false) }
          MenuButton("Start with Remote Access") { start(remoteAccess: true) }
        }
        MenuButton("Connect a Device\u{2026}") { openMain(sheet: .connectDevice) }
          .disabled(model.viewerAddress == nil)
        if let action = model.issues.first?.action, let title = model.issues.first?.actionTitle {
          MenuButton(title) {
            openMain(sheet: nil)
            presentation.handle(action, model: model)
          }
        }
      }
      Divider()
      VStack(alignment: .leading, spacing: 2) {
        MenuButton("Open VidVNC") { openMain(sheet: nil) }
        MenuButton("Quit VidVNC") { NSApp.terminate(nil) }
      }
    }
    .padding(14)
    .frame(width: 300)
  }

  private func start(remoteAccess: Bool) {
    if model.hasSeenPermissionsIntro, model.permissions[.screenRecording] == .granted {
      model.startSharing(remoteAccess: remoteAccess)
    } else {
      // The introduction and any macOS question need the window.
      openMain(sheet: nil)
      presentation.requestStart(model, remoteAccess: remoteAccess)
    }
  }

  private func openMain(sheet: SheetKind?) {
    dismiss()
    NSApp.setActivationPolicy(.regular)
    openWindow(id: "main")
    NSApp.activate()
    if let sheet { presentation.sheet = sheet }
  }
}

/// A full-width, left-aligned borderless button like a menu item.
private struct MenuButton: View {
  var title: String
  var action: () -> Void
  @State private var hovering = false
  @Environment(\.isEnabled) private var isEnabled

  init(_ title: String, action: @escaping () -> Void) {
    self.title = title
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      Text(title)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
          hovering && isEnabled ? AnyShapeStyle(.selection) : AnyShapeStyle(.clear),
          in: .rect(cornerRadius: 5)
        )
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

#Preview("Menu Bar – Light") {
  MenuBarContent(model: FakeHostModel(scenario: .controlling))
    .environment(Presentation())
    .preferredColorScheme(.light)
}

#Preview("Menu Bar – Dark") {
  MenuBarContent(model: FakeHostModel(scenario: .approvalRequest))
    .environment(Presentation())
    .preferredColorScheme(.dark)
}
