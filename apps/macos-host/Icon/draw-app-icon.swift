import AppKit
// Draws the VidVNC app icon: the Windows host's monitor glyph (Assets/VidVnc.ico), in white on
// a blue macOS tile, at 1024 points. VidVNC/Assets.xcassets/AppIcon.appiconset holds it scaled
// to each size:
//   swiftc -o /tmp/draw Icon/draw-app-icon.swift && /tmp/draw /tmp/icon-1024.png
//   for s in 16 32 64 128 256 512 1024; do sips -z $s $s /tmp/icon-1024.png --out <size file>; done
let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
  let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
  let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
  NSShadow().then { $0.shadowColor = .black.withAlphaComponent(0.3); $0.shadowBlurRadius = 20; $0.shadowOffset = NSSize(width: 0, height: -10); $0.set() }
  NSGradient(starting: NSColor(srgbRed: 0.27, green: 0.60, blue: 1.0, alpha: 1),
             ending: NSColor(srgbRed: 0.05, green: 0.38, blue: 0.93, alpha: 1))!.draw(in: shape, angle: 90)
  NSShadow().set()
  NSColor.white.setFill()
  NSColor.white.setStroke()
  // Glyph from the 256-unit Windows icon, scaled into the tile.
  let scale = 2.6, ox = 512 - 128 * scale, oy = 530 - 136 * scale
  func r(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> NSRect {
    NSRect(x: ox + x * scale, y: oy + y * scale, width: w * scale, height: h * scale)
  }
  let screen = NSBezierPath(roundedRect: r(40, 58, 176, 94), xRadius: 18 * scale, yRadius: 18 * scale)
  screen.lineWidth = 28 * scale
  screen.stroke()
  NSBezierPath(rect: r(113, 166, 30, 40)).fill()
  NSBezierPath(roundedRect: r(72, 203, 112, 25), xRadius: 12.5 * scale, yRadius: 12.5 * scale).fill()
  return true
}
extension NSShadow { func then(_ f: (NSShadow) -> Void) { f(self) } }
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(filePath: CommandLine.arguments[1]))
