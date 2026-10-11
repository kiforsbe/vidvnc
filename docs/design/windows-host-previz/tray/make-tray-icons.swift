// Generates the Windows host's notification-area (tray) icons. Run from the repository
// root on a Mac:
//   swift docs/design/windows-host-previz/tray/make-tray-icons.swift
//
// Follows the same conventions as the tray icons of kiforsbe/agenda, so both apps look alike
// in the notification area:
// - each size (16, 20, 24, 32, 40, 48, 64 px) is drawn separately, not resampled;
// - strokes are size/16 px wide, on the pixel grid, with anti-aliasing off, so a 16 px icon
//   is solid pixels rather than grey half-tones (only the monitor's corners are
//   anti-aliased, to soften them);
// - ink is white for a dark taskbar and RGB 26,26,26 for a light one, and the app swaps
//   between the two when the taskbar theme changes;
// - entries are uncompressed 32-bit DIBs, the layout Windows' own icons use.
//
// It writes one .ico per state and theme plus preview.png here, and the two icons the
// Windows host embeds today (apps/windows-host/Assets/VidVnc.tray-on-{dark,light}.ico,
// the "sharing" glyph).

import AppKit

let out = URL(filePath: "docs/design/windows-host-previz/tray")
let hostAssets = URL(filePath: "apps/windows-host/Assets")
let sizes = [16, 20, 24, 32, 40, 48, 64]

enum Badge { case none, remote, controlling, attention, error }

struct State {
  var name: String
  var arrow: Bool
  var badge: Badge
  var label: String
}

let states = [
  State(name: "off", arrow: false, badge: .none, label: "Sharing off"),
  State(name: "sharing", arrow: true, badge: .none, label: "Sharing"),
  State(name: "remote", arrow: true, badge: .remote, label: "Remote access"),
  State(name: "controlling", arrow: true, badge: .controlling, label: "Controlling"),
  State(name: "attention", arrow: true, badge: .attention, label: "Needs attention"),
  State(name: "error", arrow: false, badge: .error, label: "Stopped"),
]

struct RGB { var r, g, b: CGFloat }
let themes: [(String, RGB)] = [
  ("dark", RGB(r: 1, g: 1, b: 1)),
  ("light", RGB(r: 26 / 255, g: 26 / 255, b: 26 / 255)),
]
/// Opacity of the softened corner pixel at 1 px strokes (90/255).
let cornerAlpha: CGFloat = 90 / 255

/// The share of pixel (i, j), counted from the outer corner, that lies inside a circle of
/// `radius` centred `radius` pixels in from both edges, sampled 16×16 and rounded to a whole
/// alpha value so mirrored corners match exactly.
func cornerCoverage(_ i: Int, _ j: Int, radius: Int) -> CGFloat {
  let r = Double(radius), samples = 16
  var inside = 0
  for sy in 0..<samples {
    for sx in 0..<samples {
      let x = Double(i) + (Double(sx) + 0.5) / Double(samples)
      let y = Double(j) + (Double(sy) + 0.5) / Double(samples)
      if (x - r) * (x - r) + (y - r) * (y - r) <= r * r { inside += 1 }
    }
  }
  return (Double(inside) / Double(samples * samples) * 255).rounded() / 255
}
let amber = RGB(r: 252 / 255, g: 185 / 255, b: 0)
let red = RGB(r: 232 / 255, g: 17 / 255, b: 35 / 255)

func color(_ c: RGB) -> CGColor { CGColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1) }

/// Draws one state at one size, with y going down and no anti-aliasing.
func draw(_ state: State, size n: Int, ink: RGB) -> CGImage {
  let context = CGContext(
    data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.translateBy(x: 0, y: CGFloat(n))
  context.scaleBy(x: 1, y: -1)
  context.setShouldAntialias(false)
  context.setAllowsAntialiasing(false)

  // Everything is whole-pixel rectangles, so nothing depends on how a path rasterizes.
  let u = Double(n) / 16
  let k = max(1, n / 16)  // stroke width
  func r(_ v: Double) -> Int { Int(v.rounded()) }
  context.setFillColor(color(ink))
  func fill(_ x: Int, _ y: Int, _ w: Int, _ h: Int) {
    context.fill(CGRect(x: x, y: y, width: w, height: h))
  }

  // Monitor frame. Its outer width has the same parity as the stroke, so (width − stroke)
  // is even and every vertical stroke on the axis has one exact centre: the stand's stem,
  // the arrow's stem and the arrowhead all share it. When the canvas width has the wrong
  // parity the frame is one pixel narrower and the right-hand column stays empty, as in
  // many of Windows' own 16 px glyphs.
  let width = (n - k) % 2 == 0 ? n : n - 1
  let stemX = (width - k) / 2
  let top = r(u), bottom = r(12 * u)  // outer rows [top, bottom)
  fill(0, top, width, k)
  fill(0, bottom - k, width, k)
  fill(0, top, k, bottom - top)
  fill(width - k, top, k, bottom - top)
  // Near-square corners, like the monitor in Windows' network icon, and the only
  // anti-aliased pixels in the glyph. At 1 px strokes the corner pixel is faint ink. At
  // wider strokes the corner is rounded at single-pixel resolution, not in stroke-sized
  // blocks: each pixel of the stroke-sized corner square gets the share of it that lies
  // inside a quarter circle with the stroke's width as its radius.
  context.setBlendMode(.copy)
  for (cornerX, cornerY, flipX, flipY) in [
    (0, top, false, false), (width - k, top, true, false),
    (0, bottom - k, false, true), (width - k, bottom - k, true, true),
  ] {
    for i in 0..<k {
      for j in 0..<k {
        let alpha = k == 1 ? cornerAlpha : cornerCoverage(i, j, radius: k)
        context.setFillColor(CGColor(srgbRed: ink.r, green: ink.g, blue: ink.b, alpha: alpha))
        fill(cornerX + (flipX ? k - 1 - i : i), cornerY + (flipY ? k - 1 - j : j), 1, 1)
      }
    }
  }
  context.setBlendMode(.normal)
  context.setFillColor(color(ink))

  // Stand, also as in the network icon: a hollow neck of two legs on a wider foot. Their
  // widths get the frame's parity so they centre on the same axis.
  func centred(_ w: Int) -> Int { (width - w) % 2 == 0 ? w : w + 1 }
  let footY = min(r(14 * u), n - k)
  let neck = centred(r(5 * u)), neckX = (width - neck) / 2
  fill(neckX, bottom, k, footY - bottom)
  fill(neckX + neck - k, bottom, k, footY - bottom)
  let foot = centred(r(8 * u)), footX = (width - foot) / 2
  fill(footX, footY, foot, k)

  if state.arrow {
    // Share-screen arrow: a stem and a 45° head stepped one pixel at a time, centred in the
    // screen's interior with equal space above and below (any odd pixel goes below).
    let interiorTop = top + k, interiorBottom = bottom - k
    let length = r(5 * u)
    let tip = interiorTop + (interiorBottom - interiorTop - length) / 2
    fill(stemX, tip, k, length)
    let head = r(2 * u)
    for j in 1...head {
      fill(stemX - j, tip + j, k, k)
      fill(stemX + j, tip + j, k, k)
    }
  }

  try! checkSymmetry(context, size: n, width: width, what: "\(state.name) \(n) px")

  guard let pattern = badges[state.badge] else { return context.makeImage()! }

  // Badge in the lower-right corner: a 7×7 pixel pattern scaled by whole pixels (one per
  // stroke width), with a transparent gap of one stroke cut around it, like the check on
  // Windows' Safely Remove Hardware icon.
  let size = 7 * k, origin = n - size
  var cells: [(Int, Int, Character)] = []
  for (row, line) in pattern.enumerated() {
    for (column, mark) in line.enumerated() where mark != "." {
      cells.append((origin + column * k, origin + row * k, mark))
    }
  }
  context.setBlendMode(.clear)
  for (x, y, _) in cells {
    context.fill(CGRect(x: x - k, y: y - k, width: 3 * k, height: 3 * k))
  }
  context.setBlendMode(.normal)
  for (x, y, mark) in cells {
    let fill: RGB =
      switch mark {
      case "a": amber
      case "r": red
      case "w": RGB(r: 1, g: 1, b: 1)
      default: ink
      }
    context.setFillColor(color(fill))
    context.fill(CGRect(x: x, y: y, width: k, height: k))
  }
  return context.makeImage()!
}

struct AsymmetryError: Error, CustomStringConvertible {
  var description: String
}

/// Fails unless the glyph's ink is mirror-symmetric about the frame's vertical centre, pixel
/// for pixel, and nothing is drawn right of the frame. Runs before any badge is added.
func checkSymmetry(_ context: CGContext, size n: Int, width: Int, what: String) throws {
  let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
  let stride = context.bytesPerRow
  func alpha(_ x: Int, _ y: Int) -> UInt8 { pixels[y * stride + x * 4 + 3] }
  for y in 0..<n {
    for x in 0..<n {
      let mirrored = x < width ? alpha(width - 1 - x, y) : 0
      if alpha(x, y) != mirrored {
        throw AsymmetryError(description: "\(what): ink at (\(x), \(y)) has no mirror image")
      }
    }
  }
}

/// 7×7 badge patterns: `#` is the glyph's ink, `a` amber, `r` red, `w` white.
let badges: [Badge: [String]] = [
  .remote: [
    "..###..",
    ".#.#.#.",
    "#..#..#",
    "#######",
    "#..#..#",
    ".#.#.#.",
    "..###..",
  ],
  .controlling: [
    "#......",
    "##.....",
    "###....",
    "####...",
    "#####..",
    "##.##..",
    "#...##.",
  ],
  .attention: [
    "..aaa..",
    ".aaaaa.",
    "aaaaaaa",
    "aaaaaaa",
    "aaaaaaa",
    ".aaaaa.",
    "..aaa..",
  ],
  .error: [
    "..rrr..",
    ".rrrrr.",
    "rrwrwrr",
    "rrrwrrr",
    "rrwrwrr",
    ".rrrrr.",
    "..rrr..",
  ],
]

/// A 32-bit BGRA DIB icon entry: BITMAPINFOHEADER, bottom-up pixels, then the 1-bit AND mask.
func dib(_ image: CGImage) -> Data {
  let n = image.width
  var rgba = [UInt8](repeating: 0, count: n * n * 4)
  let context = CGContext(
    data: &rgba, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.draw(image, in: CGRect(x: 0, y: 0, width: n, height: n))
  var data = Data()
  func u16(_ v: Int) { data.append(contentsOf: [UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF)]) }
  func u32(_ v: Int) { u16(v & 0xFFFF); u16(v >> 16 & 0xFFFF) }
  let maskStride = ((n + 31) / 32) * 4
  u32(40); u32(n); u32(n * 2); u16(1); u16(32); u32(0); u32(n * n * 4 + maskStride * n)
  u32(0); u32(0); u32(0); u32(0)
  // The bitmap context's first row is the top row; DIB rows go bottom first.
  for y in (0..<n).reversed() {
    for x in 0..<n {
      let i = (y * n + x) * 4
      let a = rgba[i + 3]
      func un(_ c: UInt8) -> UInt8 { a == 0 ? 0 : UInt8(min(255, Int(c) * 255 / Int(a))) }
      data.append(contentsOf: [un(rgba[i + 2]), un(rgba[i + 1]), un(rgba[i]), a])
    }
  }
  for y in (0..<n).reversed() {
    var row = [UInt8](repeating: 0, count: maskStride)
    for x in 0..<n where rgba[(y * n + x) * 4 + 3] == 0 { row[x / 8] |= 0x80 >> UInt8(x % 8) }
    data.append(contentsOf: row)
  }
  return data
}

func ico(_ entries: [(Int, Data)]) -> Data {
  var data = Data()
  func u16(_ v: Int) { data.append(contentsOf: [UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF)]) }
  func u32(_ v: Int) { u16(v & 0xFFFF); u16(v >> 16 & 0xFFFF) }
  u16(0); u16(1); u16(entries.count)
  var offset = 6 + 16 * entries.count
  for (size, payload) in entries {
    data.append(UInt8(size)); data.append(UInt8(size)); data.append(0); data.append(0)
    u16(1); u16(32); u32(payload.count); u32(offset)
    offset += payload.count
  }
  for (_, payload) in entries { data.append(payload) }
  return data
}

try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
var images: [String: CGImage] = [:]
for (theme, ink) in themes {
  for state in states {
    var entries: [(Int, Data)] = []
    for size in sizes {
      let image = draw(state, size: size, ink: ink)
      images["\(theme)-\(state.name)-\(size)"] = image
      entries.append((size, dib(image)))
    }
    let file = ico(entries)
    try file.write(to: out.appending(path: "vidvnc-\(state.name)-\(theme).ico"))
    if state.name == "sharing" {
      try file.write(to: hostAssets.appending(path: "VidVnc.tray-on-\(theme).ico"))
    }
  }
}

// Preview: each theme on its taskbar colour, every state at 16–32 px magnified 8× with
// nearest-neighbour scaling, and at actual pixel size beside it.
let previewSizes = [16, 20, 24, 32]
let zoom = 8, labelHeight = 40, labelWidth = 220, gutter = 24
let cell = 32 * zoom + 32 + 2 * gutter
let width = labelWidth + states.count * cell
let rowHeight = previewSizes.reduce(0) { $0 + $1 * zoom + gutter } + gutter
let height = labelHeight + themes.count * rowHeight
let canvas = CGContext(
  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpace(name: CGColorSpace.sRGB)!,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
canvas.interpolationQuality = .none
canvas.setFillColor(CGColor(gray: 1, alpha: 1))
canvas.fill(CGRect(x: 0, y: 0, width: width, height: height))
let ns = NSGraphicsContext(cgContext: canvas, flipped: false)
NSGraphicsContext.current = ns
let font = NSFont.systemFont(ofSize: 22)
for (i, state) in states.enumerated() {
  (state.label as NSString).draw(
    at: NSPoint(x: labelWidth + i * cell, y: height - labelHeight + 8),
    withAttributes: [.font: font, .foregroundColor: NSColor.black])
}
for (t, (theme, _)) in themes.enumerated() {
  let top = height - labelHeight - t * rowHeight
  canvas.setFillColor(CGColor(gray: theme == "dark" ? 0.13 : 0.93, alpha: 1))
  canvas.fill(CGRect(x: 0, y: top - rowHeight, width: width, height: rowHeight))
  let fg = theme == "dark" ? NSColor.white : NSColor.black
  var y = top - gutter
  for size in previewSizes {
    let h = size * zoom
    y -= h
    ("\(theme) \(size) px" as NSString).draw(
      at: NSPoint(x: 16, y: y + h / 2 - 12), withAttributes: [.font: font, .foregroundColor: fg])
    for (i, state) in states.enumerated() {
      let image = images["\(theme)-\(state.name)-\(size)"]!
      canvas.draw(image, in: CGRect(x: labelWidth + i * cell, y: y, width: h, height: h))
      canvas.draw(image, in: CGRect(x: labelWidth + i * cell + h + gutter, y: y, width: size, height: size))
    }
    y -= gutter
  }
}
NSGraphicsContext.current = nil
try NSBitmapImageRep(cgImage: canvas.makeImage()!).representation(using: .png, properties: [:])!
  .write(to: out.appending(path: "preview.png"))
print("Wrote \(states.count * themes.count) icons, preview.png and the two host tray icons")
