import SwiftUI

struct ConnectionsView: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation
  @State private var confirmingDisconnect = false

  var body: some View {
    Form {
      Section {
        if model.pendingApprovals.isEmpty {
          Text("No devices are waiting.").foregroundStyle(.secondary)
        } else {
          ForEach(model.pendingApprovals) { request in
            HStack(spacing: 10) {
              Image(systemName: request.kind.symbol)
                .font(.title3).frame(width: 24).foregroundStyle(.secondary)
              VStack(alignment: .leading, spacing: 2) {
                Text(request.name)
                Text(
                  [request.detail, request.requestedAt.map { "asked \($0.formatted(.relative(presentation: .named)))" }]
                    .compactMap(\.self).filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
                )
                .font(.callout).foregroundStyle(.secondary)
              }
              Spacer()
              Button("Reject") { model.reject(request.id) }
              Button("Approve") { model.approve(request.id) }
                .buttonStyle(.borderedProminent)
            }
          }
        }
      } header: {
        Text("Needs Your Approval")
      } footer: {
        Text("Approved devices can connect again without a key, from the internet too when remote access is on.")
          .foregroundStyle(.secondary)
      }

      Section("Approved Clients") {
        if model.approvedClients.isEmpty {
          Text("No approved clients.").foregroundStyle(.secondary)
        }
        ForEach(model.approvedClients) { client in
          HStack(spacing: 10) {
            Image(systemName: client.kind.symbol)
              .font(.title3).frame(width: 24).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
              Text(client.name)
              Text(lastSeen(client)).font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Picker(
              "Keyboard and mouse",
              selection: bind({ client.permission }, { model.setPermission($0, for: client.id) })
            ) {
              ForEach(ClientPermission.allCases) { Text($0.title).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            .help("What \(client.name) may do with the keyboard and mouse")
            Button("Remove", systemImage: "minus.circle", role: .destructive) {
              model.removeApproved(client.id)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .help("Remove \(client.name)")
          }
        }
      }

      Section("Connect a Browser") {
        LabeledContent("Viewer address") {
          if let address = model.viewerAddress {
            CopyableText(text: address)
          } else {
            Text("Available while sharing").foregroundStyle(.secondary)
          }
        }
        HStack {
          Text("Open the address in Safari, Chrome or Edge on the other device.")
            .foregroundStyle(.secondary)
          Spacer()
          Button("Connect a Device\u{2026}") { presentation.sheet = .connectDevice }
            .disabled(model.viewerAddress == nil)
        }
      }

      Section {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Disconnect Ordinary Sessions")
            Text("Ends every session that isn't an approved client, at once. Devices can reconnect with a key.")
              .font(.callout).foregroundStyle(.secondary)
          }
          Spacer()
          Button("Disconnect\u{2026}", role: .destructive) { confirmingDisconnect = true }
            .disabled(model.clients.isEmpty)
        }
      }
    }
    .formStyle(.grouped)
    .alert("Disconnect all ordinary sessions?", isPresented: $confirmingDisconnect) {
      Button("Disconnect", role: .destructive) { model.disconnectOrdinarySessions() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Every device that isn't an approved client is disconnected immediately.")
    }
  }

  private func lastSeen(_ client: ApprovedClient) -> String {
    let seen =
      client.isConnected
      ? "Connected now"
      : client.lastSeen.map { "Last connected \($0.formatted(.relative(presentation: .named)))" }
    return [client.detail, seen].compactMap(\.self).filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
  }
}

#Preview("Connections – Light") {
  ConnectionsView(model: FakeHostModel(scenario: .approvalRequest))
    .environment(Presentation())
    .frame(width: 620, height: 700)
    .preferredColorScheme(.light)
}

#Preview("Connections – Dark") {
  ConnectionsView(model: FakeHostModel(scenario: .approvalRequest))
    .environment(Presentation())
    .frame(width: 620, height: 700)
    .preferredColorScheme(.dark)
}
