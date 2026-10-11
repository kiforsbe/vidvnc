import Darwin
import Foundation
import SystemConfiguration

/// This Mac's IPv4 addresses on physical ports, with the names System Settings uses.
enum NetworkInterfaces {
  static func current(served: Set<String>) -> [NetworkInterface] {
    var names: [String: String] = [:]
    if let all = SCNetworkInterfaceCopyAll() as? [SCNetworkInterface] {
      for interface in all {
        if let bsd = SCNetworkInterfaceGetBSDName(interface) as String?,
          let name = SCNetworkInterfaceGetLocalizedDisplayName(interface) as String?
        {
          names[bsd] = name
        }
      }
    }
    var result: [NetworkInterface] = []
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return [] }
    defer { freeifaddrs(list) }
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let entry = pointer.pointee
      guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
        entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0
      else { continue }
      let bsd = String(validatingCString: entry.ifa_name) ?? ""
      // Only ports System Settings lists; tunnels and VPNs have no entry there.
      guard let name = names[bsd] else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard
        getnameinfo(
          address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0,
          NI_NUMERICHOST) == 0
      else { continue }
      let text = host.withUnsafeBufferPointer { String(validatingCString: $0.baseAddress!) } ?? ""
      result.append(
        NetworkInterface(
          name: name, bsdName: bsd, address: text, isLinkLocal: text.hasPrefix("169.254."),
          isServed: served.contains(text)))
    }
    return result.sorted { ($0.isLinkLocal ? 1 : 0, $0.bsdName) < ($1.isLinkLocal ? 1 : 0, $1.bsdName) }
  }

  /// The interface name the server reports for a network (`en0`), as System Settings names it.
  static func displayName(_ bsd: String?) -> String? {
    guard let bsd, let all = SCNetworkInterfaceCopyAll() as? [SCNetworkInterface] else { return nil }
    return all.first { SCNetworkInterfaceGetBSDName($0) as String? == bsd }
      .flatMap { SCNetworkInterfaceGetLocalizedDisplayName($0) as String? }
  }
}
