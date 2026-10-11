import SwiftUI

struct AccessView: View {
  var model: any HostModel

  var body: some View {
    Form {
      Section {
        Picker(
          "Connection method",
          selection: bind({ model.connectionMethod }, { model.connectionMethod = $0 })
        ) {
          ForEach(ConnectionMethod.allCases) { Text($0.title).tag($0) }
        }
        .disabled(model.remoteAccessEnabled)
      } footer: {
        VStack(alignment: .leading, spacing: 4) {
          Text(model.connectionMethod.explanation)
          if model.remoteAccessEnabled {
            Label(
              "Remote access is on, so only approved clients can connect. Turn off remote access in Network to choose another method.",
              systemImage: "lock.fill")
          }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
      }

      Section {
        Picker(
          "Keyboard and mouse",
          selection: bind({ model.controlDefault }, { model.controlDefault = $0 })
        ) {
          ForEach(ControlDefault.allCases) { Text($0.title).tag($0) }
        }
      } footer: {
        Text(
          model.controlDefault == .requireApproval
            ? "Viewers can watch. You choose who may control this Mac."
            : "The first viewer to ask gets control while nobody else has it."
        )
        .font(.callout).foregroundStyle(.secondary)
      }

      Section {
        Stepper(
          value: bind({ model.maxConnectedDevices }, { model.maxConnectedDevices = $0 }),
          in: 1...8
        ) {
          LabeledContent("Maximum connected devices", value: "\(model.maxConnectedDevices)")
        }
        TextField(
          "Public login name",
          text: bind({ model.publicLoginName }, { model.publicLoginName = $0 }),
          prompt: Text("Name")
        )
      } footer: {
        Text("The login name is shown on the viewer's sign-in page. It is not a password.")
          .font(.callout).foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
  }
}

#Preview("Access – Light") {
  AccessView(model: FakeHostModel())
    .frame(width: 620, height: 520)
    .preferredColorScheme(.light)
}

#Preview("Access – Dark") {
  AccessView(model: FakeHostModel(scenario: .remoteAccess))
    .frame(width: 620, height: 520)
    .preferredColorScheme(.dark)
}
