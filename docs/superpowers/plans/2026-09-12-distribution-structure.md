# Distribution Structure Implementation Plan

**Goal:** Prepare source ownership and distribution/debug definitions without implementing missing applications or installers.

**Architecture:** Six distribution definitions share payload groups. OS-specific packaging owns installer lifecycle and signing. Debug definitions describe separately attachable host, server and native-worker processes.

**Tech Stack:** Existing npm, CMake and WinUI/MSBuild projects; JSON definitions and Markdown ownership guides. Future Apple projects remain native Xcode/SwiftPM projects, not npm workspaces.

**Spec:** `docs/PACKAGING.md`, narrowed by the user to structure first.

## Constraints

- Windows 11 25H2/build 26200 minimum; macOS 27 target.
- No new runtime dependencies, installer downloads, signing actions or firewall changes.
- No copied application implementations, fake executables or commands reporting placeholder success.
- Existing build/runtime behavior stays unchanged. No subagents.

## Steps

- [x] Add `packaging/targets.json`: six OS/product combinations and shared payload groups, all explicitly planned.
- [x] Add shared, Windows and macOS packaging ownership directories; document where packaging tests belong.
- [x] Reserve the three missing native app directories with explicit status/ownership guides; no project files claiming they build.
- [x] Add `tools/debug/targets.json` and a guide describing host/server/worker debugging, build configuration selection and cleanup requirements.
- [x] Update architecture, packaging and root navigation to reference the real scaffolding.
- [x] Parse both JSON catalogs; check target uniqueness, payload membership, referenced source directories and debug configuration paths.
- [x] Run existing format checks and portable tests. Review the diff for accidental runtime changes.

No commit is part of this step unless requested. The next implementation slice is Windows debug launching and runtime-path resolution, followed by Windows CLI payload assembly.
