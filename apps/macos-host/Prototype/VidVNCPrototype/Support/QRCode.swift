import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

/// A crisp QR code for `text`, drawn with Core Image.
struct QRCodeView: View {
  var text: String

  var body: some View {
    if let image = Self.makeImage(text) {
      Image(decorative: image, scale: 1)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .padding(10)
        .background(.white, in: .rect(cornerRadius: 8))
        .accessibilityLabel("QR code")
    } else {
      Image(systemName: "qrcode").resizable().scaledToFit().foregroundStyle(.secondary)
    }
  }

  static func makeImage(_ text: String) -> CGImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    return CIContext().createCGImage(output, from: output.extent)
  }
}
