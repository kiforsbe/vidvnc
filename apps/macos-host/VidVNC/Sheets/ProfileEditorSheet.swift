import SwiftUI

/// Edits one streaming profile, within the limits stream-policy.mjs enforces.
struct ProfileEditorSheet: View {
  @State var profile: StreamProfile
  var isNew: Bool
  var save: (StreamProfile) -> Void
  @Environment(\.dismiss) private var dismiss

  /// Output sizes grouped by aspect family, largest first (as the Windows host's editor).
  static let sizes: [Resolution] = [
    (3840, 2160), (2560, 1440), (1920, 1080), (1600, 900), (1366, 768), (1280, 720), (960, 540),
    (854, 480), (2560, 1600), (1920, 1200), (1680, 1050), (2560, 1080), (3440, 1440), (1024, 768),
  ].map { Resolution(width: $0.0, height: $0.1) }
  static let frameRates = [15, 24, 30, 60]
  static let heights = [480, 540, 720, 900, 1080, 1200, 1440, 2160]
  static let widths = [854, 1280, 1600, 1920, 2560, 3840]

  /// What the chosen sizing does to a screen whose shape differs from the profile's.
  static func sizeHelp(_ profile: StreamProfile) -> String {
    switch profile.sizing {
    case "height", "width":
      "The other side follows the shared screen's shape, so the picture has no bars."
    case "scale":
      "The shared screen's own size, scaled. On a Mac that is its size in points; 200% gives a Retina screen's full resolution."
    default:
      switch profile.aspect {
      case "keep": "The screen keeps its shape inside this size, so the stream can be narrower or shorter."
      case "stretch": "The screen fills this size exactly, even if that distorts it."
      default: "The screen keeps its shape, with black bars where it doesn't fill this size."
      }
    }
  }

  private var size: Binding<Resolution> {
    Binding(
      get: { Resolution(width: profile.width, height: profile.height) },
      set: {
        profile.width = $0.width
        profile.height = $0.height
      })
  }

  var body: some View {
    VStack(spacing: 0) {
      Form {
        TextField("Name", text: $profile.name)
        TextField("Description", text: $profile.description, prompt: Text("Optional"))
        Toggle("Available to viewers", isOn: $profile.enabled)
        Picker("Size", selection: $profile.sizing) {
          Text("Fixed height").tag("height")
          Text("Fixed width").tag("width")
          Text("Percentage of the screen").tag("scale")
          Text("Fixed width and height").tag("fixed")
        }
        switch profile.sizing {
        case "height":
          Picker("Height", selection: $profile.height) {
            let heights = Self.heights.contains(profile.height) ? Self.heights : [profile.height] + Self.heights
            ForEach(heights, id: \.self) { Text("\($0) pixels").tag($0) }
          }
        case "width":
          Picker("Width", selection: $profile.width) {
            let widths = Self.widths.contains(profile.width) ? Self.widths : [profile.width] + Self.widths
            ForEach(widths, id: \.self) { Text("\($0) pixels").tag($0) }
          }
        case "scale":
          Stepper(value: $profile.scalePercent, in: 10...400, step: 5) {
            LabeledContent("Percentage", value: "\(profile.scalePercent)%")
          }
        default:
          Picker("Output size", selection: size) {
            let sizes = Self.sizes.contains(size.wrappedValue) ? Self.sizes : [size.wrappedValue] + Self.sizes
            ForEach(sizes, id: \.self) { Text("\($0.width) \u{00D7} \($0.height)").tag($0) }
          }
          Picker("Screen shape", selection: $profile.aspect) {
            Text("Keep, no bars").tag("keep")
            Text("Keep, with bars").tag("fit")
            Text("Stretch to fill").tag("stretch")
          }
        }
        Text(Self.sizeHelp(profile))
          .font(.callout).foregroundStyle(.secondary)
        Picker("Frame rate", selection: $profile.fps) {
          let rates = Self.frameRates.contains(profile.fps) ? Self.frameRates : [profile.fps] + Self.frameRates
          ForEach(rates, id: \.self) { Text("\($0) fps").tag($0) }
        }
        LabeledContent("Bitrate") {
          HStack {
            TextField(
              "Bitrate", value: $profile.bitrateKbps, format: .number.grouping(.never), prompt: Text("4000")
            )
            .labelsHidden()
            .frame(width: 80)
            .multilineTextAlignment(.trailing)
            Text("kbit/s").foregroundStyle(.secondary)
          }
        }
        Picker("Bitrate mode", selection: $profile.bitrateMode) {
          Text("Constant").tag("cbr")
          Text("Variable").tag("vbr")
        }
        Picker("Quality", selection: $profile.quality) {
          Text("Efficient").tag("efficient")
          Text("Balanced").tag("balanced")
          Text("High").tag("high")
        }
      }
      .formStyle(.grouped)
      if let problem {
        Text(problem).font(.callout).foregroundStyle(.red).padding(.horizontal, 20)
      }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button(isNew ? "Add" : "Save") {
          profile.name = profile.name.trimmingCharacters(in: .whitespacesAndNewlines)
          save(profile)
          dismiss()
        }
        .keyboardShortcut(.defaultAction)
        .disabled(problem != nil)
      }
      .padding(20)
    }
    .frame(width: 440)
  }

  private var problem: String? {
    let name = profile.name.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty || name.count > 64 { return "The name must be 1 to 64 characters." }
    if profile.description.count > 240 { return "The description must be at most 240 characters." }
    if !(100...50_000).contains(profile.bitrateKbps) {
      return "The bitrate must be from 100 to 50000 kbit/s."
    }
    return nil
  }
}

#Preview("Profile Editor – Light") {
  ProfileEditorSheet(profile: FakeHostModel().profiles[0], isNew: false) { _ in }
    .preferredColorScheme(.light)
}

#Preview("Profile Editor – Dark") {
  ProfileEditorSheet(profile: FakeHostModel().profiles[2], isNew: false) { _ in }
    .preferredColorScheme(.dark)
}
