import XCTest

/// Navigation against the stand-in server (apps/macos-host/tests/stand-in-server.mjs), like
/// the Windows host's tests/Navigation: every section opens, sharing starts and stops through
/// the owner protocol, and Connect a Device shows the server's key. Needs the development
/// manifest from `npm run prepare:host` for its Node.js path; captures nothing and asks for
/// no privacy permission.
final class NavigationTests: XCTestCase {
  private var scratch: URL!

  private static let repository = URL(filePath: #filePath).deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

  override func setUpWithError() throws {
    continueAfterFailure = false
    scratch = FileManager.default.temporaryDirectory.appending(path: "vidvnc-ui-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: scratch)
  }

  /// The development manifest with the stand-in as its server.
  private func manifest() throws -> String {
    let development = Self.repository.appending(path: "out/macos-host/Debug/runtime.json")
    guard let data = try? Data(contentsOf: development),
      var manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw XCTSkip("Run npm run prepare:host -- Debug first") }
    manifest["server"] = Self.repository.appending(path: "apps/macos-host/tests/stand-in-server.mjs").path
    let url = scratch.appending(path: "runtime.json")
    try JSONSerialization.data(withJSONObject: manifest).write(to: url)
    return url.path
  }

  private func launch(networks: Bool = false) throws -> XCUIApplication {
    let app = XCUIApplication()
    if networks { app.launchEnvironment["VIDVNC_STAND_IN_NETWORKS"] = "1" }
    app.launchEnvironment["VIDVNC_RUNTIME_MANIFEST"] = try manifest()
    app.launchEnvironment["VIDVNC_TEST_ASSUME_SCREEN_RECORDING"] = "1"
    app.launchArguments += [
      "-hasSeenPermissionsIntro", "YES", "-startSharing", "NO", "-ApplePersistenceIgnoreState", "YES",
    ]
    app.launch()
    return app
  }

  func testEverySectionOpens() throws {
    let app = try launch()
    let window = app.windows.firstMatch
    XCTAssertTrue(window.waitForExistence(timeout: 10))
    for section in ["Displays", "Streaming", "Connections", "Access", "Network", "Activity", "Permissions", "Overview"] {
      window.outlines.staticTexts[section].click()
      XCTAssertTrue(window.staticTexts[section].firstMatch.waitForExistence(timeout: 5), section)
    }
  }

  func testSharingStartsAndStopsThroughTheOwnerProtocol() throws {
    let app = try launch()
    let window = app.windows.firstMatch
    XCTAssertTrue(window.waitForExistence(timeout: 10))
    let toggle = window.descendants(matching: .any)["sharing-switch"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    toggle.click()
    XCTAssertTrue(window.staticTexts["Running \u{00B7} local network"].waitForExistence(timeout: 10))

    // The stand-in's session key, from the contract's ready example.
    window.buttons["Connect a Device\u{2026}"].firstMatch.click()
    let sheet = window.sheets.firstMatch
    XCTAssertTrue(sheet.waitForExistence(timeout: 5))
    sheet.buttons["Continue"].click()
    XCTAssertTrue(sheet.staticTexts["DHXY-8VCK"].waitForExistence(timeout: 5))
    sheet.buttons["Done"].click()

    // Activity lists the stand-in's session.
    window.outlines.staticTexts["Activity"].click()
    XCTAssertTrue(window.staticTexts["Browser client"].waitForExistence(timeout: 5))

    window.outlines.staticTexts["Overview"].click()
    toggle.click()
    XCTAssertTrue(window.staticTexts["Your Mac is private."].waitForExistence(timeout: 10))
  }

  /// A network the server hasn't been allowed on asks first (Q2), and Allow answers it.
  func testANewNetworkAsksBeforeSharingOnIt() throws {
    let app = try launch(networks: true)
    let window = app.windows.firstMatch
    XCTAssertTrue(window.waitForExistence(timeout: 10))
    window.descendants(matching: .any)["sharing-switch"].click()
    let sheet = window.sheets.firstMatch
    XCTAssertTrue(sheet.staticTexts["Share on This Network?"].waitForExistence(timeout: 10))
    sheet.buttons["Allow"].click()
    XCTAssertTrue(window.staticTexts["Running \u{00B7} local network"].waitForExistence(timeout: 10))
    XCTAssertFalse(window.staticTexts["A new network is waiting"].waitForExistence(timeout: 3))
    window.descendants(matching: .any)["sharing-switch"].click()
  }
}
