import Foundation

/// Paths in the repository these tests were built from.
enum Repository {
  static let root = URL(filePath: #filePath).deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

  static let fixtures = root.appending(path: "apps/server/tests/fixtures/owner-protocol")

  static func fixture(_ name: String) throws -> Any {
    try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appending(path: name)))
  }

  /// A fresh folder, removed by `cleanup`.
  static func scratch() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "vidvnc-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
}
