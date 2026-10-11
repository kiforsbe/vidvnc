import SwiftUI

/// Streaming profiles, what viewers may choose, the encoder and codecs: the Windows host's
/// Streaming profiles page.
struct StreamingView: View {
  var model: any HostModel
  @State private var selection: StreamProfile.ID?
  @State private var editing: Editing?
  @State private var pending: PendingChange?

  private struct Editing: Identifiable {
    var profile: StreamProfile
    var isNew: Bool
    var id: String { profile.id }
  }

  /// A change waiting for the owner to agree that connected devices reconnect.
  private struct PendingChange: Identifiable {
    let id = UUID()
    var change: (inout StreamPolicy) -> Void
  }

  static let resolutionChoices = [(960, 540), (1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)]
    .map { Resolution(width: $0.0, height: $0.1) }
  static let frameRateChoices = [15, 24, 30, 60]
  static let bitrateChoices = [1000, 2000, 4000, 6000, 8000, 12000, 20000]

  var body: some View {
    Form {
      Section {
        List(selection: $selection) {
          ForEach(model.profiles) { profile in
            HStack {
              Text(profile.name)
              if profile.id == model.defaultProfileID {
                Text("Default").font(.caption).foregroundStyle(.secondary)
              }
              if !profile.enabled {
                Text("Hidden").font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Text(
                "\(profile.width) \u{00D7} \(profile.height) \u{00B7} \(profile.fps) fps \u{00B7} \(Self.bitrate(profile.bitrateKbps))"
              )
              .foregroundStyle(.secondary)
            }
            .tag(profile.id)
            .contextMenu { Button("Edit\u{2026}") { editing = Editing(profile: profile, isNew: false) } }
          }
          .onMove { offsets, destination in
            change { $0.profiles.move(fromOffsets: offsets, toOffset: destination) }
          }
        }
        .frame(minHeight: 180)
        HStack(spacing: 4) {
          Button("Add", systemImage: "plus") {
            editing = Editing(profile: newProfile(), isNew: true)
          }
          Button("Remove", systemImage: "minus") {
            guard let id = selection else { return }
            change { policy in
              policy.profiles.removeAll { $0.id == id }
              if policy.defaultProfileId == id { policy.defaultProfileId = "auto" }
              policy.displayDefaults = policy.displayDefaults.filter { $0.value != id }
            }
            selection = nil
          }
          .disabled(selection == nil || model.profiles.filter(\.enabled).count <= 1)
          Spacer()
          Button("Edit\u{2026}") {
            if let profile = model.profiles.first(where: { $0.id == selection }) {
              editing = Editing(profile: profile, isNew: false)
            }
          }
          .disabled(selection == nil)
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
      } header: {
        Text("Profiles")
      } footer: {
        Text("Viewers pick from the available profiles. Drag to change their order.")
          .font(.callout).foregroundStyle(.secondary)
      }

      Section {
        Picker(
          "Viewers may choose",
          selection: bind({ model.clientMode }, { mode in change { $0.clientMode = mode } })
        ) {
          Text("Approved profiles only").tag("profiles")
          Text("Approved options").tag("options")
        }
        optionsMenu(
          "Output sizes", Self.resolutionChoices, model.allowedOptions.resolutions,
          title: { "\($0.width) \u{00D7} \($0.height)" }
        ) { values in change { $0.allowedOptions.resolutions = values } }
        optionsMenu(
          "Frame rates", Self.frameRateChoices, model.allowedOptions.frameRates, title: { "\($0) fps" }
        ) { values in change { $0.allowedOptions.frameRates = values } }
        optionsMenu(
          "Bitrates", Self.bitrateChoices, model.allowedOptions.bitratesKbps, title: Self.bitrate
        ) { values in change { $0.allowedOptions.bitratesKbps = values } }
      } header: {
        Text("Client Customization")
      } footer: {
        Text("With approved options, viewers combine any allowed size, frame rate and bitrate.")
          .font(.callout).foregroundStyle(.secondary)
      }

      Section {
        Picker(
          "Encoder", selection: bind({ model.encoderBackend }, { id in change { $0.encoderBackend = id } })
        ) {
          ForEach(model.availableEncoders) { Text($0.label).tag($0.id) }
        }
        ForEach(model.availableCodecs, id: \.self) { codec in
          Toggle(
            VideoCodec.title(codec),
            isOn: bind({ model.videoCodecs.contains(codec) }, { on in
              change { policy in
                if on {
                  // Keep the preferred order: AV1, then HEVC, then H.264.
                  policy.videoCodecs = VideoCodec.all.filter { policy.videoCodecs.contains($0) || $0 == codec }
                } else {
                  policy.videoCodecs.removeAll { $0 == codec }
                }
              }
            })
          )
          .disabled(codec == "h264")
        }
      } header: {
        Text("Encoding")
      } footer: {
        Text("H.264 always stays on, so every browser can play the stream.")
          .font(.callout).foregroundStyle(.secondary)
      }

      if !model.policyEditable {
        Text("Start sharing to change streaming settings.")
          .font(.callout).foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .disabled(!model.policyEditable)
    .sheet(item: $editing) { item in
      ProfileEditorSheet(profile: item.profile, isNew: item.isNew) { updated in
        change { policy in
          if let i = policy.profiles.firstIndex(where: { $0.id == updated.id }) {
            policy.profiles[i] = updated
          } else {
            policy.profiles.append(updated)
          }
        }
      }
    }
    .alert(
      "Apply streaming changes?", isPresented: bind({ pending != nil }, { if !$0 { pending = nil } }),
      presenting: pending
    ) { pending in
      Button("Apply") {
        model.updatePolicy(pending.change)
        self.pending = nil
      }
      Button("Cancel", role: .cancel) { self.pending = nil }
    } message: { _ in
      Text("Connected devices whose streams change reconnect to them.")
    }
  }

  private func change(_ change: @escaping (inout StreamPolicy) -> Void) {
    if model.clients.isEmpty {
      model.updatePolicy(change)
    } else {
      pending = PendingChange(change: change)
    }
  }

  /// A menu of check marks over the usual choices plus whatever the policy already allows.
  private func optionsMenu<Value: Hashable & Comparable>(
    _ label: String, _ choices: [Value], _ selected: [Value], title: @escaping (Value) -> String,
    set: @escaping ([Value]) -> Void
  ) -> some View {
    let all = Array(Set(choices + selected)).sorted()
    return LabeledContent(label) {
      Menu(selected.count == 1 ? title(selected[0]) : "\(selected.count) allowed") {
        ForEach(all, id: \.self) { value in
          Toggle(
            title(value),
            isOn: bind({ selected.contains(value) }, { on in
              let next = on ? (selected + [value]).sorted() : selected.filter { $0 != value }
              if !next.isEmpty { set(next) }
            }))
        }
      }
      .fixedSize()
    }
  }

  private func newProfile() -> StreamProfile {
    var number = model.profiles.count + 1
    while model.profiles.contains(where: { $0.id == "profile-\(number)" }) { number += 1 }
    return StreamProfile(
      id: "profile-\(number)", name: "New profile", description: "", enabled: true, width: 1920, height: 1080,
      fps: 30, bitrateKbps: 4000, bitrateMode: "cbr", quality: "balanced", frameDelivery: "fixed")
  }

  static func bitrate(_ kbps: Int) -> String {
    kbps >= 1000 && kbps % 100 == 0
      ? "\((Double(kbps) / 1000).formatted(.number.precision(.fractionLength(0...1)))) Mbit/s"
      : "\(kbps) kbit/s"
  }
}

#Preview("Streaming – Light") {
  StreamingView(model: FakeHostModel())
    .frame(width: 620, height: 800)
    .preferredColorScheme(.light)
}

#Preview("Streaming – Dark") {
  StreamingView(model: FakeHostModel())
    .frame(width: 620, height: 800)
    .preferredColorScheme(.dark)
}
