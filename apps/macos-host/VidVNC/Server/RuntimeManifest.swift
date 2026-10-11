import Foundation

/// The runtime manifest (`runtime.json`): where Node.js, the server and the media runtime
/// are. The same rules as native/media-worker/runtime-manifest.mjs and the Windows host's
/// RuntimeManifest.cs: a packaged manifest names only paths inside its own folder, after
/// every symbolic link is resolved, and a development manifest may name any existing path.
nonisolated struct RuntimeManifest: Equatable, Sendable {
  struct Prerequisite: Equatable, Sendable {
    var name: String
    var minimumVersion: String
    var download: String
  }

  enum Failure: LocalizedError, Equatable {
    case invalid(String)
    case prerequisite(String)

    var errorDescription: String? {
      switch self {
      case .invalid(let message), .prerequisite(let message): message
      }
    }
  }

  var filename: String
  var root: String
  var mode: String
  var configuration: String
  var node: String?
  var server: String
  var worker: String
  var mediaBin: String
  var plugins: String
  var scanner: String?
  var prerequisites: [String: Prerequisite]

  var isPackaged: Bool { mode == "packaged" }

  /// The manifest to use: the one inside the app bundle when there is one (an installed app
  /// never follows an inherited development override), else `VIDVNC_RUNTIME_MANIFEST`.
  static func defaultFilename(
    bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> String? {
    if let bundled = bundle.url(forResource: "runtime", withExtension: "json"),
      FileManager.default.fileExists(atPath: bundled.path)
    {
      return bundled.path
    }
    return environment["VIDVNC_RUNTIME_MANIFEST"].flatMap { $0.isEmpty ? nil : $0 }
  }

  static func load(_ filename: String) throws -> RuntimeManifest {
    let absolute = URL(filePath: filename).standardizedFileURL.path
    let data: Data
    do {
      data = try Data(contentsOf: URL(filePath: absolute))
    } catch {
      throw Failure.invalid("Cannot load runtime manifest \(absolute): \(error.localizedDescription)")
    }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw Failure.invalid("Runtime manifest must be an object")
    }
    let root = resolve(URL(filePath: absolute).deletingLastPathComponent().path)

    func text(_ field: String, in parent: [String: Any]? = nil) throws -> String {
      guard let value = (parent ?? object)[field] as? String,
        !value.trimmingCharacters(in: .whitespaces).isEmpty
      else { throw Failure.invalid("Invalid runtime manifest \(field)") }
      return value
    }
    func choice(_ field: String, _ choices: [String]) throws -> String {
      let value = try text(field)
      guard choices.contains(value) else { throw Failure.invalid("Invalid runtime manifest \(field)") }
      return value
    }

    // JSON `true` bridges to an NSNumber too; only the number 1 is accepted.
    guard let schema = object["schemaVersion"] as? NSNumber,
      CFGetTypeID(schema) != CFBooleanGetTypeID(), schema.doubleValue == 1
    else { throw Failure.invalid("Invalid runtime manifest schemaVersion") }
    let mode = try choice("mode", ["packaged", "development"])
    let configuration = try choice("configuration", ["Debug", "Release"])
    // A manifest without `os` predates macOS support and is a Windows one.
    guard (object["os"] as? String) == "macos" else {
      throw Failure.invalid("Invalid runtime manifest os: this manifest is not for macOS")
    }
    _ = try choice("architecture", ["arm64"])

    func location(_ field: String, directory: Bool = false) throws -> String {
      do {
        let value = try text(field)
        if mode == "packaged", value.hasPrefix("/") || value.hasPrefix("~") {
          throw Failure.invalid("absolute paths are not permitted")
        }
        let full = value.hasPrefix("/") ? value : URL(filePath: root).appending(path: value).path
        let normalized = URL(filePath: full).standardizedFileURL.path
        if mode == "packaged", !contains(root, normalized) {
          throw Failure.invalid("path escapes package")
        }
        let resolved = resolve(normalized)
        if mode == "packaged", !contains(root, resolved) {
          throw Failure.invalid("resolved path escapes package")
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: resolved, isDirectory: &isDirectory),
          isDirectory.boolValue == directory
        else {
          throw Failure.invalid("expected an existing \(directory ? "directory" : "file")")
        }
        return resolved
      } catch let failure as Failure {
        throw Failure.invalid("Invalid runtime manifest \(field): \(failure.localizedDescription)")
      }
    }

    var prerequisites: [String: Prerequisite] = [:]
    if let declared = object["prerequisites"] {
      guard let entries = declared as? [String: Any] else {
        throw Failure.invalid("Invalid runtime manifest prerequisites")
      }
      for (name, value) in entries {
        guard let item = value as? [String: Any] else {
          throw Failure.invalid("Invalid runtime manifest prerequisites \(name)")
        }
        prerequisites[name] = Prerequisite(
          name: try text("name", in: item), minimumVersion: try text("minimumVersion", in: item),
          download: try text("download", in: item))
      }
    }
    return RuntimeManifest(
      filename: absolute, root: root, mode: mode, configuration: configuration,
      node: object["node"] == nil ? nil : try location("node"),
      server: try location("server"), worker: try location("worker"),
      mediaBin: try location("mediaBin", directory: true),
      plugins: try location("plugins", directory: true),
      scanner: object["scanner"] == nil ? nil : try location("scanner"),
      prerequisites: prerequisites)
  }

  private static func contains(_ root: String, _ candidate: String) -> Bool {
    candidate == root || candidate.hasPrefix(root.hasSuffix("/") ? root : root + "/")
  }

  /// Resolves every symbolic link on the way, not just the last one: a parent folder can be
  /// a link too. A path that doesn't exist yet is returned as far as it resolves.
  static func resolve(_ path: String) -> String {
    URL(filePath: path).resolvingSymlinksInPath().standardizedFileURL.path
  }

  private func missing(_ prerequisite: Prerequisite) -> String {
    "VidVNC needs \(prerequisite.name) \(prerequisite.minimumVersion) or newer. Install it from \(prerequisite.download), then try again."
  }

  /// The bundled Node.js, else `node` from absolute `PATH` entries only, never the current
  /// folder, at the declared minimum version.
  func nodeExecutable(searchPath: String? = nil) throws -> String {
    if let node { return node }
    let declared =
      prerequisites["nodejs"]
      ?? Prerequisite(name: "Node.js", minimumVersion: "24", download: "https://nodejs.org/")
    let path = searchPath ?? ProcessInfo.processInfo.environment["PATH"] ?? ""
    let candidate = path.split(separator: ":").map(String.init)
      .filter { $0.hasPrefix("/") }
      .map { URL(filePath: $0).appending(path: "node").path }
      .first { FileManager.default.isExecutableFile(atPath: $0) }
    guard let candidate else { throw Failure.prerequisite(missing(declared)) }
    let minimum = Int(declared.minimumVersion.split(separator: ".").first ?? "") ?? 0
    guard let major = Self.nodeMajorVersion(candidate), major >= minimum else {
      throw Failure.prerequisite(missing(declared))
    }
    return candidate
  }

  private static func nodeMajorVersion(_ node: String) -> Int? {
    let process = Process()
    process.executableURL = URL(filePath: node)
    process.arguments = ["--version"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    process.waitUntilExit()
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    return Int(text.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().split(separator: ".").first ?? "")
  }

  /// How to start the server, with `extraArguments` after `--desktop`.
  func serverLaunch(
    extraArguments: [String] = [], inspect: Bool = false,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) throws -> ServerLaunch {
    var environment = environment
    if isPackaged {
      // A packaged server uses only its own runtime, whatever the shell exported.
      for key in environment.keys
      where key.uppercased().hasPrefix("NODE_") || key.uppercased().hasPrefix("GST")
        || ["VIDVNC_MEDIA_WORKER", "VIDVNC_LOG_DIR"].contains(key.uppercased())
      {
        environment.removeValue(forKey: key)
      }
    }
    var arguments: [String] = []
    if !isPackaged, inspect { arguments.append("--inspect=127.0.0.1:9229") }
    arguments += [server, "--desktop"] + extraArguments
    environment["VIDVNC_RUNTIME_MANIFEST"] = filename
    return ServerLaunch(
      executable: try nodeExecutable(searchPath: environment["PATH"]), arguments: arguments,
      environment: environment, workingDirectory: root)
  }

  /// The server's offline settings command (`main.mjs config …`), which edits the saved
  /// settings while sharing is off and refuses while a server is running.
  func configLaunch(_ arguments: [String]) throws -> ServerLaunch {
    var launch = try serverLaunch()
    launch.arguments.removeAll { $0 == "--desktop" }
    launch.arguments += ["config"] + arguments
    return launch
  }
}

/// A process to start: what `ServerProcess` and `OfflineSettings` run.
nonisolated struct ServerLaunch: Equatable, Sendable {
  var executable: String
  var arguments: [String]
  var environment: [String: String]
  var workingDirectory: String
}
