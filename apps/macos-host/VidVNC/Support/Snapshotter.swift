import AppKit
import SwiftUI

/// Saves images of the app when it is launched with `-snapshotDir <path>`, then quits.
///
/// By default it saves light and dark images of every section, drawing the window into a
/// bitmap itself, so it needs no Screen Recording permission (`screenshots.sh`). With
/// `-snapshotStyle window` it instead saves the whole window as macOS shows it, sidebar and
/// title bar included, for every section, Connect a Device's QR code and each Settings tab
/// (`docs-screenshots.sh`). macOS gives those pixels only to an app allowed to record the
/// screen, so the script takes them: VidVNC writes a request line to standard output, and the
/// script answers on standard input once `screencapture` has saved the window.
@MainActor
enum Snapshotter {
  static var directory: URL? {
    UserDefaults.standard.string(forKey: "snapshotDir").map { URL(filePath: $0) }
  }

  private static var wholeWindow: Bool {
    UserDefaults.standard.string(forKey: "snapshotStyle") == "window"
  }

  /// In the whole-window style, Connect a Device skips its chooser and shows a code.
  static var showsConnectionCode: Bool { directory != nil && wholeWindow }

  static func run(presentation: Presentation, openSettings: OpenSettingsAction) async {
    guard let directory else { return }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try? await Task.sleep(for: .seconds(1))
    guard let window = NSApp.windows.first(where: { $0.isVisible && $0.styleMask.contains(.titled) })
    else { return }
    window.setContentSize(CGSize(width: 900, height: 760))
    if wholeWindow {
      await runWholeWindow(window, in: directory, presentation: presentation, openSettings: openSettings)
      return
    }
    let prefix = UserDefaults.standard.string(forKey: "snapshotPrefix") ?? ""
    for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
      NSApp.appearance = NSAppearance(named: appearance)
      for section in SidebarSection.allCases {
        presentation.section = section
        try? await Task.sleep(for: .milliseconds(700))
        let name = "\(prefix)\(section.rawValue)-\(suffix).png"
        save(window, to: directory.appending(path: name))
      }
    }
    NSApp.terminate(nil)
  }

  private static func runWholeWindow(
    _ window: NSWindow, in directory: URL, presentation: Presentation, openSettings: OpenSettingsAction
  ) async {
    let dark = UserDefaults.standard.string(forKey: "snapshotAppearance") == "dark"
    NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    // An app started from Terminal can't bring itself to the front, so the script opens it.
    _ = await ask("activate")
    try? await Task.sleep(for: .milliseconds(700))
    var failures: [String] = []
    func shoot(_ window: NSWindow, _ name: String) async {
      do {
        try await capture(window, to: directory.appending(path: "\(name).png"))
      } catch {
        failures.append("\(name): \(error.localizedDescription)")
      }
    }

    for section in SidebarSection.allCases {
      presentation.section = section
      try? await Task.sleep(for: .milliseconds(900))
      await shoot(window, section.rawValue)
    }

    presentation.section = .overview
    presentation.sheet = .connectDevice
    try? await Task.sleep(for: .milliseconds(1500))
    await shoot(window, "connect-device-qr")
    presentation.sheet = nil
    try? await Task.sleep(for: .milliseconds(700))

    openSettings()
    for tab in SettingsTab.allCases {
      presentation.settingsTab = tab
      try? await Task.sleep(for: .milliseconds(900))
      if let settings = NSApp.windows.first(where: {
        $0 !== window && $0.isVisible && $0.styleMask.contains(.titled)
      }) {
        await shoot(settings, "settings-\(tab.rawValue)")
      } else {
        failures.append("settings-\(tab.rawValue): the Settings window didn't open")
      }
    }

    if !failures.isEmpty {
      FileHandle.standardError.write(Data("VidVNC screenshots: \(failures.joined(separator: "\n"))\n".utf8))
      exit(1)
    }
    NSApp.terminate(nil)
  }

  /// Writes one request line for the script and waits for its answer.
  private static func ask(_ request: String) async -> String? {
    FileHandle.standardOutput.write(Data("\(request)\n".utf8))
    return await Task.detached { readLine() }.value
  }

  /// Has the script save the window as `screencapture` sees it: without the shadow, at the
  /// display's scale, the corners transparent. A sheet is drawn inside its window, so it shows.
  private static func capture(_ window: NSWindow, to url: URL) async throws {
    guard await ask("capture \(window.windowNumber) \(url.path)") == "ok" else {
      throw SnapshotError("screencapture failed")
    }
  }

  private struct SnapshotError: LocalizedError {
    var errorDescription: String?
    init(_ message: String) { errorDescription = message }
  }

  private static func save(_ window: NSWindow, to url: URL) {
    // The theme frame includes the title bar and toolbar as well as the content. The sidebar's
    // glass can't be drawn offscreen, so the image is cropped to the detail column.
    guard let view = window.contentView?.superview ?? window.contentView,
      let layer = view.layer
    else { return }
    let scale = window.backingScaleFactor
    let size = CGSize(width: view.bounds.width * scale, height: view.bounds.height * scale)
    guard
      let context = CGContext(
        data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return }
    context.scaleBy(x: scale, y: scale)
    if view.isFlipped {
      context.translateBy(x: 0, y: view.bounds.height)
      context.scaleBy(x: 1, y: -1)
    }
    window.effectiveAppearance.performAsCurrentDrawingAppearance {
      context.setFillColor(NSColor.windowBackgroundColor.cgColor)
    }
    context.fill(view.bounds)
    layer.render(in: context)
    guard var image = context.makeImage() else { return }
    if let split = findSplitView(in: view), let detail = split.subviews.filter({ $0.frame.width > 200 }).max(by: { $0.frame.minX < $1.frame.minX }) {
      let x = detail.convert(detail.bounds, to: view).minX * scale
      if let cropped = image.cropping(
        to: CGRect(x: x, y: 0, width: size.width - x, height: size.height))
      {
        image = cropped
      }
    }
    let rep = NSBitmapImageRep(cgImage: image)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
  }

  private static func findSplitView(in view: NSView) -> NSSplitView? {
    if let split = view as? NSSplitView, split.subviews.count > 1 { return split }
    for subview in view.subviews {
      if let found = findSplitView(in: subview) { return found }
    }
    return nil
  }
}
