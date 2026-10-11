import SwiftUI

struct ProfileEditorSheet: View {
  @State var profile: StreamProfile
  var save: (StreamProfile) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      Form {
        TextField("Name", text: $profile.name)
        Picker("Maximum resolution", selection: $profile.maxResolution) {
          ForEach(["1280 × 720", "1920 × 1080", "2560 × 1440", "Native"], id: \.self) { Text($0) }
        }
        Picker("Frame rate", selection: $profile.frameRate) {
          ForEach([15, 24, 30, 60], id: \.self) { Text("\($0) fps").tag($0) }
        }
        Stepper(value: $profile.bitrateMbps, in: 1...80) {
          LabeledContent("Bitrate", value: "\(profile.bitrateMbps) Mbit/s")
        }
        Picker("Codec", selection: $profile.codec) {
          ForEach(["H.264", "HEVC", "AV1"], id: \.self) { Text($0) }
        }
      }
      .formStyle(.grouped)
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Save") {
          save(profile)
          dismiss()
        }
        .keyboardShortcut(.defaultAction)
        .disabled(profile.name.isEmpty)
      }
      .padding([.horizontal, .bottom], 20)
    }
    .frame(width: 420)
  }
}

#Preview("Profile Editor – Light") {
  ProfileEditorSheet(profile: FakeHostModel().profiles[0]) { _ in }
    .preferredColorScheme(.light)
}

#Preview("Profile Editor – Dark") {
  ProfileEditorSheet(profile: FakeHostModel().profiles[2]) { _ in }
    .preferredColorScheme(.dark)
}
