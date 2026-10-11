import Foundation

/// The server's offline settings command (`main.mjs config … --json`), used while sharing is
/// off: to show the saved settings, and to change access and remote access settings without
/// starting to share. The server refuses it while a server is running.
enum OfflineSettings {
  struct Saved: Decodable {
    var policy: StreamPolicy
    var access: AccessSnapshot
  }

  enum Failure: LocalizedError {
    case refused(String)
    case timedOut

    var errorDescription: String? {
      switch self {
      case .refused(let message): message
      case .timedOut: "Saving settings took too long."
      }
    }
  }

  static func show(_ manifest: RuntimeManifest) async throws -> Saved {
    try JSONDecoder().decode(Saved.self, from: try await run(manifest, ["show"]))
  }

  /// Runs one access command (`connection-mode approved-only`, say) and returns the saved
  /// access settings it prints.
  static func access(_ manifest: RuntimeManifest, _ arguments: [String]) async throws
    -> AccessSnapshot
  {
    try JSONDecoder().decode(AccessSnapshot.self, from: try await run(manifest, arguments))
  }

  static func run(_ manifest: RuntimeManifest, _ arguments: [String]) async throws -> Data {
    let launch = try manifest.configLaunch(arguments + ["--json"])
    return try await withCheckedThrowingContinuation { continuation in
      let process = Process()
      process.executableURL = URL(filePath: launch.executable)
      process.arguments = launch.arguments
      process.environment = launch.environment
      process.currentDirectoryURL = URL(filePath: launch.workingDirectory)
      let output = Pipe()
      let errors = Pipe()
      process.standardInput = FileHandle.nullDevice
      process.standardOutput = output
      process.standardError = errors
      let finished = Finished()
      process.terminationHandler = { process in
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let message = String(
          decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard finished.claim() else { return }
        if process.terminationStatus == 0 {
          continuation.resume(returning: data)
        } else {
          let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
          continuation.resume(
            throwing: Failure.refused(text.isEmpty ? "VidVNC couldn't save the settings." : text))
        }
      }
      do {
        try process.run()
      } catch {
        if finished.claim() { continuation.resume(throwing: error) }
        return
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
        guard finished.claim() else { return }
        process.terminate()
        continuation.resume(throwing: Failure.timedOut)
      }
    }
  }

  /// Makes sure the continuation is resumed once, by whichever of exit and timeout is first.
  private nonisolated final class Finished: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      if done { return false }
      done = true
      return true
    }
  }
}
