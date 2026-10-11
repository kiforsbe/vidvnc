import AppKit

/// Saves light and dark images of every section when the app is launched with
/// `-snapshotDir <path>`, then quits. It draws the window into a bitmap itself, so it needs
/// no Screen Recording permission. Used by `screenshots.sh`.
@MainActor
enum Snapshotter {
  static var directory: URL? {
    UserDefaults.standard.string(forKey: "snapshotDir").map { URL(filePath: $0) }
  }

  static func run(presentation: Presentation) async {
    guard let directory else { return }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try? await Task.sleep(for: .seconds(1))
    guard let window = NSApp.windows.first(where: { $0.isVisible && $0.styleMask.contains(.titled) })
    else { return }
    window.setContentSize(CGSize(width: 900, height: 760))
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
