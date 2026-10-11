import Darwin
import Foundation

/// The server as a child process: `posix_spawn` with three pipes, one JSON line at a time
/// in each direction.
///
/// macOS has no job object, so the server's lifetime rests on its owner pipe: only this
/// object holds the write end of the server's stdin, so when the host exits or is killed the
/// pipe closes and the server stops (owner-start.mjs, parent-watch.mjs). The server also runs
/// in its own process group, so `kill()` can end it together with its relay and workers.
nonisolated final class ServerProcess: @unchecked Sendable {
  struct Exit: Sendable {
    /// The exit code, or nil when a signal ended the process.
    var code: Int32?
    var signal: Int32?
    /// The end of what the server wrote to stderr: the reason when it failed to start.
    var errors: String
  }

  enum Failure: LocalizedError {
    case spawn(String, Int32)
    case notRunning

    var errorDescription: String? {
      switch self {
      case .spawn(let executable, let code):
        "Couldn't start \(URL(filePath: executable).lastPathComponent): \(String(cString: strerror(code)))."
      case .notRunning: "The server isn't running."
      }
    }
  }

  /// A line longer than this is dropped rather than kept growing (the server's own lines are
  /// far shorter).
  static let maximumLine = 8 * 1024 * 1024
  private static let errorTail = 16 * 1024

  let pid: pid_t
  private let input: Int32
  private let writes = DispatchQueue(label: "VidVNC.ServerProcess.stdin")
  private let lock = NSLock()
  private var inputOpen = true
  private var errors = Data()

  private init(pid: pid_t, input: Int32) {
    self.pid = pid
    self.input = input
  }

  /// Starts `launch`. `onLine` gets each stdout line without its newline; `onExit` comes once,
  /// after the last line. Both are called on a background thread.
  static func start(
    _ launch: ServerLaunch,
    onLine: @escaping @Sendable (Data) -> Void,
    onExit: @escaping @Sendable (Exit) -> Void
  ) throws -> ServerProcess {
    var stdin: [Int32] = [-1, -1]
    var stdout: [Int32] = [-1, -1]
    var stderr: [Int32] = [-1, -1]
    func closeAll() {
      for fd in stdin + stdout + stderr where fd >= 0 { close(fd) }
    }
    guard pipe(&stdin) == 0, pipe(&stdout) == 0, pipe(&stderr) == 0 else {
      let code = errno
      closeAll()
      throw Failure.spawn(launch.executable, code)
    }
    // The host's ends never reach another child, and a write to a closed pipe returns EPIPE
    // instead of raising SIGPIPE.
    for fd in [stdin[1], stdout[0], stderr[0]] { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
    _ = fcntl(stdin[1], F_SETNOSIGPIPE, 1)

    var actions: posix_spawn_file_actions_t? = nil
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_adddup2(&actions, stdin[0], STDIN_FILENO)
    posix_spawn_file_actions_adddup2(&actions, stdout[1], STDOUT_FILENO)
    posix_spawn_file_actions_adddup2(&actions, stderr[1], STDERR_FILENO)
    posix_spawn_file_actions_addchdir(&actions, launch.workingDirectory)

    var attributes: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    // Only stdin, stdout and stderr are inherited; signals start at their defaults, unmasked;
    // the server leads a new process group.
    var defaults = sigset_t()
    sigfillset(&defaults)
    var mask = sigset_t()
    sigemptyset(&mask)
    posix_spawnattr_setsigdefault(&attributes, &defaults)
    posix_spawnattr_setsigmask(&attributes, &mask)
    posix_spawnattr_setpgroup(&attributes, 0)
    posix_spawnattr_setflags(
      &attributes,
      Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        | POSIX_SPAWN_SETPGROUP))

    let argv = [launch.executable] + launch.arguments
    let envp = launch.environment.map { "\($0.key)=\($0.value)" }
    var pid: pid_t = 0
    let result = withCStrings(argv) { argv in
      withCStrings(envp) { envp in
        posix_spawn(&pid, launch.executable, &actions, &attributes, argv, envp)
      }
    }
    // The child's ends belong to the child now.
    close(stdin[0])
    close(stdout[1])
    close(stderr[1])
    guard result == 0 else {
      close(stdin[1])
      close(stdout[0])
      close(stderr[0])
      throw Failure.spawn(launch.executable, result)
    }

    let process = ServerProcess(pid: pid, input: stdin[1])
    let (output, errors, child) = (stdout[0], stderr[0], pid)
    let readers = DispatchGroup()
    readers.enter()
    Thread.detachNewThread {
      readLines(output, onLine)
      close(output)
      readers.leave()
    }
    readers.enter()
    Thread.detachNewThread {
      readLines(errors) { process.recordError($0) }
      close(errors)
      readers.leave()
    }
    Thread.detachNewThread {
      var status: Int32 = 0
      while waitpid(child, &status, 0) == -1, errno == EINTR {}
      // Deliver every line the server wrote before reporting that it has gone.
      readers.wait()
      process.closeInput()
      let exited = status & 0x7f == 0
      onExit(
        Exit(
          code: exited ? (status >> 8) & 0xff : nil, signal: exited ? nil : status & 0x7f,
          errors: process.errorText))
    }
    return process
  }

  /// Writes one line to the server's stdin. Writes are queued in order and never block the
  /// caller.
  func send(_ line: String) throws {
    lock.lock()
    let open = inputOpen
    lock.unlock()
    guard open else { throw Failure.notRunning }
    let bytes = Array((line + "\n").utf8)
    writes.async { [self] in
      var offset = 0
      while offset < bytes.count {
        let written = bytes[offset...].withUnsafeBytes { write(input, $0.baseAddress, $0.count) }
        if written < 0 {
          if errno == EINTR { continue }
          return
        }
        offset += written
      }
    }
  }

  /// Closes the server's stdin, which stops a server that is still running.
  func closeInput() {
    lock.lock()
    defer { lock.unlock() }
    guard inputOpen else { return }
    inputOpen = false
    writes.async { [input] in close(input) }
  }

  /// Ends the server and everything in its process group at once.
  func kill() {
    _ = Darwin.killpg(pid, SIGKILL)
    _ = Darwin.kill(pid, SIGKILL)
  }

  private func recordError(_ line: Data) {
    lock.lock()
    defer { lock.unlock() }
    errors.append(line)
    errors.append(0x0A)
    if errors.count > Self.errorTail { errors.removeFirst(errors.count - Self.errorTail) }
  }

  private var errorText: String {
    lock.lock()
    defer { lock.unlock() }
    return String(decoding: errors, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func readLines(_ fd: Int32, _ deliver: (Data) -> Void) {
    var pending = Data()
    var discarding = false
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if count < 0, errno == EINTR { continue }
      if count <= 0 { break }
      var start = 0
      for index in 0..<count where buffer[index] == 0x0A {
        if !discarding {
          pending.append(contentsOf: buffer[start..<index])
          deliver(pending)
        }
        pending.removeAll(keepingCapacity: true)
        discarding = false
        start = index + 1
      }
      if !discarding { pending.append(contentsOf: buffer[start..<count]) }
      if pending.count > maximumLine {
        pending.removeAll()
        discarding = true
      }
    }
    if !pending.isEmpty, !discarding { deliver(pending) }
  }
}

/// Runs `body` with `strings` as a null-terminated array of C strings.
nonisolated private func withCStrings<R>(
  _ strings: [String], _ body: (UnsafePointer<UnsafeMutablePointer<CChar>?>) -> R
) -> R {
  var pointers: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) }
  pointers.append(nil)
  defer { for pointer in pointers { free(pointer) } }
  return pointers.withUnsafeBufferPointer { body($0.baseAddress!) }
}
