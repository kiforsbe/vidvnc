import AppKit
import SwiftUI

/// Shows a numbered label near the bottom-left of every screen for three seconds, without
/// taking focus. Calling it again replaces the labels.
@MainActor
enum IdentifyOverlay {
  private static var panels: [NSPanel] = []
  private static var dismissTask: Task<Void, Never>?

  static func show() {
    dismiss()
    for (index, screen) in NSScreen.screens.enumerated() {
      let size = CGSize(width: 220, height: 96)
      let area = screen.visibleFrame
      let origin = CGPoint(x: area.minX + 24, y: area.minY + 24)
      let panel = NSPanel(
        contentRect: CGRect(origin: origin, size: size),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      panel.level = .statusBar
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.hasShadow = true
      panel.ignoresMouseEvents = true
      panel.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle]
      panel.contentView = NSHostingView(
        rootView: IdentifyLabel(number: index + 1, name: screen.localizedName))
      panel.orderFrontRegardless()
      panels.append(panel)
    }
    dismissTask = Task {
      try? await Task.sleep(for: .seconds(3))
      guard !Task.isCancelled else { return }
      dismiss()
    }
  }

  static func dismiss() {
    dismissTask?.cancel()
    panels.forEach { $0.orderOut(nil) }
    panels.removeAll()
  }
}

private struct IdentifyLabel: View {
  var number: Int
  var name: String

  var body: some View {
    HStack(spacing: 14) {
      Text("\(number)").font(.system(size: 48, weight: .semibold)).monospacedDigit()
      Text(name).font(.headline).lineLimit(2)
    }
    .foregroundStyle(.white)
    .padding(.horizontal, 20)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(.black.opacity(0.78), in: .rect(cornerRadius: 14))
    .environment(\.colorScheme, .dark)
  }
}
