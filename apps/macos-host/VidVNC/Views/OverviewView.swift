import SwiftUI

struct OverviewView: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation

  var body: some View {
    let status = HostStatus(model)
    Form {
      Section {
        HStack(spacing: 12) {
          Image(systemName: "display")
            .font(.title2)
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(.tint, in: .rect(cornerRadius: 8))
          VStack(alignment: .leading, spacing: 2) {
            Text("Screen Sharing").font(.headline)
            Text("Allow remote access to this Mac.").foregroundStyle(.secondary)
          }
          Spacer()
          Text("VidVNC").foregroundStyle(.secondary)
          Toggle(
            "VidVNC",
            isOn: bind({ model.isSharing }, { on in
              if on { presentation.requestStart(model) } else { model.stopSharing() }
            })
          )
          .toggleStyle(.switch)
          .labelsHidden()
          .disabled(model.sharing == .stopping)
          .accessibilityIdentifier("sharing-switch")
        }
        HStack(spacing: 8) {
          if model.sharing == .starting || model.sharing == .stopping {
            ProgressView().controlSize(.small)
          } else {
            StatusDot(color: status.color)
          }
          VStack(alignment: .leading, spacing: 2) {
            Text(status.statusLine).accessibilityIdentifier("sharing-status")
            if model.sharing == .off {
              Text(
                model.hasSeenPermissionsIntro
                  ? "Your Mac is private."
                  : "Turn on sharing to see and control this Mac from your other devices."
              )
              .font(.callout).foregroundStyle(.secondary)
            }
          }
          Spacer()
          Button("Connect a Device\u{2026}") { presentation.sheet = .connectDevice }
            .disabled(model.viewerAddress == nil)
        }
        ForEach(model.issues) { issue in
          IssueRow(issue: issue) { presentation.handle($0, model: model) }
        }
      }

      Section("Connection Details") {
        LabeledContent("Computer name", value: model.computerName)
        LabeledContent("Viewer address") {
          if let address = model.viewerAddress {
            CopyableText(text: address)
          } else {
            Text(model.sharing == .running ? "Waiting for HTTPS" : "Available while sharing")
              .foregroundStyle(.secondary)
          }
        }
        LabeledContent("Local hostname", value: model.hostname)
        if let remote = model.remoteAddress {
          LabeledContent("Remote access") { CopyableText(text: remote) }
        }
      }

      Section("Access") {
        NavigationRow(title: "Authentication", value: model.connectionMethod.title) {
          presentation.section = .access
        }
        NavigationRow(title: "Remote control", value: model.controlDefault.title) {
          presentation.section = .access
        }
        PermissionNavigationRow(kind: .screenRecording, model: model)
        PermissionNavigationRow(kind: .deviceControl, model: model)
      }

      Section {
        if model.clients.isEmpty {
          Text("No devices connected").foregroundStyle(.secondary)
        } else {
          ForEach(model.clients) { client in
            ClientRow(client: client) { model.disconnect(client.id) }
          }
        }
      } header: {
        HStack {
          Text("Connected Clients")
          Spacer()
          Button("View All") { presentation.section = .activity }
            .buttonStyle(.link)
            .font(.callout)
        }
      }

      Section("Displays") {
        Button {
          presentation.section = .displays
        } label: {
          HStack(spacing: 16) {
            DisplayArrangement(displays: model.displays, selection: nil)
              .frame(width: 140, height: 56)
            VStack(alignment: .leading, spacing: 2) {
              Text("\(model.displays.filter(\.isShared).count) of \(model.displays.count) displays shared")
              Text(model.displays.map(\.name).joined(separator: ", "))
                .font(.callout)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
      }
    }
    .formStyle(.grouped)
  }
}

/// Selectable text with a copy button beside it.
struct CopyableText: View {
  var text: String

  var body: some View {
    HStack(spacing: 6) {
      Text(text).textSelection(.enabled)
      Button("Copy", systemImage: "doc.on.doc") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.borderless)
      .help("Copy")
    }
  }
}

/// A row that moves to another section, with a value and a chevron.
struct NavigationRow<Accessory: View>: View {
  var title: String
  var value: String
  var action: () -> Void
  @ViewBuilder var accessory: Accessory

  init(
    title: String, value: String, action: @escaping () -> Void,
    @ViewBuilder accessory: () -> Accessory = { EmptyView() }
  ) {
    self.title = title
    self.value = value
    self.action = action
    self.accessory = accessory()
  }

  var body: some View {
    Button(action: action) {
      HStack {
        Text(title)
        Spacer()
        accessory
        Text(value).foregroundStyle(.secondary)
        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
  }
}

struct PermissionNavigationRow: View {
  var kind: PermissionKind
  var model: any HostModel
  @Environment(Presentation.self) private var presentation

  var body: some View {
    let state = model.permissions[kind] ?? .missing
    NavigationRow(title: kind.title, value: state.title) {
      presentation.section = .permissions
    } accessory: {
      Image(systemName: state.symbol).foregroundStyle(state.color)
    }
  }
}

struct IssueRow: View {
  var issue: HostIssue
  var perform: (HostIssue.Action) -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(
        systemName: issue.severity == .error
          ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill"
      )
      .foregroundStyle(issue.severity == .error ? .red : .orange)
      VStack(alignment: .leading, spacing: 2) {
        Text(issue.title).fontWeight(.medium)
        Text(issue.detail).font(.callout).foregroundStyle(.secondary)
      }
      Spacer()
      if let action = issue.action, let title = issue.actionTitle {
        Button(title) { perform(action) }
      }
    }
  }
}

struct ClientRow: View {
  var client: ConnectedClient
  var disconnect: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: client.kind.symbol)
        .font(.title3)
        .frame(width: 24)
        .foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text(client.name)
        Text("\(client.address) \u{00B7} connected \(client.connectedAt.connectedDuration)")
          .font(.callout)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if client.isControlling {
        Text("Controlling")
          .font(.caption.weight(.medium))
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(.tint.opacity(0.18), in: .capsule)
          .foregroundStyle(.tint)
      }
      Button("Disconnect", action: disconnect)
    }
  }
}

#Preview("Overview – Light") {
  OverviewView(model: FakeHostModel())
    .environment(Presentation())
    .frame(width: 620, height: 900)
    .preferredColorScheme(.light)
}

#Preview("Overview – Dark") {
  OverviewView(model: FakeHostModel(scenario: .remoteAccess))
    .environment(Presentation())
    .frame(width: 620, height: 900)
    .preferredColorScheme(.dark)
}
