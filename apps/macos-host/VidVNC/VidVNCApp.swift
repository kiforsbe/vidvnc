import SwiftUI

@main
struct VidVNCApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate
  @State private var presentation: Presentation
  @State private var scenario: Scenario

  /// The server-backed model, or in Debug builds launched with `-scenario <name>` (screenshots,
  /// UI design work) the sample one.
  private let model: any HostModel
  private let fake: FakeHostModel?

  init() {
    let presentation = Presentation()
    if let section = UserDefaults.standard.string(forKey: "section").flatMap(SidebarSection.init) {
      presentation.section = section
    }
    _presentation = State(initialValue: presentation)
    var fake: FakeHostModel?
    var initial = Scenario.localNetwork
    #if DEBUG
      if let name = UserDefaults.standard.string(forKey: "scenario"), let chosen = Scenario(rawValue: name) {
        initial = chosen
        fake = FakeHostModel(scenario: chosen)
      }
    #endif
    _scenario = State(initialValue: initial)
    self.fake = fake
    let model: any HostModel = fake ?? ServerHostModel()
    self.model = model
    AppDelegate.model = model
  }

  var body: some Scene {
    Window("VidVNC", id: "main") {
      MainWindow(model: model)
        .environment(presentation)
    }
    .defaultSize(width: 900, height: 700)
    .commands {
      if let fake {
        CommandMenu("Scenario") {
          Picker("Scenario", selection: $scenario) {
            ForEach(Scenario.allCases) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.inline)
          .labelsHidden()
          .onChange(of: scenario) { _, new in
            presentation.sheet = nil
            fake.apply(new)
          }
        }
      }
      CommandGroup(after: .sidebar) {
        ForEach(Array(SidebarSection.allCases.enumerated()), id: \.element) { index, section in
          Button(section.title) { presentation.section = section }
            .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
        }
      }
    }

    Settings {
      SettingsView(model: model)
        .environment(presentation)
    }

    MenuBarExtra {
      MenuBarContent(model: model)
        .environment(presentation)
    } label: {
      let status = HostStatus(model)
      Image(systemName: status.menuBarSymbol)
        .accessibilityLabel("VidVNC: \(status.summary)")
    }
    .menuBarExtraStyle(.window)
  }
}

/// Quit stops sharing first, so the server exits through its owner protocol rather than
/// noticing that its pipe has closed.
final class AppDelegate: NSObject, NSApplicationDelegate {
  static var model: (any HostModel)?

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let model = Self.model as? ServerHostModel, model.isSharing || model.sharing == .stopping else {
      return .terminateNow
    }
    Task {
      await model.shutdown()
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}
