import Foundation
import Testing

@testable import VidVNC

/// The host decodes every example in the owner protocol contract, so a server change that
/// the contract records can't silently break the Mac host.
struct OwnerMessagesTests {
  private func lines(_ examples: [Any]) throws -> [Data] {
    try examples.map { try JSONSerialization.data(withJSONObject: $0) }
  }

  @Test func decodesEveryServerLine() throws {
    let lines = try #require(try Repository.fixture("lines.json") as? [String: [Any]])
    #expect(Set(lines.keys) == ["ready", "status", "clients", "displays"])
    for (type, examples) in lines {
      for data in try self.lines(examples) {
        let line = try #require(try ServerLine.decode(data), "\(type)")
        switch (type, line) {
        case ("ready", .ready(let ready)):
          #expect(!ready.password.isEmpty)
          #expect(ready.policy.profiles.count == 1)
        case ("status", .status(let status)):
          #expect(status.sessions.first?.control == "Granted")
          #expect(status.sessions.first?.streams.first?.stability?.generated.count == 1)
        case ("clients", .clients(let clients)):
          #expect(clients.pending.count == 1 && clients.approved.count == 1)
        case ("displays", .displays(let rows)):
          #expect(rows.first?.number == 1)
        default:
          Issue.record("\(type) decoded as \(line)")
        }
      }
    }
  }

  @Test func readsTheNetworksWaitingForConfirmation() throws {
    let lines = try #require(try Repository.fixture("lines.json") as? [String: [Any]])
    let data = try JSONSerialization.data(withJSONObject: try #require(lines["status"]?[1]))
    guard case .status(let status) = try ServerLine.decode(data) else {
      Issue.record("not a status line")
      return
    }
    #expect(status.networks?.first?.id == "6361370af95a55dd")
    #expect(status.networks?.first?.interface == "en0")
  }

  @Test func decodesEveryReply() throws {
    let replies = try #require(try Repository.fixture("replies.json") as? [String: [Any]])
    for (type, examples) in replies {
      for data in try lines(examples) {
        guard case .reply(let reply) = try ServerLine.decode(data) else {
          Issue.record("\(type) is not a reply")
          continue
        }
        #expect(reply.type == type)
        // A refusal always has a reason to show.
        #expect(reply.ok || reply.failure?.isEmpty == false)
      }
    }
  }

  /// `policy-set` sends the whole policy back, so encoding what was decoded must give the
  /// server exactly what it sent, `displaySharing: null` included.
  @Test func policyRoundTripsUnchanged() throws {
    let lines = try #require(try Repository.fixture("lines.json") as? [String: [Any]])
    let ready = try #require(lines["ready"]?.first as? [String: Any])
    var original = try #require(ready["policy"] as? [String: Any])
    for sharing in [original["displaySharing"] as Any, NSNull()] {
      original["displaySharing"] = sharing
      let policy = try JSONDecoder().decode(
        StreamPolicy.self, from: JSONSerialization.data(withJSONObject: original))
      let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(policy))
      #expect(NSDictionary(dictionary: original).isEqual(to: try #require(encoded as? [String: Any])))
    }
  }

  @Test func ignoresLinesThatAreNotMessages() throws {
    #expect(try ServerLine.decode(Data("not json".utf8)) == nil)
    #expect(try ServerLine.decode(Data("[1]".utf8)) == nil)
    guard case .other(let type) = try ServerLine.decode(Data(#"{"type":"future"}"#.utf8)) else {
      Issue.record("an unknown type should be passed over")
      return
    }
    #expect(type == "future")
  }
}
