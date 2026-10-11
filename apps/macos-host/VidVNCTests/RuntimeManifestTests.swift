import Foundation
import Testing

@testable import VidVNC

/// The packaged-path rules of RuntimeManifest.cs and runtime-manifest.mjs.
struct RuntimeManifestTests {
  private let files = FileManager.default

  /// A package folder with every file a manifest names, and `outside` beside it.
  private func package() throws -> (root: URL, outside: URL) {
    let base = try Repository.scratch()
    let root = base.appending(path: "Resources")
    for folder in ["server", "bin", "plugins", "MacOS"] {
      try files.createDirectory(at: root.appending(path: folder), withIntermediateDirectories: true)
    }
    for file in ["server/main.mjs", "MacOS/media-worker", "MacOS/node"] {
      try Data().write(to: root.appending(path: file))
    }
    let outside = base.appending(path: "outside.mjs")
    try Data().write(to: outside)
    return (root, outside)
  }

  private func write(_ fields: [String: Any], to root: URL) throws -> String {
    var manifest: [String: Any] = [
      "schemaVersion": 1, "mode": "packaged", "configuration": "Release", "os": "macos",
      "architecture": "arm64", "node": "MacOS/node", "server": "server/main.mjs",
      "worker": "MacOS/media-worker", "mediaBin": "bin", "plugins": "plugins",
    ]
    manifest.merge(fields) { $1 }
    let url = root.appending(path: "runtime.json")
    try JSONSerialization.data(withJSONObject: manifest).write(to: url)
    return url.path
  }

  @Test func loadsAPackagedManifest() throws {
    let (root, _) = try package()
    let manifest = try RuntimeManifest.load(try write([:], to: root))
    #expect(manifest.isPackaged)
    #expect(manifest.server.hasSuffix("/Resources/server/main.mjs"))
    #expect(manifest.node?.hasSuffix("/Resources/MacOS/node") == true)
  }

  @Test(arguments: [
    ["schemaVersion": 2], ["schemaVersion": true], ["mode": "installed"], ["configuration": "Profile"],
    ["os": "windows"], ["architecture": "x64"], ["server": "missing.mjs"], ["mediaBin": "server/main.mjs"],
  ] as [[String: any Sendable]])
  func refusesAnInvalidManifest(_ fields: [String: any Sendable]) throws {
    let (root, _) = try package()
    #expect(throws: RuntimeManifest.Failure.self) { try RuntimeManifest.load(try write(fields, to: root)) }
  }

  @Test func refusesAManifestWithoutOS() throws {
    let (root, _) = try package()
    let filename = try write([:], to: root)
    var data = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: URL(filePath: filename))) as? [String: Any])
    data.removeValue(forKey: "os")
    try JSONSerialization.data(withJSONObject: data).write(to: URL(filePath: filename))
    #expect(throws: RuntimeManifest.Failure.self) { try RuntimeManifest.load(filename) }
  }

  @Test func packagedPathsStayInsideThePackage() throws {
    let (root, outside) = try package()
    #expect(throws: RuntimeManifest.Failure.self) {
      try RuntimeManifest.load(try write(["server": outside.path], to: root))
    }
    #expect(throws: RuntimeManifest.Failure.self) {
      try RuntimeManifest.load(try write(["server": "../outside.mjs"], to: root))
    }
    // A link inside the package that leads out of it is refused too.
    try files.createSymbolicLink(at: root.appending(path: "server/link.mjs"), withDestinationURL: outside)
    #expect(throws: RuntimeManifest.Failure.self) {
      try RuntimeManifest.load(try write(["server": "server/link.mjs"], to: root))
    }
  }

  /// The app's layout: the manifest in Contents/Resources names the rest of Contents.
  @Test func rootNamesAParentFolder() throws {
    let (root, _) = try package()
    let resources = root.appending(path: "Resources")
    try files.createDirectory(at: resources, withIntermediateDirectories: true)
    let manifest = try RuntimeManifest.load(try write(["root": ".."], to: resources))
    #expect(manifest.root == RuntimeManifest.resolve(root.path))
    #expect(manifest.worker == RuntimeManifest.resolve(root.appending(path: "MacOS/media-worker").path))
    #expect(throws: RuntimeManifest.Failure.self) {
      try RuntimeManifest.load(try write(["root": "..", "server": "../outside.mjs"], to: resources))
    }
    for parent in [".", "../MacOS", "/", "", "../..x"] {
      #expect(throws: RuntimeManifest.Failure.self) {
        try RuntimeManifest.load(try write(["root": parent], to: resources))
      }
    }
  }

  @Test func developmentManifestsMayNameAnyPath() throws {
    let (root, outside) = try package()
    let manifest = try RuntimeManifest.load(try write(["mode": "development", "server": outside.path], to: root))
    #expect(manifest.server == RuntimeManifest.resolve(outside.path))
  }

  @Test func launchesTheServerAsADesktopOwner() throws {
    let (root, _) = try package()
    let manifest = try RuntimeManifest.load(try write([:], to: root))
    let launch = try manifest.serverLaunch(
      extraArguments: ["--await-owner"], inspect: true,
      environment: ["PATH": "/usr/bin", "NODE_OPTIONS": "--require x", "GST_DEBUG": "5", "HOME": "/Users/x"])
    #expect(launch.executable == manifest.node)
    // A packaged server never takes the inspector or inherited Node.js and GStreamer settings.
    #expect(launch.arguments == [manifest.server, "--desktop", "--await-owner"])
    #expect(launch.environment["NODE_OPTIONS"] == nil && launch.environment["GST_DEBUG"] == nil)
    #expect(launch.environment["HOME"] == "/Users/x")
    #expect(launch.environment["VIDVNC_RUNTIME_MANIFEST"] == manifest.filename)
    let config = try manifest.configLaunch(["show", "--json"])
    #expect(config.arguments == [manifest.server, "config", "show", "--json"])
  }

  @Test func findsNodeOnAbsolutePathEntriesOnly() throws {
    let (root, _) = try package()
    var data = try #require(
      try JSONSerialization.jsonObject(with: Data(contentsOf: URL(filePath: try write([:], to: root)))) as? [String: Any])
    data.removeValue(forKey: "node")
    let filename = root.appending(path: "runtime.json")
    try JSONSerialization.data(withJSONObject: data).write(to: filename)
    let manifest = try RuntimeManifest.load(filename.path)
    #expect(throws: RuntimeManifest.Failure.self) { try manifest.nodeExecutable(searchPath: "relative/bin:.") }
  }
}
