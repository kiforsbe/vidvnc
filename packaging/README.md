# Distribution scaffolding

Status: Windows development builds only: the CLI server ZIP (unsigned) and the
server/host MSIX (self-signed). Nothing is published or release-signed.

`targets.json` defines the six products and reusable payload groups. Paths are
repository-relative source ownership locations, not installed bundle paths. The
catalog is descriptive input for future packaging tooling, not an executable build
configuration. Products stay `planned` until a builder and its checks exist.

```text
packaging/
  targets.json       Product matrix and shared payload membership
  shared/           Common staging, dependency inventory and payload verification
  windows/          Windows installer/bundle assembly and lifecycle
    tests/          Windows install/upgrade/uninstall checks
  macos/            Apple bundle assembly, signing and notarization
    tests/          macOS install/permission/lifecycle checks
  tests/            Platform-independent catalog/staging/manifest checks
```

Full-server and CLI-server products reuse one server payload per OS/architecture.
The full-server installer adds its native host UI. Client-only installers use their
own viewer payload and must not include a capture worker or server service.

Future outputs: `out/packages/<target>/<configuration>/` for staging and
`out/installers/<target>/<version>/` for distributables. Both are ignored.
Never place downloaded SDKs, credentials or generated installers in this tree.

See [requirements](../docs/PACKAGING.md) and [debug scaffolding](../tools/debug/README.md).
