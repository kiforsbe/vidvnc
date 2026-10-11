import SwiftUI

@main
struct VidVNCPrototypeApp: App {
  /// The prototype's only concrete model. Everything below the scene level sees `HostModel`.
  @State private var fake: FakeHostModel
  @State private var presentation: Presentation
  @State private var scenario: Scenario

  init() {
    // UI-test and screenshot runs pick their starting state with `-scenario "Remote access"`.
    let name = UserDefaults.standard.string(forKey: "scenario")
    let initial = Scenario(rawValue: name ?? "") ?? .localNetwork
    _scenario = State(initialValue: initial)
    _fake = State(initialValue: FakeHostModel(scenario: initial))
    let presentation = Presentation()
    if let section = UserDefaults.standard.string(forKey: "section").flatMap(SidebarSection.init) {
      presentation.section = section
    }
    _presentation = State(initialValue: presentation)
  }

  var body: some Scene {
    Window("VidVNC", id: "main") {
      MainWindow(model: fake)
        .environment(presentation)
    }
    .defaultSize(width: 900, height: 700)
    .commands {
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
      CommandGroup(after: .sidebar) {
        ForEach(Array(SidebarSection.allCases.enumerated()), id: \.element) { index, section in
          Button(section.title) { presentation.section = section }
            .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
        }
      }
    }

    Settings {
      SettingsView(model: fake)
    }

    MenuBarExtra {
      MenuBarContent(model: fake)
        .environment(presentation)
    } label: {
      Image(systemName: HostStatus(fake).menuBarSymbol)
        .accessibilityLabel("VidVNC: \(HostStatus(fake).summary)")
    }
    .menuBarExtraStyle(.window)
  }
}
