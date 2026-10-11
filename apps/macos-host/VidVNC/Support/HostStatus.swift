import SwiftUI

/// One summary of the host's state, shared by Overview, the sidebar footer and the menu bar
/// so they never disagree.
struct HostStatus {
  enum Tone { case off, busy, good, warning, error }

  var tone: Tone
  /// Short text for the sidebar footer and the menu bar header.
  var summary: String
  /// Status line under the Screen Sharing switch. Issues get their own rows below it.
  var statusLine: String
  var menuBarSymbol: String

  var color: Color {
    switch tone {
    case .off: .secondary
    case .busy: .orange
    case .good: .green
    case .warning: .orange
    case .error: .red
    }
  }

  @MainActor
  init(_ model: any HostModel) {
    let first = model.issues.first
    let attention = model.issues.contains { $0.id == "approval" || $0.id == "network" }

    switch model.sharing {
    case .off:
      tone = .off
      summary = "Sharing is off"
      statusLine = "Stopped"
      menuBarSymbol = "display"
    case .starting:
      tone = .busy
      summary = "Starting\u{2026}"
      statusLine = "Starting\u{2026}"
      menuBarSymbol = "display"
    case .stopping:
      tone = .busy
      summary = "Stopping\u{2026}"
      statusLine = "Stopping\u{2026}"
      menuBarSymbol = "display"
    case .stoppedUnexpectedly:
      tone = .error
      summary = "Sharing stopped unexpectedly"
      statusLine = "Stopped"
      menuBarSymbol = "exclamationmark.triangle"
    case .running:
      tone = .good
      if model.remoteAccessEnabled {
        summary = "Sharing with remote access"
        statusLine = "Running \u{00B7} local network and remote access"
        tone = .warning
        menuBarSymbol = "globe"
      } else {
        summary = "Sharing on local network"
        statusLine = "Running \u{00B7} local network"
        menuBarSymbol = "rectangle.on.rectangle"
      }
      if let controller = model.controllingClient {
        summary = "\(controller.name) is controlling"
        menuBarSymbol = "cursorarrow.rays"
      }
    }

    if let first {
      tone = first.severity == .error ? .error : .warning
      if model.sharing == .running || first.severity == .error || first.id == "network" {
        summary = first.title
      }
      if first.severity == .error { menuBarSymbol = "exclamationmark.triangle" }
    }
    if attention, menuBarSymbol != "exclamationmark.triangle" {
      menuBarSymbol =
        !model.pendingNetworks.isEmpty ? "wifi.exclamationmark" : "person.crop.circle.badge.questionmark"
    }
  }
}

/// The coloured dot used beside every status line.
struct StatusDot: View {
  var color: Color
  var body: some View {
    Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
  }
}

extension PermissionState {
  var color: Color {
    switch self {
    case .granted: .green
    case .needsAttention: .orange
    case .missing: .red
    case .notDetermined: .secondary
    }
  }

  var symbol: String {
    switch self {
    case .granted: "checkmark.circle.fill"
    case .needsAttention: "exclamationmark.circle.fill"
    case .missing: "xmark.circle.fill"
    case .notDetermined: "circle.dashed"
    }
  }
}

/// A two-way binding onto a model property. Views hold `any HostModel`, so `@Bindable` can't
/// reach it; this keeps the call sites short.
func bind<Value: Sendable>(
  _ get: @escaping @MainActor () -> Value, _ set: @escaping @MainActor (Value) -> Void
) -> Binding<Value> {
  Binding(
    get: { MainActor.assumeIsolated { get() } },
    set: { value in MainActor.assumeIsolated { set(value) } })
}

extension Date {
  /// "12 min", "1 h 4 min".
  var connectedDuration: String {
    let formatter = DateComponentsFormatter()
    formatter.allowedUnits = [.hour, .minute]
    formatter.unitsStyle = .abbreviated
    return formatter.string(from: max(60, Date().timeIntervalSince(self))) ?? ""
  }
}
