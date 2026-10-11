import SwiftUI

struct NetworkView: View {
  var model: any HostModel
  @State private var showingEnrolment = false
  @State private var newPublicName = ""

  var body: some View {
    Form {
      Section {
        ForEach(model.interfaces) { interface in
          LabeledContent {
            if interface.isLinkLocal {
              Text("Not offered (link-local)").foregroundStyle(.secondary)
            } else {
              Text(interface.address).textSelection(.enabled).monospacedDigit()
            }
          } label: {
            Label(interface.name, systemImage: interface.isLinkLocal ? "link" : "network")
          }
        }
      } header: {
        Text("Local Network")
      } footer: {
        Text("Viewers on these networks can reach this Mac. Link-local addresses aren't offered.")
          .font(.callout).foregroundStyle(.secondary)
      }

      Section("Confirmed Networks") {
        if model.confirmedNetworks.isEmpty {
          Text("No confirmed networks.").foregroundStyle(.secondary)
        }
        ForEach(model.confirmedNetworks) { network in
          HStack {
            Image(systemName: "wifi").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
              Text(network.name)
              Text("Confirmed \(network.confirmedAt.formatted(date: .abbreviated, time: .omitted))")
                .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            if network.name == model.currentNetwork {
              Text("Current").font(.callout).foregroundStyle(.secondary)
            }
            Button("Forget") { model.forgetNetwork(network.id) }
          }
        }
      }

      Section {
        Toggle(
          "Remote access",
          isOn: bind({ model.remoteAccessEnabled }, { model.setRemoteAccess($0) })
        )
        .toggleStyle(.switch)
        if model.remoteAccessEnabled {
          ForEach(model.publicNames, id: \.self) { name in
            LabeledContent("Public name") {
              HStack {
                Text(name).textSelection(.enabled)
                Button("Remove", systemImage: "minus.circle") {
                  model.publicNames.removeAll { $0 == name }
                }
                .labelStyle(.iconOnly).buttonStyle(.borderless)
              }
            }
          }
          HStack {
            TextField("Add public name", text: $newPublicName, prompt: Text("host.example.net"))
            Button("Add") {
              model.publicNames.append(newPublicName)
              newPublicName = ""
            }
            .disabled(newPublicName.isEmpty)
          }
        }
        TextField(
          "HTTPS port", value: bind({ model.httpsPort }, { model.httpsPort = $0 }),
          format: .number.grouping(.never))
        TextField(
          "Media port", value: bind({ model.mediaPort }, { model.mediaPort = $0 }),
          format: .number.grouping(.never))
      } header: {
        Text("Remote Access")
      } footer: {
        Text(
          "Remote access lets approved clients connect from outside your network through the names above. The media port defaults to 4384."
        )
        .font(.callout).foregroundStyle(.secondary)
      }

      Section("HTTPS") {
        LabeledContent("Certificate") {
          switch model.certificate {
          case .ready(let expires):
            Label(
              "Ready \u{00B7} expires \(expires.formatted(date: .abbreviated, time: .omitted))",
              systemImage: "checkmark.seal.fill"
            )
            .foregroundStyle(.green)
          case .notReady:
            Label("Not ready", systemImage: "exclamationmark.triangle.fill")
              .foregroundStyle(.orange)
          }
        }
        HStack {
          Spacer()
          Button("Regenerate") { model.regenerateCertificate() }
          Button("Show Enrolment QR Code\u{2026}") { showingEnrolment = true }
        }
      }
    }
    .formStyle(.grouped)
    .sheet(isPresented: $showingEnrolment) {
      EnrolmentSheet(address: model.viewerAddress)
    }
  }
}

private struct EnrolmentSheet: View {
  var address: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 16) {
      Text("Trust This Mac's Certificate").font(.title2.weight(.semibold))
      Text("Scan with the iPhone or iPad camera to install the certificate profile.")
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      QRCodeView(text: "\(address)/enrol").frame(width: 200, height: 200)
      Text("\(address)/enrol").font(.callout.monospaced()).textSelection(.enabled)
      HStack {
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 400)
  }
}

#Preview("Network – Light") {
  NetworkView(model: FakeHostModel())
    .frame(width: 620, height: 800)
    .preferredColorScheme(.light)
}

#Preview("Network – Dark") {
  NetworkView(model: FakeHostModel(scenario: .remoteAccess))
    .frame(width: 620, height: 800)
    .preferredColorScheme(.dark)
}
