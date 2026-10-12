import SwiftUI

struct MainWindow: View {
  var model: any HostModel
  @Environment(Presentation.self) private var presentation
  @Environment(\.openSettings) private var openSettings

  var body: some View {
    @Bindable var presentation = presentation
    NavigationSplitView {
      List(selection: bind({ Optional(presentation.section) }, { if let s = $0 { presentation.section = s } })) {
        ForEach(SidebarSection.allCases) { section in
          Label(section.title, systemImage: section.symbol)
            .badge(badge(for: section))
            .tag(section)
        }
      }
      .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
      .safeAreaInset(edge: .bottom) { SidebarFooter(model: model) }
    } detail: {
      SectionView(section: presentation.section, model: model)
        .navigationTitle(presentation.section.title)
        .toolbar {
          ToolbarItem(placement: .primaryAction) {
            Button("Help", systemImage: "questionmark.circle") {
              NSWorkspace.shared.open(
                URL(string: "https://github.com/kiforsbe/vidvnc#readme")!)
            }
            .help("VidVNC Help")
          }
        }
    }
    .frame(minWidth: 760, minHeight: 520)
    .task { await Snapshotter.run(presentation: presentation, openSettings: openSettings) }
    // Closing the window leaves VidVNC in the menu bar only: no Dock icon, and sharing keeps
    // running unless the person turned that off in Settings.
    .onAppear { NSApp.setActivationPolicy(.regular) }
    .onDisappear {
      if !model.keepSharingWhenWindowCloses { model.stopSharing() }
      NSApp.setActivationPolicy(.accessory)
    }
    .sheet(item: $presentation.sheet) { sheet in
      switch sheet {
      case .connectDevice: ConnectDeviceSheet(model: model)
      case .permissionsIntro: PermissionsIntroSheet(model: model)
      case .confirmNetwork(let id): ConfirmNetworkSheet(model: model, networkID: id)
      case .deviceControl: DeviceControlSheet(model: model)
      }
    }
    .onChange(of: model.pendingNetworks, initial: true) { presentation.networksChanged(model) }
    .onChange(of: presentation.sheet) { presentation.networksChanged(model) }
    .alert(
      model.alert?.title ?? "",
      isPresented: bind({ model.alert != nil }, { if !$0 { model.alert = nil } }),
      presenting: model.alert
    ) { _ in
      Button("OK") { model.alert = nil }
    } message: { alert in
      Text(alert.message)
    }
  }

  private func badge(for section: SidebarSection) -> Int {
    switch section {
    case .connections: model.pendingApprovals.count
    case .permissions:
      model.permissions.values.filter { $0 == .missing || $0 == .needsAttention }.count
    default: 0
    }
  }
}

struct SectionView: View {
  var section: SidebarSection
  var model: any HostModel

  var body: some View {
    switch section {
    case .overview: OverviewView(model: model)
    case .connections: ConnectionsView(model: model)
    case .access: AccessView(model: model)
    case .network: NetworkView(model: model)
    case .activity: ActivityView(model: model)
    case .displays: DisplaysView(model: model)
    case .streaming: StreamingView(model: model)
    case .permissions: PermissionsView(model: model)
    }
  }
}

struct SidebarFooter: View {
  var model: any HostModel

  var body: some View {
    let status = HostStatus(model)
    HStack(spacing: 8) {
      StatusDot(color: status.color)
      Text(status.summary)
        .font(.callout)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .accessibilityElement(children: .combine)
  }
}

#Preview("Window – Light") {
  MainWindow(model: FakeHostModel())
    .environment(Presentation())
    .preferredColorScheme(.light)
}

#Preview("Window – Dark") {
  MainWindow(model: FakeHostModel(scenario: .approvalRequest))
    .environment(Presentation())
    .preferredColorScheme(.dark)
}
