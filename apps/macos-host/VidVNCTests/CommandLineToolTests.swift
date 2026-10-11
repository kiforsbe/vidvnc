import Foundation
import Testing

@testable import VidVNC

/// What Install Command-Line Tool finds at the link's place.
struct CommandLineToolTests {
  private let files = FileManager.default

  @Test func readsWhatIsInstalled() throws {
    let base = try Repository.scratch()
    let launcher = base.appending(path: "VidVNC.app/Contents/Helpers/vidvnc")
    let link = base.appending(path: "bin/vidvnc")
    try files.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)

    #expect(CommandLineTool(link: link, launcher: launcher).state == .unavailable)
    try files.createDirectory(at: launcher.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: launcher)
    try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcher.path)
    #expect(CommandLineTool(link: link, launcher: launcher).state == .notInstalled)

    try files.createSymbolicLink(at: link, withDestinationURL: launcher)
    #expect(CommandLineTool(link: link, launcher: launcher).state == .installed)

    try files.removeItem(at: link)
    try files.createSymbolicLink(atPath: link.path, withDestinationPath: "/elsewhere/vidvnc")
    #expect(CommandLineTool(link: link, launcher: launcher).state == .other("/elsewhere/vidvnc"))

    try files.removeItem(at: link)
    try Data().write(to: link)
    #expect(CommandLineTool(link: link, launcher: launcher).state == .other(link.path))
  }

  @Test func quotesPathsForTheShellAndAppleScript() {
    #expect(CommandLineTool.quoted("/Applications/Vid VNC's.app") == #"'/Applications/Vid VNC'\''s.app'"#)
    #expect(CommandLineTool.appleScriptString(#"ln "a\b""#) == #"ln \"a\\b\""#)
  }
}
