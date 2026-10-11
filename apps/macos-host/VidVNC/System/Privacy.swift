import ApplicationServices
import CoreGraphics
import Foundation
import Network

/// The privacy settings VidVNC needs, read live. Grants belong to VidVNC.app: the server and
/// the media worker it starts are covered by them (gate MG3), so the app's own answers are
/// the ones that matter.
///
/// Nothing here is called at launch except the read-only checks; every call that can make
/// macOS ask follows something the owner did (spec D5).
enum Privacy {
  static var screenRecordingAllowed: Bool {
    #if DEBUG
      // UI and process-tree tests run against a stand-in server that captures nothing.
      if ProcessInfo.processInfo.environment["VIDVNC_TEST_ASSUME_SCREEN_RECORDING"] == "1" { return true }
    #endif
    return CGPreflightScreenCaptureAccess()
  }

  /// Asks the first time; after that macOS only answers, without asking again.
  static func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }

  /// "Device Control & Data Access" is macOS 27's name for the Accessibility list.
  static var deviceControlAllowed: Bool { AXIsProcessTrusted() }

  /// Adds VidVNC to the list (switched off) and shows macOS's own prompt to open it.
  static func requestDeviceControl() {
    let prompt = "AXTrustedCheckOptionPrompt" as CFString
    _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
  }
}

/// Whether macOS lets VidVNC reach devices on the local network. There is no API to read the
/// setting, so this browses for VidVNC's own Bonjour type: macOS answers a denied app with
/// a policy error, and asks the owner the first time an app browses.
@MainActor
final class LocalNetworkProbe {
  enum Result { case allowed, denied, unknown }

  private var browser: NWBrowser?
  private var finish: ((Result) -> Void)?
  private var timeout: Task<Void, Never>?

  /// Calls `completion` once, within `seconds`.
  func run(seconds: Double = 4, completion: @escaping (Result) -> Void) {
    cancel()
    finish = completion
    let browser = NWBrowser(
      for: .bonjour(type: "_vidvnc._tcp", domain: "local."), using: NWParameters())
    browser.stateUpdateHandler = { [weak self] state in
      Task { @MainActor in self?.update(state) }
    }
    self.browser = browser
    browser.start(queue: .main)
    timeout = Task { [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      self?.complete(.unknown)
    }
  }

  private func update(_ state: NWBrowser.State) {
    switch state {
    case .ready:
      // Ready before the owner has answered too, so keep waiting for a denial a little.
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(1.5))
        self?.complete(.allowed)
      }
    case .waiting(let error), .failed(let error):
      if case .dns(let code) = error, code == -65570 {  // kDNSServiceErr_PolicyDenied
        complete(.denied)
      }
    default: break
    }
  }

  private func complete(_ result: Result) {
    guard let finish else { return }
    self.finish = nil
    cancel()
    finish(result)
  }

  func cancel() {
    timeout?.cancel()
    timeout = nil
    browser?.cancel()
    browser = nil
  }
}
