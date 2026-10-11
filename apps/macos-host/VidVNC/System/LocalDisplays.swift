import AppKit
import CoreGraphics
import CryptoKit

/// The Mac's displays as the server names them, so the window can show them while sharing is
/// off and Identify can label the right screen.
enum LocalDisplays {
  /// The server's id for a display: SHA-256 of its UUID string, or of `display:<id>` when it
  /// has no UUID (platform/macos/displays.mm).
  static func serverID(_ display: CGDirectDisplayID) -> String {
    var identity = "display:\(display)"
    if let uuid = CGDisplayCreateUUIDFromDisplayID(display)?.takeRetainedValue(),
      let text = CFUUIDCreateString(nil, uuid) as String?
    {
      identity = text
    }
    return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
  }

  /// Every active display, ordered and numbered as the server orders them (by id).
  static func current() -> [DisplayRow] {
    let names = Dictionary(
      NSScreen.screens.compactMap { screen in displayID(of: screen).map { ($0, screen.localizedName) } },
      uniquingKeysWith: { first, _ in first })
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    let rows = ids.prefix(Int(count)).map { display in
      let bounds = CGDisplayBounds(display)
      return DisplayRow(
        id: serverID(display), name: names[display] ?? "Display", primary: CGDisplayIsMain(display) != 0,
        persistent: true, x: Int(bounds.minX), y: Int(bounds.minY), width: Int(bounds.width),
        height: Int(bounds.height), rotation: Int(CGDisplayRotation(display)), number: nil)
    }
    return rows.sorted { $0.id < $1.id }.enumerated().map { index, row in
      var row = row
      row.number = index + 1
      return row
    }
  }

  /// The screen showing the server's display `id`.
  static func screen(for id: String) -> NSScreen? {
    NSScreen.screens.first { screen in displayID(of: screen).map(serverID) == id }
  }
}
