// Generates the Windows host's notification-area (tray) icons: one SVG per state and
// taskbar theme, PNGs at 16, 20, 24 and 32 px, a multi-size .ico for each, and
// preview.png. Run from the repository root on a Mac:
//   swift docs/design/windows-host-previz/tray/make-tray-icons.swift
//
// Each size is drawn on its own pixel grid with 1 px strokes on half-pixel centres, the way
// Windows 11's own tray glyphs are, so lines stay crisp at 100%, 125%, 150% and 200%.

import AppKit

let out = URL(filePath: "docs/design/windows-host-previz/tray")
let sizes = [16, 20, 24, 32]

enum Badge { case none, remote, controlling, attention, error }

struct State {
  var name: String
  var screenOn: Bool
  var badge: Badge
  var label: String
}

let states = [
  State(name: "off", screenOn: false, badge: .none, label: "Sharing off"),
  State(name: "sharing", screenOn: true, badge: .none, label: "Sharing"),
  State(name: "remote", screenOn: true, badge: .remote, label: "Remote access"),
  State(name: "controlling", screenOn: true, badge: .controlling, label: "Controlling"),
  State(name: "attention", screenOn: true, badge: .attention, label: "Needs attention"),
  State(name: "error", screenOn: false, badge: .error, label: "Stopped"),
]

// Glyph colours match the taskbar theme, like the system's own tray icons.
let themes = [("dark", "#FFFFFF"), ("light", "#1B1B1B")]
let amber = "#FCB900"
let red = "#E81123"

/// Builds the SVG for one state at one pixel size. Coordinates are in pixels.
func svg(_ state: State, size: Int, glyph: String) -> String {
  let s = Double(size)
  let u = s / 16  // one design unit
  let stroke = max(1, u.rounded(.down))
  // Odd stroke widths sit on half-pixel centres, even ones on whole pixels, so edges stay
  // on the pixel grid.
  let shift = stroke.truncatingRemainder(dividingBy: 2) == 1 ? 0.5 : 0
  func px(_ v: Double) -> Double { (v * u).rounded(.down) + shift }

  // Monitor: screen, neck and foot, leaving the lower-right corner for a badge.
  let left = px(0.6), right = px(14.6), top = px(2), bottom = px(11)
  let neckX = px(7.6)
  let foot = px(14)
  let footHalf = (3 * u).rounded()
  var body = """
    <rect x="\(left)" y="\(top)" width="\(right - left)" height="\(bottom - top)" rx="\(u)" fill="none" stroke="\(glyph)" stroke-width="\(stroke)"/>
    <path d="M\(neckX) \(bottom) V\(foot) M\(neckX - footHalf) \(foot) H\(neckX + footHalf)" fill="none" stroke="\(glyph)" stroke-width="\(stroke)"/>
    """
  if state.screenOn {
    // Share-screen arrow, as in Fluent's "Share screen" glyph.
    let tipY = px(4), baseY = px(9), head = (2 * u).rounded()
    body += """
      <path d="M\(neckX) \(baseY) V\(tipY) M\(neckX - head) \(tipY + head) L\(neckX) \(tipY) L\(neckX + head) \(tipY + head)" fill="none" stroke="\(glyph)" stroke-width="\(stroke)" stroke-linecap="square"/>
      """
  }

  // Badge in the lower-right corner, with a transparent gap cut around it.
  let cx = s - 3 * u, cy = s - 3 * u, r = 3 * u, gap = r + max(1, u)
  var badge = ""
  switch state.badge {
  case .none: break
  case .remote:
    badge = """
      <circle cx="\(cx)" cy="\(cy)" r="\(r - stroke / 2)" fill="none" stroke="\(glyph)" stroke-width="\(stroke)"/>
      \(size < 20 ? "" : "<ellipse cx=\"\(cx)\" cy=\"\(cy)\" rx=\"\(r * 0.42)\" ry=\"\(r - stroke / 2)\" fill=\"none\" stroke=\"\(glyph)\" stroke-width=\"\(stroke)\"/>")
      <path d="M\(cx - r) \(cy) H\(cx + r)" stroke="\(glyph)" stroke-width="\(stroke)"/>
      """
  case .controlling:
    // Pointer arrow, tip at the top left of the badge area.
    let x = cx - r * 0.9, y = cy - r * 1.05, h = r * 2.1
    badge = """
      <path d="M\(x) \(y) L\(x) \(y + h) L\(x + h * 0.3) \(y + h * 0.72) L\(x + h * 0.55) \(y + h) L\(x + h * 0.7) \(y + h * 0.9) L\(x + h * 0.48) \(y + h * 0.62) L\(x + h * 0.82) \(y + h * 0.62) Z" fill="\(glyph)"/>
      """
  case .attention:
    badge = "<circle cx=\"\(cx)\" cy=\"\(cy)\" r=\"\(r * 0.8)\" fill=\"\(amber)\"/>"
  case .error:
    let d = r * 0.42
    badge = """
      <circle cx="\(cx)" cy="\(cy)" r="\(r)" fill="\(red)"/>
      <path d="M\(cx - d) \(cy - d) L\(cx + d) \(cy + d) M\(cx + d) \(cy - d) L\(cx - d) \(cy + d)" stroke="#FFFFFF" stroke-width="\(stroke)" stroke-linecap="round"/>
      """
  }

  let masked: String
  if state.badge == .none {
    masked = body
  } else {
    masked = """
      <mask id="cut"><rect width="\(size)" height="\(size)" fill="#fff"/><circle cx="\(cx)" cy="\(cy)" r="\(gap)" fill="#000"/></mask>
      <g mask="url(#cut)">\(body)</g>
      \(badge)
      """
  }
  return """
    <svg xmlns="http://www.w3.org/2000/svg" width="\(size)" height="\(size)" viewBox="0 0 \(size) \(size)">
    \(masked)
    </svg>

    """
}

func render(_ svgText: String, size: Int) -> NSBitmapImageRep {
  let image = NSImage(data: Data(svgText.utf8))!
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: size, height: size)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
  NSGraphicsContext.restoreGraphicsState()
  return rep
}

/// A .ico whose entries are PNGs (supported since Windows Vista).
func ico(_ pngs: [(Int, Data)]) -> Data {
  var data = Data()
  func u16(_ v: Int) { data.append(contentsOf: [UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF)]) }
  func u32(_ v: Int) { u16(v & 0xFFFF); u16(v >> 16 & 0xFFFF) }
  u16(0); u16(1); u16(pngs.count)
  var offset = 6 + 16 * pngs.count
  for (size, png) in pngs {
    data.append(UInt8(size % 256)); data.append(UInt8(size % 256))
    data.append(0); data.append(0)
    u16(1); u16(32); u32(png.count); u32(offset)
    offset += png.count
  }
  for (_, png) in pngs { data.append(png) }
  return data
}

try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
var previews: [String: [String: NSBitmapImageRep]] = [:]
for (theme, glyph) in themes {
  for state in states {
    var entries: [(Int, Data)] = []
    for size in sizes {
      let text = svg(state, size: size, glyph: glyph)
      let rep = render(text, size: size)
      let png = rep.representation(using: .png, properties: [:])!
      entries.append((size, png))
      previews["\(theme)-\(state.name)", default: [:]]["\(size)"] = rep
      if size == 16 {
        try text.write(to: out.appending(path: "vidvnc-\(state.name)-\(theme).svg"), atomically: true, encoding: .utf8)
      }
    }
    try ico(entries).write(to: out.appending(path: "vidvnc-\(state.name)-\(theme).ico"))
  }
}

// Preview sheet: each theme on its taskbar colour, every state at every size, magnified 4×
// with nearest-neighbour scaling so individual pixels are visible.
let zoom = 4, cell = 32 * zoom + 24, labelHeight = 28
let width = 120 + states.count * cell
let rowHeight = sizes.count * (32 * zoom / 2 + 12) + 12
let height = labelHeight + themes.count * rowHeight
let sheet = NSImage(size: NSSize(width: width, height: height))
sheet.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let font = NSFont.systemFont(ofSize: 13)
for (i, state) in states.enumerated() {
  (state.label as NSString).draw(
    at: NSPoint(x: 120 + i * cell, y: height - labelHeight + 6),
    withAttributes: [.font: font, .foregroundColor: NSColor.black])
}
for (t, (theme, _)) in themes.enumerated() {
  let top = height - labelHeight - t * rowHeight
  let bg = theme == "dark" ? NSColor(white: 0.13, alpha: 1) : NSColor(white: 0.93, alpha: 1)
  bg.setFill()
  NSRect(x: 0, y: top - rowHeight, width: width, height: rowHeight).fill()
  let fg = theme == "dark" ? NSColor.white : NSColor.black
  var y = top - 12
  for size in sizes {
    let h = size * zoom / 2
    y -= h
    ("\(theme) \(size) px" as NSString).draw(
      at: NSPoint(x: 10, y: y + h / 2 - 8), withAttributes: [.font: font, .foregroundColor: fg])
    for (i, state) in states.enumerated() {
      let rep = previews["\(theme)-\(state.name)"]!["\(size)"]!
      NSGraphicsContext.current?.imageInterpolation = .none
      rep.draw(in: NSRect(x: 120 + i * cell, y: y, width: h, height: h), from: .zero,
        operation: .sourceOver, fraction: 1, respectFlipped: false, hints: [.interpolation: NSImageInterpolation.none.rawValue])
      // Actual size beside the magnified one.
      rep.draw(in: NSRect(x: 120 + i * cell + h + 10, y: y, width: size, height: size), from: .zero,
        operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
    }
    y -= 12
  }
}
sheet.unlockFocus()
let tiff = sheet.tiffRepresentation!
try NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
  .write(to: out.appending(path: "preview.png"))
print("Wrote \(states.count * themes.count) icons and preview.png to \(out.path)")
