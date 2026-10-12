// Draws the README's top image: the Windows and Mac apps' Overview pages over a gradient,
// light and dark, from the screenshots in docs/images (see docs/images/README.md).
//   swift tools/readme-hero.swift
// Writes docs/images/overview-light.png and docs/images/overview-dark.png. Runs on a Mac.
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let images = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  .appending(path: "docs/images")

func load(_ path: String) -> CGImage {
  guard let source = CGImageSourceCreateWithURL(images.appending(path: path) as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { fatalError("Can't read docs/images/\(path)") }
  return image
}

// Sizes in points. The Windows images are at 100 % scale, the Mac ones at 200 %, so the
// canvas is drawn at 1x and the Mac window is scaled down.
let canvas = CGSize(width: 1600, height: 1000)
let windowsFrame = CGRect(x: 56, y: 56, width: 986, height: 713)
let macFrame = CGRect(x: 644, y: 184, width: 900, height: 760)

for (theme, top, bottom) in [
  ("light", CGColor(srgbRed: 0.80, green: 0.88, blue: 1.00, alpha: 1), CGColor(srgbRed: 0.93, green: 0.84, blue: 0.98, alpha: 1)),
  ("dark", CGColor(srgbRed: 0.07, green: 0.11, blue: 0.24, alpha: 1), CGColor(srgbRed: 0.22, green: 0.10, blue: 0.30, alpha: 1)),
] {
  let windows = load("windows-host/overview-\(theme).png")
  let mac = load("macos-host/overview-\(theme).png")
  let context = CGContext(
    data: nil, width: Int(canvas.width), height: Int(canvas.height), bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.interpolationQuality = .high
  // Core Graphics starts at the bottom left; flip so frames read from the top.
  context.translateBy(x: 0, y: canvas.height)
  context.scaleBy(x: 1, y: -1)

  let gradient = CGGradient(colorsSpace: nil, colors: [top, bottom] as CFArray, locations: [0, 1])!
  context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: canvas.width, y: canvas.height), options: [])

  func draw(_ image: CGImage, in frame: CGRect, radius: CGFloat) {
    let shape = CGPath(roundedRect: frame, cornerWidth: radius, cornerHeight: radius, transform: nil)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: 18), blur: 48, color: CGColor(gray: 0, alpha: 0.35))
    context.addPath(shape)
    context.setFillColor(CGColor(gray: theme == "dark" ? 0.12 : 0.97, alpha: 1))
    context.fillPath()
    context.restoreGState()
    context.saveGState()
    context.addPath(shape)
    context.clip()
    // Undo the flip for the image itself, which is stored top row first.
    context.translateBy(x: frame.minX, y: frame.maxY)
    context.scaleBy(x: 1, y: -1)
    context.draw(image, in: CGRect(origin: .zero, size: frame.size))
    context.restoreGState()
  }
  draw(windows, in: windowsFrame, radius: 8)
  draw(mac, in: macFrame, radius: 16)

  let url = images.appending(path: "overview-\(theme).png")
  let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  guard CGImageDestinationFinalize(destination) else { fatalError("Can't write \(url.path)") }
  print("Saved \(url.path)")
}
