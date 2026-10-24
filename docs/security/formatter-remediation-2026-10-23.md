# Stable build tools and formatter remediation — 2026-10-23

This supersedes the development-formatter exceptions in the earlier
[Node/npm review](node-dependency-review-2026-10-23.md). That review records the
initial investigation; its Prettier exceptions no longer describe installed dependencies.

The build-tool pin subsequently advanced to v0.5.0-beta.1; the
[2026-10-24 amendment](../superpowers/specs/2026-10-24-winbuildtools-presentation-design.md)
owns that integration. The stable-tag findings below record the preceding check.

## Selected versions and upstream guidance

- Live [winbuildtools releases](https://github.com/kiforsbe/winbuildtools/releases/latest)
  select stable **v0.4.0**, peeled commit
  `9d5729f6e6d3f7563d57494f968fef1a67f65a59`. The submodule pins that commit.
  Comparison with v0.4.0-beta.1 changes only documentation and VERSION, with no
  executable changes. The MIT license is unchanged. It declares no registry package
  dependencies and redistributes no platform build tools in VidVNC payloads.
- Live [npm metadata](https://registry.npmjs.org/@biomejs%2fwasm-nodejs/latest)
  selects stable **@biomejs/wasm-nodejs 2.6.2**. The exact lockfile pin replaces
  Prettier entirely. It has no declared npm dependencies or install scripts.
  **@wasm-fmt/clang-format 23.1.1** remains the latest stable native formatter.
  Neither installed npm tool is deprecated. The final npm bulk advisory query
  returned no matches; this alone does not cover compiled code.
- Use the published WASM Workspace bindings directly through `tools/web-format.mjs`.
  Upstream's separate JavaScript wrapper is labeled alpha and is not installed.
  The full native Biome CLI is also not installed: its graph brings XML, network
  and updater components unnecessary for local source formatting.
- Existing formatting commands/scopes remain. `biome.json` retains two-space/LF,
  100-column, single-quoted JavaScript style and self-closing HTML void elements.
  Lint fixes and import organization are disabled. Buffers are in memory and closed
  after each operation, including errors. Syntax errors fail the command.
  Markdown remains outside automatic formatting; align its tables manually.

## Compiled dependencies and compatibility limits

Review the exact upstream
[Cargo.lock](https://github.com/biomejs/biome/blob/0d9aef6a5adf794118be3b9920189b33a413dd96/Cargo.lock)
and resolve `cargo tree -p biome_wasm --target wasm32-unknown-unknown --edges normal,build
--locked` from that source. Query all **569** registry entries against OSV, then check
membership in the WASM graph. This is a source/feature review, not binary attestation.

The full workspace matches quick-xml, quinn-proto, rand, scc, unsafe-libyaml and
webpki-root-certs advisories. Only **rand 0.8.5** is in the selected WASM graph.
[RUSTSEC-2026-0097](https://rustsec.org/advisories/RUSTSEC-2026-0097.html), also
GHSA-cq8v-f236-94qc, requires Rand's `log` feature and reentrant custom logging of
thread RNG reseeding. The resolved WASM feature graph does **not** enable `rand/log`.
This match is retained explicitly as non-applicable under the reviewed build features;
recheck feature reachability on upgrades. It is not described as an upstream fix.
The other matching packages are absent from this graph. npm overrides cannot change
compiled WASM code.

Live crates.io version metadata was checked for all **270** registry name/version
pairs in the normal/build graph, including license expressions, yanked status and
current stable versions. None is yanked or identifies itself as deprecated in its
registry description. **138** differ from latest stable, retained as upstream's coherent
compiled set; npm cannot independently upgrade them. TOML versions containing
`+spec-1.1.0` use build metadata, not prerelease versions. Registry descriptions are
not a comprehensive maintenance-status signal. Future updates must repeat this review.

Biome's [HTML configuration](https://biomejs.dev/reference/configuration/#html)
marks full HTML formatting experimental. It is explicitly enabled because the
existing scope includes HTML. Review markup diffs and run the viewer tests on updates.
The pinned WASM binding interface can change between releases; the adapter tests and
full format check must pass before changing its pin. JavaScript, JSON and CSS use the
same engine without adding plugins. No formatter is a public service or shipped runtime.

## Licenses and validation

Biome's [MIT](https://github.com/biomejs/biome/blob/0d9aef6a5adf794118be3b9920189b33a413dd96/LICENSE-MIT)
and [Apache-2.0](https://github.com/biomejs/biome/blob/0d9aef6a5adf794118be3b9920189b33a413dd96/LICENSE-APACHE)
terms apply to its code. Its npm WASM archive does not include standalone license files;
consult those exact upstream source texts when redistributing the tool. The compiled
graph also includes MIT/Apache alternatives, BSD/ISC/Zlib/0BSD/BSL-1.0/CC0/Unlicense,
Unicode-DFS-2016/Unicode-3.0 and MPL-2.0 terms. These are separate obligations, including
MPL source obligations if redistributing covered modifications; the top-level label
does not replace them. VidVNC distributes neither formatter nor node_modules.
clang-format's wrapper is MIT and its embedded LLVM remains Apache-2.0 with LLVM exceptions.
Node's complete runtime LICENSE remains included in every application package.

Formatter tests exercise idempotence, native include ordering, JavaScript/JSON/CSS/HTML
and invalid syntax. The portable suite passed 1089 tests, with 4 skipped. Final Windows
build/package results are recorded in the [verification record](internet-exposure.md).
This is not a complete security audit; native runtime/NuGet dependencies, private
advisories and future upstream changes are outside this formatter remediation.
