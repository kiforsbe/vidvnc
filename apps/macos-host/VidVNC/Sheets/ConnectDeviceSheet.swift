import SwiftUI

/// Pick how the new device connects, then show its code, link and QR code.
struct ConnectDeviceSheet: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation
  @State private var kind: ConnectionCode.Kind = .sessionKey
  @State private var code: ConnectionCode?
  @State private var working = false
  @State private var error: String?

  /// What the current connection method allows: the session key only with that method, a
  /// one-time key unless only approved clients may connect, and a setup code always.
  private var kinds: [ConnectionCode.Kind] {
    switch model.connectionMethod {
    case .sessionKey: [.sessionKey, .oneTime, .clientSetup]
    case .oneTimeKeys: [.oneTime, .clientSetup]
    case .approvedOnly: [.clientSetup]
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Connect a Device").font(.title2.weight(.semibold))
      if let code {
        result(code)
      } else {
        chooser
      }
    }
    .padding(24)
    .frame(width: 480)
    .onAppear { kind = kinds.first ?? .clientSetup }
  }

  private var chooser: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Use Safari on your iPhone or iPad, or a browser on another device on this network.")
        .foregroundStyle(.secondary)
      Picker("Method", selection: $kind) {
        ForEach(kinds, id: \.self) { kind in Text(title(kind)).tag(kind) }
      }
      .pickerStyle(.radioGroup)
      .labelsHidden()
      Text(explanation(kind)).font(.callout).foregroundStyle(.secondary)
      if let error {
        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
      }
      HStack {
        Spacer()
        Button("Cancel") { presentation.sheet = nil }.keyboardShortcut(.cancelAction)
        Button("Continue") { load { try await model.makeConnectionCode(kind) } }
          .keyboardShortcut(.defaultAction)
          .disabled(working || model.viewerAddress == nil)
      }
    }
  }

  private func result(_ code: ConnectionCode) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Scan the code with the device's camera, or open the address and enter the code.")
        .foregroundStyle(.secondary)
      HStack(alignment: .top, spacing: 20) {
        QRCodeView(text: code.link).frame(width: 180, height: 180)
        VStack(alignment: .leading, spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text(code.kind == .clientSetup ? "Setup code" : "Key").font(.callout).foregroundStyle(.secondary)
            Text(code.code).font(.title3.monospaced()).textSelection(.enabled)
              .accessibilityIdentifier("connection-code")
          }
          if let address = model.viewerAddress {
            VStack(alignment: .leading, spacing: 2) {
              Text("Address").font(.callout).foregroundStyle(.secondary)
              CopyableText(text: address)
            }
          }
          if let expires = code.expires {
            Text("Works once, until \(expires.formatted(date: .omitted, time: .shortened)).")
              .font(.callout).foregroundStyle(.secondary)
          }
        }
      }
      if let error {
        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
      }
      HStack {
        Button("Back") { self.code = nil }
        if code.kind == .sessionKey {
          Button("New Key") { load { try await model.newSessionKey() } }
            .disabled(working)
            .help("Replace the session key. Devices using the old key can't sign in with it again.")
        }
        Spacer()
        Button("Done") { presentation.sheet = nil }.keyboardShortcut(.defaultAction)
      }
    }
  }

  private func load(_ make: @escaping () async throws -> ConnectionCode) {
    working = true
    error = nil
    Task {
      defer { working = false }
      do {
        code = try await make()
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  private func title(_ kind: ConnectionCode.Kind) -> String {
    switch kind {
    case .sessionKey: "Use the session key"
    case .oneTime: "Create a one-time key"
    case .clientSetup: "Approve this client"
    }
  }

  private func explanation(_ kind: ConnectionCode.Kind) -> String {
    switch kind {
    case .sessionKey: "Anyone on this network with the key can connect until you change it."
    case .oneTime: "The key works once, for a few minutes."
    case .clientSetup:
      "The device signs in with this code once and becomes an approved client, which can connect again without a key."
    }
  }
}

#Preview("Connect a Device – Light") {
  ConnectDeviceSheet(model: FakeHostModel())
    .environment(Presentation())
    .preferredColorScheme(.light)
}

#Preview("Connect a Device – Dark") {
  ConnectDeviceSheet(model: FakeHostModel())
    .environment(Presentation())
    .preferredColorScheme(.dark)
}
