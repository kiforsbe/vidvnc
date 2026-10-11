import SwiftUI

/// Draws displays from their arrangement frames, scaled to fit. Tapping one selects it when a
/// selection binding is given.
struct DisplayArrangement: View {
  var displays: [DisplayInfo]
  var selection: Binding<DisplayInfo.ID?>?

  var body: some View {
    GeometryReader { proxy in
      let bounds = displays.map(\.frame).reduce(CGRect.null) { $0.union($1) }
      let gap: CGFloat = 4
      let scale = min(
        proxy.size.width / max(bounds.width, 1), proxy.size.height / max(bounds.height, 1))
      let offset = CGPoint(
        x: (proxy.size.width - bounds.width * scale) / 2,
        y: (proxy.size.height - bounds.height * scale) / 2)
      ZStack(alignment: .topLeading) {
        ForEach(Array(displays.enumerated()), id: \.element.id) { index, display in
          let rect = CGRect(
            x: (display.frame.minX - bounds.minX) * scale + offset.x + gap / 2,
            y: (display.frame.minY - bounds.minY) * scale + offset.y + gap / 2,
            width: display.frame.width * scale - gap,
            height: display.frame.height * scale - gap)
          tile(display, number: display.number, size: rect.size)
            .offset(x: rect.minX, y: rect.minY)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
    }
  }

  @ViewBuilder
  private func tile(_ display: DisplayInfo, number: Int, size: CGSize) -> some View {
    let selected = selection?.wrappedValue == display.id
    let shape = RoundedRectangle(cornerRadius: max(2, min(size.width, size.height) * 0.05))
    shape
      .fill(display.isShared ? AnyShapeStyle(.tint.opacity(0.28)) : AnyShapeStyle(.quaternary))
      .overlay {
        shape.strokeBorder(
          selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.separator), lineWidth: selected ? 3 : 1)
      }
      .overlay {
        if size.height > 40 {
          VStack(spacing: 2) {
            Text("\(number)").font(.title2.weight(.semibold))
            Text(display.name).font(.caption).lineLimit(1)
          }
          .padding(4)
        } else {
          Text("\(number)").font(.caption2.weight(.semibold))
        }
      }
      .frame(width: size.width, height: size.height)
      .contentShape(shape)
      .onTapGesture { selection?.wrappedValue = display.id }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(selection == nil ? [] : .isButton)
  }
}
