# Node.js and npm dependency review — 2026-10-23

**Superseded formatter status:** Prettier was subsequently removed; see the
[remediation](formatter-remediation-2026-10-23.md). The findings below preserve the
initial investigation rather than describe current dependencies.

Scope: Windows packaging and the owner's requested general Node.js/npm review,
including transitive/bundled code. This public-source review is not a complete security
guarantee or audit of the native GStreamer/NuGet dependency set.

## Changes and authoritative checks

- [Node index](https://nodejs.org/dist/index.json),
  [support policy](https://nodejs.org/en/about/previous-releases) and
  [24.22.1 security release](https://nodejs.org/en/blog/release/v24.22.1): replace
  Windows and macOS 24.21.0 pins with **24.22.1**, the latest stable 24 LTS patch.
  Node 26.12.1 is the newer Current line; production guidance prefers LTS. Source
  development accepts `^24.22.1 || ^26.12.1`, excluding older vulnerable patches and
  unsupported majors. Machine-wide Node installations are not modified.
- Check both hashes against official
  [SHASUMS256.txt](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt). This release fixes
  TLS/IP, DNS, HTTP agent, crypto and bundled Brotli issues, and updates OpenSSL to
  3.5.9, c-ares to 1.34.9 and undici to 7.30.1. Those runtime dependencies update
  together; they are not npm overrides.
- Live npm `latest` metadata selects **prettier 3.9.10** and
  **@wasm-fmt/clang-format 23.1.1** over 3.9.6 and 23.1.0. Engine floors are compatible;
  neither package itself is deprecated. Review installed license texts and upstream
  [Prettier guidance](https://prettier.io/blog/) and
  [clang-format releases](https://github.com/wasm-fmt/clang-format/releases).
- `npm ls --all` shows first-party runtime workspaces and two external development
  tools without declared external transitives. Updated `npm audit` lists zero
  advisories for that graph. It does not cover embedded code or native runtime libraries.
- Live origin tags select winbuildtools **v0.3.0**, source commit
  `9a3bf8cf1d79d05946abbd020fe57ccec3d0ceb5`. Its
  [license](https://github.com/kiforsbe/winbuildtools/blob/v0.3.0/LICENSE) is MIT; it
  adds no registry package dependencies or redistributed platform binaries.

## Embedded development-tool exceptions

Prettier's actual THIRD-PARTY-NOTICES lists 251 embedded packages hidden from npm's
dependency graph. All 253 entries including the tools were checked against live npm
version/license/deprecation metadata and the registry bulk advisory endpoint. No
embedded prerelease was listed; 83 versions trail registry latest. Upstream's stable
Prettier bundle controls these copies. npm overrides cannot replace compiled-in code;
rebuilding/forking Prettier is outside this migration.

These known advisory matches remain in the latest stable distribution. They are
explicit development-only compatibility exceptions pending an upstream bundle update,
not described as fixed or advisory-free:

| Embedded component      | Version | Advisory examples                                                                                                                                  | Exposure considered                                                 |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| @angular/compiler       | 22.0.6  | [GHSA-hh8m-fm6v-7cvg](https://github.com/advisories/GHSA-hh8m-fm6v-7cvg)                                                                           | Angular sanitization; VidVNC does not execute Angular templates     |
| brace-expansion         | 5.0.6   | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | Glob expansion denial of service                                    |
| js-yaml                 | 5.1.0   | [GHSA-g796-fgmg-93mv](https://github.com/advisories/GHSA-g796-fgmg-93mv), [GHSA-r3ph-w7gj-g6xm](https://github.com/advisories/GHSA-r3ph-w7gj-g6xm) | YAML parsing denial of service; not an enabled formatting extension |
| katex                   | 0.16.47 | [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7)                                                                           | Rendering trust; VidVNC does not render KaTeX                       |
| nanoid                  | 3.3.15  | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | Invalid generator-size denial of service                            |
| postcss                 | 8.5.16  | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | Source-map file reads during development CSS processing             |
| postcss-selector-parser | 2.2.3   | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)                                                                           | CPU exhaustion on crafted development CSS                           |
| smol-toml               | 1.7.0   | [GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2), [GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2) | TOML parsing denial of service; not an enabled formatting extension |

Embedded `flatten 1.0.3` and `trim 1.0.1` are deprecated in favor of modern utilities
and native String.trim respectively, with the same upstream-bundle exception.
No application code adds dependencies on them. Do not use this bundle as a public
formatting service or format untrusted submitted content. Parser reachability has
not been formally audited. Formatting tools are excluded from every shipped VidVNC
payload; server/viewer have no external npm runtime modules. Recheck these exceptions
before future tooling updates.

## License and validation boundaries

Ship Node's entire LICENSE: it contains MIT and all bundled third-party terms.
Prettier's installed LICENSE/THIRD-PARTY-NOTICES include MIT, ISC, BSD-2/3-Clause,
Apache-2.0 and BlueOak-1.0.0. clang-format's wrapper is MIT; its compiled LLVM tool
retains upstream Apache-2.0 with LLVM exceptions. Development tools are not shipped.
A top-level MIT label does not relicense embedded libraries.

The installed system Node was 26.12.0 at discovery; validation uses the verified
24.22.1 executable in ignored .deps without replacing system software. Windows tests
and package checks validate compatibility. macOS has the new official hash pin but
needs a rebuild/run on a Mac. Current results belong in the main security analysis's
verification record; private advisories/platform servicing were not audited.
