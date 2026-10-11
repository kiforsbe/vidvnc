import SwiftUI

struct NetworkView: View {
  var model: any HostModel
  @State private var showingEnrolment = false
  @State private var confirmingRegenerate = false
  @State private var draft: RemoteDraft?
  @State private var newPublicName = ""
  @State private var saving = false
  @State private var formError: String?

  /// Remote access settings are edited together and saved with one button, as they all end
  /// up in the certificate and the router's port forwarding.
  private struct RemoteDraft: Equatable {
    var names: [String]
    var publicPort: String
    var mediaPort: String
  }

  private var saved: RemoteDraft {
    RemoteDraft(
      names: model.publicNames, publicPort: model.publicPort.map(String.init) ?? "",
      mediaPort: model.mediaPort.map(String.init) ?? "")
  }

  var body: some View {
    let current = draft ?? saved
    Form {
      Section {
        if model.interfaces.isEmpty {
          Text("This Mac isn't connected to a network.").foregroundStyle(.secondary)
        }
        ForEach(model.interfaces) { interface in
          LabeledContent {
            if interface.isLinkLocal {
              Text("Not offered (link-local)").foregroundStyle(.secondary)
            } else {
              HStack(spacing: 6) {
                Text(interface.address).textSelection(.enabled).monospacedDigit()
                if model.sharing == .running {
                  Image(systemName: interface.isServed ? "checkmark.circle.fill" : "minus.circle")
                    .foregroundStyle(interface.isServed ? .green : .secondary)
                    .help(interface.isServed ? "VidVNC listens here" : "VidVNC doesn't listen here")
                }
              }
            }
          } label: {
            Label("\(interface.name) (\(interface.bsdName))", systemImage: interface.isLinkLocal ? "link" : "network")
          }
        }
      } header: {
        Text("Local Network")
      } footer: {
        Text(
          "VidVNC listens on Wi-Fi and Ethernet ports with a private address, once you have allowed each network. VPNs, bridges and link-local addresses aren't offered."
        )
        .font(.callout).foregroundStyle(.secondary)
      }

      if !model.pendingNetworks.isEmpty {
        Section("Waiting for Your Answer") {
          ForEach(model.pendingNetworks) { network in
            HStack {
              Image(systemName: "wifi.exclamationmark").foregroundStyle(.orange)
              VStack(alignment: .leading, spacing: 2) {
                Text(network.title)
                Text(network.subnets).font(.callout).foregroundStyle(.secondary)
              }
              Spacer()
              Button("Don't Allow") { model.answerNetwork(network.id, allow: false) }
              Button("Allow") { model.answerNetwork(network.id, allow: true) }
            }
          }
        }
      }

      Section {
        Toggle(
          model.sharing == .running ? "Remote access" : "Start sharing with remote access",
          isOn: bind({ model.remoteAccessEnabled }, { model.setRemoteAccess($0) })
        )
        .toggleStyle(.switch)
        .disabled(!model.accessEditable || (model.sharing != .running && model.sharing != .off))
        ForEach(current.names, id: \.self) { name in
          LabeledContent("Public name") {
            HStack {
              Text(name).textSelection(.enabled)
              Button("Remove", systemImage: "minus.circle") {
                edit { $0.names.removeAll { $0 == name } }
              }
              .labelStyle(.iconOnly).buttonStyle(.borderless)
            }
          }
        }
        HStack {
          TextField("Add public name", text: $newPublicName, prompt: Text("vnc.example.com or 203.0.113.10"))
            .onSubmit(addName)
          Button("Add", action: addName).disabled(newPublicName.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        TextField(
          "Public HTTPS port", text: bind({ current.publicPort }, { value in edit { $0.publicPort = value } }),
          prompt: Text("Same as this Mac's"))
        TextField(
          "Media port (UDP)", text: bind({ current.mediaPort }, { value in edit { $0.mediaPort = value } }),
          prompt: Text("4384"))
        if let formError {
          Label(formError, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
        HStack {
          Spacer()
          Button("Revert") {
            draft = nil
            formError = nil
          }
          Button("Save") { save(current) }
            .keyboardShortcut(.defaultAction)
        }
        .disabled(draft == nil || draft == saved || saving || !model.accessEditable)
      } header: {
        Text("Remote Access")
      } footer: {
        VStack(alignment: .leading, spacing: 6) {
          Text(
            "Public names are what internet devices type to reach this Mac: your DNS name or your router's public address. They are added to this Mac's certificate. Set the public port only if the router forwards a different one, usually 443."
          )
          Text(
            "Forward the HTTPS port (TCP) and the media port (UDP) on the router to this Mac, never the plain HTTP port. With remote access on, only approved clients can sign in."
          )
          if model.remoteAccessEnabled {
            Text(
              "Check the source address once: connect from a phone on mobile data and open Activity. It must show a public address, not your router's."
            )
          }
        }
        .font(.callout).foregroundStyle(.secondary)
      }

      Section("HTTPS") {
        LabeledContent("Certificate") {
          switch model.https {
          case .ready(let expires):
            Label(
              expires.map { "Ready \u{00B7} expires \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "Ready",
              systemImage: "checkmark.seal.fill"
            )
            .foregroundStyle(.green)
          case .off:
            Label("Off: viewers use local HTTP", systemImage: "lock.open")
              .foregroundStyle(.secondary)
          case .notReady(let reason):
            Label(reason ?? (model.sharing == .running ? "Not ready" : "Ready when sharing starts"),
              systemImage: model.sharing == .running ? "exclamationmark.triangle.fill" : "clock")
              .foregroundStyle(model.sharing == .running ? .orange : .secondary)
          }
        }
        if let tls = model.tls {
          if let strategy = tls.strategy {
            LabeledContent("Source", value: Self.strategyTitle(strategy))
          }
          if let fingerprint = tls.fingerprint {
            LabeledContent("Fingerprint") {
              Text(fingerprint).font(.callout.monospaced()).textSelection(.enabled).multilineTextAlignment(.trailing)
            }
          }
          if let note = Self.enrolmentNote(tls.enrolmentStatus) {
            Text(note).font(.callout).foregroundStyle(.secondary)
          }
        }
        HStack {
          Spacer()
          Button("Regenerate\u{2026}") { confirmingRegenerate = true }
            .disabled(!canRegenerate)
          Button("Show Enrolment QR Code\u{2026}") { showingEnrolment = true }
            .disabled(model.enrolmentAddress == nil || model.sharing != .running)
        }
      }
    }
    .formStyle(.grouped)
    .sheet(isPresented: $showingEnrolment) {
      if let address = model.enrolmentAddress { EnrolmentSheet(address: address) }
    }
    .alert("Regenerate this Mac's certificate?", isPresented: $confirmingRegenerate) {
      Button("Regenerate", role: .destructive) { model.regenerateCertificate() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        model.tls?.strategy == "mkcert"
          ? "Your devices trust the mkcert local CA, so they don't need to enrol again."
          : "This Mac's certificate is its own trust anchor, so every device has to trust the new one again.")
    }
  }

  /// A generated certificate can be replaced; one the operator supplied never is.
  private var canRegenerate: Bool {
    guard model.sharing == .running, let tls = model.tls else { return false }
    return tls.mode != "off" && tls.mode != "provided" && tls.strategy != "provided"
  }

  static func strategyTitle(_ strategy: String) -> String {
    switch strategy {
    case "mkcert": "Your mkcert local CA (mkcert)"
    case "self-signed": "Self-signed by this Mac (self-signed)"
    case "provided": "The certificate you supplied (provided)"
    default: strategy
    }
  }

  static func enrolmentNote(_ status: String?) -> String? {
    switch status {
    case "required": "Each device installs this Mac's certificate once, then compares the fingerprint."
    case "not-required": "Devices already trust this certificate. There is nothing to install."
    case "unknown":
      "You supplied this certificate. If your devices trust its issuer there is nothing to do; otherwise install your own CA on them."
    default: nil
    }
  }

  private func edit(_ change: (inout RemoteDraft) -> Void) {
    var next = draft ?? saved
    change(&next)
    draft = next
  }

  /// Lowercase, without brackets or a trailing dot: the form the server stores.
  private func addName() {
    var name = newPublicName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if name.hasPrefix("["), name.hasSuffix("]") { name = String(name.dropFirst().dropLast()) }
    while name.hasSuffix(".") { name.removeLast() }
    newPublicName = ""
    guard !name.isEmpty else { return }
    edit { if !$0.names.contains(name) { $0.names.append(name) } }
  }

  private func save(_ form: RemoteDraft) {
    formError = nil
    let publicPort = form.publicPort.trimmingCharacters(in: .whitespaces)
    let mediaPort = form.mediaPort.trimmingCharacters(in: .whitespaces)
    var port: Int?
    if !publicPort.isEmpty {
      guard let value = Int(publicPort), (1...65535).contains(value) else {
        formError = "The public HTTPS port must be a number from 1 to 65535, or empty."
        return
      }
      port = value
    }
    var media: Int?
    if !mediaPort.isEmpty {
      guard let value = Int(mediaPort), (1024...65535).contains(value) else {
        formError = "The media port must be a number from 1024 to 65535, or empty for 4384."
        return
      }
      media = value
    }
    saving = true
    Task {
      defer { saving = false }
      do {
        try await model.saveRemoteSettings(publicNames: form.names, publicPort: port, mediaPort: media)
        draft = nil
      } catch {
        formError = error.localizedDescription
      }
    }
  }
}

private struct EnrolmentSheet: View {
  var address: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 16) {
      Text("Trust This Mac's Certificate").font(.title2.weight(.semibold))
      Text(
        "Scan this with the device you want to enrol. It opens this Mac's enrolment page, which explains what to install."
      )
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      QRCodeView(text: address).frame(width: 200, height: 200)
      Text(address).font(.callout.monospaced()).textSelection(.enabled)
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
    .frame(width: 620, height: 900)
    .preferredColorScheme(.light)
}

#Preview("Network – Dark") {
  NetworkView(model: FakeHostModel(scenario: .newNetwork))
    .frame(width: 620, height: 900)
    .preferredColorScheme(.dark)
}
