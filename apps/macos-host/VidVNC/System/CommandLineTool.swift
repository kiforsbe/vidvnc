import AppKit

/// Install Command-Line Tool (spec D9, Q10): links the app's own command-line server launcher,
/// `Contents/Helpers/vidvnc`, into `/usr/local/bin`, which `/etc/paths` puts on every Terminal
/// user's `PATH`. The command then runs the server inside this app, with the app's settings
/// and logs. Nothing changes until the owner confirms, and macOS asks for an administrator's
/// password only when the folder isn't writable.
@Observable final class CommandLineTool {
  enum State: Equatable {
    /// This build has no launcher: a development build, which runs your own Node.js.
    case unavailable
    case notInstalled
    case installed
    /// Something else is at the link's place: another copy of VidVNC, or a file.
    case other(String)
  }

  static let shared = CommandLineTool()

  let link: URL
  let launcher: URL
  private(set) var state: State = .unavailable

  init(
    link: URL = URL(filePath: "/usr/local/bin/vidvnc"),
    launcher: URL = Bundle.main.bundleURL.appending(path: "Contents/Helpers/vidvnc")
  ) {
    self.link = link
    self.launcher = launcher
    refresh()
  }

  func refresh() {
    let files = FileManager.default
    guard files.isExecutableFile(atPath: launcher.path) else {
      state = .unavailable
      return
    }
    if let target = try? files.destinationOfSymbolicLink(atPath: link.path) {
      let resolved = URL(filePath: target, relativeTo: link.deletingLastPathComponent())
      state =
        RuntimeManifest.resolve(resolved.path) == RuntimeManifest.resolve(launcher.path)
        ? .installed : .other(target)
    } else {
      state = files.fileExists(atPath: link.path) ? .other(link.path) : .notInstalled
    }
  }

  /// Asks first, then makes or replaces the link.
  func install() {
    refresh()
    guard state != .unavailable else { return }
    let alert = NSAlert()
    alert.messageText = "Install the vidvnc Command?"
    var detail =
      "VidVNC will link \(link.path) to the command-line server inside this app, so you can run vidvnc in Terminal. It uses the same settings and logs as the app."
    if case .other(let existing) = state {
      detail += "\n\nThis replaces the vidvnc command that is there now (\(existing))."
    }
    alert.informativeText = detail + "\n\nmacOS may ask for an administrator's password."
    alert.addButton(withTitle: "Install")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    change(
      direct: {
        let files = FileManager.default
        try files.createDirectory(at: self.link.deletingLastPathComponent(), withIntermediateDirectories: true)
        if (try? files.destinationOfSymbolicLink(atPath: self.link.path)) != nil || files.fileExists(atPath: self.link.path) {
          try files.removeItem(at: self.link)
        }
        try files.createSymbolicLink(at: self.link, withDestinationURL: self.launcher)
      },
      privileged: "mkdir -p \(Self.quoted(link.deletingLastPathComponent().path)) && ln -sfn \(Self.quoted(launcher.path)) \(Self.quoted(link.path))"
    )
  }

  /// Removes the link, only when it leads to this app.
  func uninstall() {
    refresh()
    guard state == .installed else { return }
    change(
      direct: { try FileManager.default.removeItem(at: self.link) },
      privileged: "rm -f \(Self.quoted(link.path))")
  }

  /// Tries `direct` when the folder is the owner's to change, else runs `privileged` as an
  /// administrator, which shows macOS's own password prompt.
  private func change(direct: () throws -> Void, privileged command: String) {
    defer { refresh() }
    let folder = link.deletingLastPathComponent().path
    if FileManager.default.isWritableFile(atPath: folder) {
      do {
        try direct()
        return
      } catch {}
    }
    let source = "do shell script \"\(Self.appleScriptString(command))\" with administrator privileges"
    var failure: NSDictionary?
    guard NSAppleScript(source: source)?.executeAndReturnError(&failure) != nil else {
      // -128: the owner cancelled the password prompt.
      if (failure?[NSAppleScript.errorNumber] as? Int) == -128 { return }
      let alert = NSAlert()
      alert.messageText = "The vidvnc Command Was Not Changed"
      alert.informativeText = (failure?[NSAppleScript.errorMessage] as? String) ?? "macOS refused the change."
      alert.runModal()
      return
    }
  }

  /// A POSIX shell word: single-quoted, with each single quote closed, escaped and reopened.
  static func quoted(_ text: String) -> String {
    "'" + text.replacing("'", with: "'\\''") + "'"
  }

  /// The inside of an AppleScript string literal.
  static func appleScriptString(_ text: String) -> String {
    text.replacing("\\", with: "\\\\").replacing("\"", with: "\\\"")
  }
}
