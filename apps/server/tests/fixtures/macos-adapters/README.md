# macOS `--adapters` fixtures

Example output of the media worker's `--adapters` mode, in the format
[macos-lan-adapters.mjs](../../../src/macos-lan-adapters.mjs) documents. They are written
by hand to that format, from the interfaces a MacBook typically has, because the worker's
macOS mode does not exist yet (task 2.6 of the macOS plan). Replace them with recordings
from a real Mac when it does.

- `home.json`: Wi-Fi on a home network with IPv4 and a unique-local IPv6 address, an
  unplugged Ethernet adapter, and the Apple Wireless Direct Link and low-latency WLAN
  interfaces macOS always has.
- `vpn.json`: the same Wi-Fi with a VPN tunnel (`utun`) on a private address.
- `bridge.json`: a Thunderbolt Bridge between two Macs, and a Thunderbolt Ethernet port
  with its own private address.
