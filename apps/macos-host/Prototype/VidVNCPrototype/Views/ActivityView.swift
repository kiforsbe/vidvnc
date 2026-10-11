import Charts
import SwiftUI

struct ActivityView: View {
  var model: any HostModel
  @State private var expanded: Set<ConnectedClient.ID> = []

  var body: some View {
    Form {
      if model.clients.isEmpty {
        Section {
          ContentUnavailableView(
            "No Sessions", systemImage: "waveform.path.ecg",
            description: Text("Connected devices and their streams appear here."))
        }
      }
      ForEach(model.clients) { client in
        Section {
          DisclosureGroup(
            isExpanded: bind({ expanded.contains(client.id) }, { open in
              if open { expanded.insert(client.id) } else { expanded.remove(client.id) }
            })
          ) {
            ForEach(client.streams) { stream in
              StreamRow(stream: stream)
            }
          } label: {
            HStack(spacing: 10) {
              Image(systemName: client.kind.symbol)
                .font(.title3).frame(width: 24).foregroundStyle(.secondary)
              VStack(alignment: .leading, spacing: 2) {
                Text(client.name)
                Text(
                  "\(client.address) \u{00B7} \(client.streams.count == 1 ? "1 stream" : "\(client.streams.count) streams") \u{00B7} connected \(client.connectedAt.connectedDuration)"
                )
                .font(.callout).foregroundStyle(.secondary)
              }
              Spacer()
              if client.isControlling {
                Text("Controlling").font(.callout).foregroundStyle(.tint)
              } else {
                Button("Grant Control") { model.grantControl(client.id) }
                  .disabled(!model.inputAvailable)
              }
              Button("Disconnect") { model.disconnect(client.id) }
            }
          }
        }
      }
    }
    .formStyle(.grouped)
    .toolbar {
      ToolbarItem {
        Button("Diagnostics", systemImage: "stethoscope") {
          NSWorkspace.shared.open(URL(string: "\(model.viewerAddress)/diagnostics")!)
        }
        .help("Open Diagnostics in your browser")
      }
    }
    .onAppear { expanded = Set(model.clients.prefix(1).map(\.id)) }
  }
}

private struct StreamRow: View {
  var stream: StreamStats

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .top, spacing: 16) {
        details.frame(width: 190, alignment: .leading)
        FPSChart(samples: stream.samples).frame(minWidth: 280)
      }
      VStack(alignment: .leading, spacing: 8) {
        details
        FPSChart(samples: stream.samples)
      }
    }
    .padding(.vertical, 4)
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(stream.displayName).fontWeight(.medium)
      Text("\(stream.resolution) \u{00B7} \(stream.codec)")
        .font(.callout).foregroundStyle(.secondary)
      if let last = stream.samples.last {
        Text(
          last.capture.map { "\(Int($0.rounded())) fps captured" } ?? "No frames"
        )
        .font(.callout).foregroundStyle(.secondary).monospacedDigit()
      }
    }
  }
}

/// Capture, encode and decode frame rates over the last 60 seconds on one scale. Missing
/// samples are left as gaps.
struct FPSChart: View {
  var samples: [FPSSample]

  private struct Point: Identifiable {
    var id: String { "\(metric)-\(secondsAgo)" }
    var metric: String
    var segment: String
    var secondsAgo: Double
    var fps: Double
  }

  private var points: [Point] {
    let now = samples.last?.time ?? .now
    var result: [Point] = []
    let metrics: [(String, KeyPath<FPSSample, Double?>)] = [
      ("Capture", \.capture), ("Encode", \.encode), ("Decode", \.decode),
    ]
    for (name, path) in metrics {
      var segment = 0
      for sample in samples {
        guard let value = sample[keyPath: path] else {
          segment += 1
          continue
        }
        result.append(
          Point(
            metric: name, segment: "\(name)-\(segment)",
            secondsAgo: sample.time.timeIntervalSince(now), fps: value))
      }
    }
    return result
  }

  var body: some View {
    Chart(points) { point in
      LineMark(
        x: .value("Time", point.secondsAgo),
        y: .value("FPS", point.fps),
        series: .value("Segment", point.segment)
      )
      .foregroundStyle(by: .value("Metric", point.metric))
      .symbol(by: .value("Metric", point.metric))
      .symbolSize(0)
      .interpolationMethod(.monotone)
    }
    .chartForegroundStyleScale(["Capture": Color.blue, "Encode": Color.orange, "Decode": Color.green])
    .chartXScale(domain: -60...0)
    .chartYScale(domain: 0...40)
    .chartXAxis {
      AxisMarks(values: [-60, -45, -30, -15, 0]) { value in
        AxisGridLine()
        AxisValueLabel { Text("\(Int(abs(value.as(Double.self) ?? 0))) s") }
      }
    }
    .chartLegend(position: .top, alignment: .leading)
    .frame(height: 120)
    .accessibilityLabel("Frames per second over the last minute")
  }
}

#Preview("Activity – Light") {
  ActivityView(model: FakeHostModel())
    .frame(width: 720, height: 700)
    .preferredColorScheme(.light)
}

#Preview("Activity – Dark") {
  ActivityView(model: FakeHostModel(scenario: .controlling))
    .frame(width: 720, height: 700)
    .preferredColorScheme(.dark)
}
