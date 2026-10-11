import Foundation
import Testing

@testable import VidVNC

/// `posix_spawn` with pipes: lines both ways, stderr kept for the reason, the exit reported
/// after the last line, and the process group ended together.
struct ServerProcessTests {
  private nonisolated final class Collected: @unchecked Sendable {
    let lock = NSLock()
    private var stored: [String] = []
    var lines: [String] {
      lock.lock()
      defer { lock.unlock() }
      return stored
    }
    func add(_ data: Data) {
      lock.lock()
      stored.append(String(decoding: data, as: UTF8.self))
      lock.unlock()
    }
  }

  private func run(_ script: String, send: [String] = [], close: Bool = true) async throws
    -> (lines: [String], exit: ServerProcess.Exit)
  {
    let collected = Collected()
    let launch = ServerLaunch(
      executable: "/bin/sh", arguments: ["-c", script], environment: ["PATH": "/usr/bin:/bin"],
      workingDirectory: "/")
    let exit: ServerProcess.Exit = try await withCheckedThrowingContinuation { continuation in
      do {
        let process = try ServerProcess.start(
          launch, onLine: { collected.add($0) }, onExit: { continuation.resume(returning: $0) })
        for line in send { try process.send(line) }
        if close { process.closeInput() }
      } catch {
        continuation.resume(throwing: error)
      }
    }
    return (collected.lines, exit)
  }

  @Test func passesLinesBothWays() async throws {
    let result = try await run(#"while read line; do echo "got $line"; done; echo done"#, send: ["one", "two"])
    #expect(result.lines == ["got one", "got two", "done"])
    #expect(result.exit.code == 0)
  }

  @Test func reportsTheExitCodeAndErrors() async throws {
    let result = try await run("echo partial; echo 'Owner approval was not received.' >&2; exit 2")
    #expect(result.lines == ["partial"])
    #expect(result.exit.code == 2)
    #expect(result.exit.errors == "Owner approval was not received.")
  }

  @Test func startsInTheGivenFolderWithOnlyTheGivenEnvironment() async throws {
    let result = try await run(#"pwd; echo "${HOME:-unset}""#)
    #expect(result.lines == ["/", "unset"])
  }

  @Test func killEndsTheWholeProcessGroup() async throws {
    let collected = Collected()
    let launch = ServerLaunch(
      executable: "/bin/sh", arguments: ["-c", "sleep 30 & echo $!; wait"], environment: [:],
      workingDirectory: "/")
    var child: pid_t = 0
    let exit: ServerProcess.Exit = try await withCheckedThrowingContinuation { continuation in
      do {
        let process = try ServerProcess.start(
          launch, onLine: { collected.add($0) }, onExit: { continuation.resume(returning: $0) })
        Task {
          while collected.lines.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
          process.kill()
        }
      } catch {
        continuation.resume(throwing: error)
      }
    }
    child = pid_t(collected.lines.first ?? "") ?? 0
    #expect(exit.signal == SIGKILL)
    #expect(child > 0)
    try await Task.sleep(for: .milliseconds(200))
    // The grandchild was in the server's group, so it went too.
    #expect(kill(child, 0) == -1)
  }

  @Test func refusesToStartAMissingProgram() {
    let launch = ServerLaunch(
      executable: "/nonexistent/node", arguments: [], environment: [:], workingDirectory: "/")
    #expect(throws: ServerProcess.Failure.self) {
      _ = try ServerProcess.start(launch, onLine: { _ in }, onExit: { _ in })
    }
  }
}
