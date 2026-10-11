import SwiftUI

/// Pick how the new device connects, then show its code, link and QR code.
struct ConnectDeviceSheet: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation
  @State private var method: ConnectionMethod = .sessionKey
  @State private var code: ConnectionCode?

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
    .frame(width: 460)
    .onAppear {
      method = model.remoteAccessEnabled ? .approvedOnly : model.connectionMethod
    }
  }

  private var chooser: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("How should the new device connect?").foregroundStyle(.secondary)
      Picker("Method", selection: $method) {
        Text("Use the session key").tag(ConnectionMethod.sessionKey)
        Text("Create a one-time key").tag(ConnectionMethod.oneTimeKeys)
        Text("Approve this client").tag(ConnectionMethod.approvedOnly)
      }
      .pickerStyle(.radioGroup)
      .labelsHidden()
      .disabled(model.remoteAccessEnabled)
      Text(method.explanation).font(.callout).foregroundStyle(.secondary)
      HStack {
        Spacer()
        Button("Cancel") { presentation.sheet = nil }.keyboardShortcut(.cancelAction)
        Button("Continue") { code = model.makeConnectionCode(for: method) }
          .keyboardShortcut(.defaultAction)
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
            Text("Code").font(.callout).foregroundStyle(.secondary)
            Text(code.code).font(.title3.monospaced()).textSelection(.enabled)
          }
          VStack(alignment: .leading, spacing: 2) {
            Text("Address").font(.callout).foregroundStyle(.secondary)
            CopyableText(text: model.viewerAddress)
          }
          if method == .oneTimeKeys {
            Text("This key works once.").font(.callout).foregroundStyle(.secondary)
          }
        }
      }
      HStack {
        Button("Back") { self.code = nil }
        Spacer()
        Button("Done") { presentation.sheet = nil }.keyboardShortcut(.defaultAction)
      }
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
