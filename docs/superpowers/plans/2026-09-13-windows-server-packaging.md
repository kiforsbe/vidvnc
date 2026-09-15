# Windows Server Packaging Implementation Plan

**Goal:** Implement the approved current-user Windows host package, portable CLI bundle and matching native Debug launch path.

**Architecture:** One versioned runtime manifest is consumed by the JS worker adapter and C# host. A verified server payload is reused by the CLI ZIP and the host MSIX (Inno Setup until the 2026-09-15 revision). Debug uses an explicit development manifest, never a silent Release fallback.

**Tech Stack:** Node ESM/node:test, WinUI 3/.NET 10/MSBuild, C++17/CMake, MSIX (MakeAppx/SignTool from the Windows SDK build tools), PowerShell for Windows build tooling.

**Spec:** `docs/superpowers/specs/2026-09-12-windows-server-packaging-design.md`

## Global constraints

- Windows 11 25H2/build 26200+, x64, NVIDIA hardware encoding. No codec/profile changes.
- Current-user install; no service, startup registration or implicit firewall changes.
- No subagents. Work on `codex/windows-server-packaging` in the existing checkout unless the user chooses a separate worktree.
- Public release/signing and clean-machine installation are explicit acceptance gates, not inferred from a local smoke test.

## 1. Runtime contract

Files: `native/media-worker/runtime-manifest.mjs`, `runtime.mjs`, `tests/runtime-manifest.test.mjs`; `apps/windows-host/RuntimeManifest.cs`, `tests/RuntimeContract/`; shared cases in `tests/fixtures/runtime-contract.json`.

Interface: `loadRuntimeManifest(filename)` returns validated `{ schemaVersion, mode, configuration, architecture, root, node, server, worker, mediaBin, plugins, scanner }`; paths are absolute after validation. File fields must be files; mediaBin/plugins must be directories. Packaged paths are relative and contained, including resolved symlinks. Development paths may be absolute. Reject unsupported schema/mode/configuration/architecture and malformed/absent paths.

- [ ] Write real temporary-directory tests before production code. Assert packaged `../outside`, absolute paths, missing worker and unexpected schema fail; valid Unicode/space paths resolve. Run the new suite and confirm the missing feature fails.
- [ ] Implement JS validation and integrate `VIDVNC_RUNTIME_MANIFEST` plus explicit development defaults in the worker adapter. Packaged mode strips inherited GST discovery and Node injection settings at launch; logs/cache remain under user data.
- [ ] Implement the same C# validation with shared fixtures, exercised by a package-free .NET console test project linking the production resolver.
- [ ] Register portable native runtime tests separately from hardware tests in the root runner; run portable and hardware regression suites.

Example contract:

```json
{"schemaVersion":1,"mode":"packaged","configuration":"Release","architecture":"x64","node":"runtime/node/node.exe","server":"app/node_modules/@vidvnc/server/src/main.mjs","worker":"runtime/media/bin/media-worker.exe","mediaBin":"runtime/media/bin","plugins":"runtime/media/lib/gstreamer-1.0"}
```

## 2. Debug and host launch

Files: `CMakePresets.json`, `build-native.cmd`, `tools/debug/prepare.mjs`, `apps/windows-host/HostWindow.cs`, `Properties/launchSettings.json`, host project and module-owned launch tests.

- [ ] Test configuration selection and missing Debug worker behavior through manifest generation/resolution, not source-text assertions.
- [ ] Add Debug CMake presets and argument validation in native build command. Emit PDBs while retaining ABI-compatible SDK runtime linkage.
- [ ] Generate a development manifest from explicit project/tool inputs into the matching host output directory. Host launch reads its adjacent manifest or an explicitly supplied development manifest; remove parent-directory checkout search and global Node launching.
- [ ] Add optional loopback Node inspector launch and document attaching to native workers separately. Distributed Release never enables inspector from inherited NODE_OPTIONS.
- [ ] Verify host/server/worker graceful and forced-owner shutdown without killing unrelated Node processes.

## 3. Server payload and CLI ZIP

Files: `packaging/shared/pe-dependencies.mjs`, `packaging/shared/staging.mjs`, `packaging/windows/{inputs.json,prepare.mjs,build.mjs}`, `packaging/tests/*.test.mjs`, `packaging/windows/tests/cli-bundle-check.mjs`.

Revised 2026-09-15 by the user's dependency policy (see spec): no files from outside the project; VC++ runtime and Node.js are declared prerequisites; an option bundles pinned runtime installers.

- [x] Test PE import/delay-import parsing using small hand-built PE fixtures and dependency graph traversal with real files; reject malformed files, missing dependencies, ambiguous sources, undeclared VC++ runtime DLLs and unsafe staging roots (links/junctions, invalid names).
- [x] Assemble only production workspace package files (`files` fields) as real files, worker, allowed plugins and their recursive project-SDK dependencies; VC++ runtime DLLs are reported as prerequisites, never copied. Scanner not shipped (in-process scan). Runtime-loaded plugin elements are now checked by worker preflight.
- [x] Emit runtime.json (no `node`), files.json (hashes, components, declared prerequisites), per-recipe license texts and THIRD-PARTY-NOTICES.txt. No headers, import libraries, tests or unrelated plugins.
- [x] Generate a prerequisite-checking CLI launcher and versioned unsigned ZIPs (with and without `--include-runtime-installers`); executed from relocated spaces/non-ASCII paths with a minimal environment, unrelated CWD and fresh registry cache.

## 4. Host package (MSIX)

Revised 2026-09-15 by the user: MSIX instead of Inno Setup, self-signed development certificate for now.

Files: `apps/windows-host/{VidVnc.Host.csproj,RuntimeManifest.cs}`, `apps/windows-host/tests/RuntimeContract/Program.cs`, `packaging/windows/{inputs.json,prepare.mjs,build.mjs,msix.mjs,msix/AppxManifest.xml}`, `packaging/shared/pe-dependencies.mjs`, `packaging/tests/msix.test.mjs`, `packaging/windows/tests/server-package-check.mjs`.

- [x] Publish the host framework-dependent (.NET 10 Runtime and Windows App Runtime 2.2 are declared prerequisites) from the WinUI and Runtime component packages, and combine it with the tested server payload. Include only what the native app packager requires.
- [x] Make `node` optional in the C# resolver to match JS; the host uses bundled Node when present, else the installed Node.js prerequisite, and reports missing Node.js/VC++ runtime with download links. Add the optional Node.js files bundle (plain files, used only by the host) and optional bundled runtime installers.
- [x] Generate the MSIX manifest (per-user install, build-26200 minimum, Windows App Runtime dependency, unvirtualized `%LOCALAPPDATA%\VidVNC`), pack with `makeappx` and sign with the self-signed development certificate from `package:prepare`. Uninstall and the Start-menu entry come from Windows.
- [x] Label development output (`unsigned` ZIP, `selfsigned` MSIX); release signing stays an external-credential gate. Never publish, alter firewall rules, trust certificates or install on the user's machine as an implicit build step.

## 5. Verification and documentation

- [ ] Run format checks, all portable suites, CTest, hardware/lifecycle tests and host build.
- [ ] Exercise both staged products outside the checkout, including spaces/non-ASCII paths and unrelated CWD, with no global runtime/plugin fallback.
- [ ] Check the README `Install and run` instructions against the produced installer and CLI ZIP (Start-menu name, `VidVNC.Server.cmd`, `config` passthrough, prerequisites, nothing else to install) and remove its not-produced-yet note.
- [ ] Record actual installer compilation and Debug launch evidence. Record clean-machine install/upgrade/uninstall, signing and licensing review as outstanding if suitable infrastructure/credentials are unavailable.
- [ ] Update package/debug target statuses only for functionality actually implemented and verified. Keep the remaining three native app scaffolds unchanged.

No automatic merge or publication. Commit completed slices only after fresh verification when requested or needed for a reviewed checkpoint.

## Progress — 2026-09-13

- Working in the existing checkout on `codex/windows-server-packaging`, as requested.
- Implemented the JS manifest resolver, packaged worker environment isolation, and an atomic development-manifest writer. Existing source-checkout launches retain their previous development defaults when no manifest is supplied.
- Added module-owned portable contract tests and registered them with the portable runner.
- Added Debug build/test presets and `build-native.cmd Debug` selection. Debug worker/PDB builds and both native CTest cases pass. MSBuild requires access to the local Windows SDK registration outside the sandbox.
- Implemented the C# resolver and integrated it into WinUI startup. Added `prepare:host`, Visual Studio launch profiles, and explicit loopback-only inspector opt-in. Debug host builds with zero warnings/errors.
- Added a Windows job object plus stdin approval gate before native probing. A regression covers Windows CRLF approval. Forced-owner tests verify child/grandchild cleanup without terminating an unrelated process.
- Real Debug WinUI smoke test: launched from the temp directory, served `/api/info` on loopback port 4391, and cleaned up Node after forced host termination. No test host remains running. Seven existing hardware/lifecycle tests pass.
- Pending: shared cross-language fixtures/additional contract edge cases, payload assembly, CLI ZIP, installer, and relocation/clean-machine acceptance. Interactive F5 breakpoints remain unverified. No installer or self-contained bundle has been produced yet.

## Progress — 2026-09-15

- User revised the dependency policy mid-slice: no copying DLLs from outside the project, declared runtime prerequisites, optional bundled runtime installers, optional Node.js files bundle for the host only, host .NET/Windows App Runtime as prerequisites. Spec updated.
- Section 3 implemented. `npm run package:cli` builds the Release worker (CTest 4/4), validates inputs, stages `out/packages/windows-cli/Release` (138 files, 30.8 MiB) and writes `out/installers/windows-cli/0.1.0/VidVNC-Server-0.1.0-windows-x64-unsigned.zip`; `--include-runtime-installers` adds the pinned VC++ 14.51.36247 installer (`npm run package:prepare` downloads and verifies it).
- Portable tests: packaging 8, runtime manifest (node optional) and tools tests pass; format check clean.
- `cli-bundle-check.mjs` passed on both ZIPs, with installed Node.js 26.3.0 and Node.js 24.21.0 (declared minimum): config passthrough, exit codes 0/2, missing-Node.js message, desktop start/connect/clean stop, fresh registry cache, worker self-test with every loaded module from the package or `C:\Windows` (VC++ runtime and NVENC from System32/DriverStore). The missing-VC++ launcher branches were exercised on a copy with a raised threshold.
- Real browser session against the relocated CLI-mode ZIP found `gstapp.dll` missing from the allowlist (data channel appsrc/appsink) — fixed, `gstrtpmanagerbad.dll` removed as unused, worker preflight extended. Retest streamed 2560×1440 at 30 fps; video and audio (WASAPI/Opus) workers loaded no modules from outside the package or Windows.
- Not verified: clean machine without prerequisites, signing, license review, the launcher's Ctrl+C "Terminate batch job" prompt behavior, C# contract parity for optional `node`.
- Section 3 committed as `88e9396`.

## Progress — 2026-09-15 (section 4)

- User chose MSIX over Inno Setup, with a self-signed certificate for now. `npm run package:prepare` created `.deps/signing/vidvnc-development.{pfx,cer}` (`CN=VidVNC Development`, thumbprint F9F219F3…, valid to 2028-09-15; no store changes) and downloaded the pinned .NET 10.0.12 Runtime installer and the Node.js 24.21.0 ZIP.
- The host needs only Microsoft.NETCore.App, so the prerequisite is the .NET 10 Runtime, not the Desktop Runtime. Component packages instead of the Windows App SDK metapackage drop about 40 MB of unused AI/ML runtimes. The PE resolver skips the architecture check for AnyCPU .NET assemblies; `Microsoft.WindowsAppRuntime.dll` is reported against the Windows App Runtime prerequisite.
- `npm run package:app` stages 180 files (68.3 MiB) and writes `VidVNC-0.1.0-windows-x64-selfsigned.msix` plus `VidVNC-Development.cer`; `--include-node --include-runtime-installers` writes the `-with-node` MSIX and a ZIP with the .NET, Windows App Runtime and VC++ installers and `INSTALL.txt`. The CLI ZIP rebuild still passes `cli-bundle-check.mjs`.
- First run of the package crashed at startup (0xC000027B in `Microsoft.UI.Xaml.dll`): `dotnet publish` omitted `VidVnc.Host.pri` without `EnableMsixTooling`. Fixed in the csproj; the build now fails if the `.pri` is missing.
- `server-package-check.mjs` passed on both MSIX files: every unpacked file matches `files.json`, the signer is the development certificate (only trust fails), and the unpacked app, relocated to a spaces/non-ASCII path with a minimal environment, started its server (on installed or bundled Node.js as appropriate), served the web client and closed without leftover processes. With `--register` (user-approved, Developer Mode already on): the registered layout ran with package identity `VidVNC_0.1.0.0_x64__57pvrret10p9c`, wrote its registry cache to the real `%LOCALAPPDATA%\VidVNC` with no virtualized copy, closed cleanly and was removed; the data folder was kept. Its installed Node.js server child had no package identity.
- Tests: packaging 11/11, host runtime contract 30/30, format check clean.
- Not verified: installing the signed `.msix` through App Installer after trusting the certificate (the test registered the loose layout instead), upgrade over a running copy, missing-prerequisite behaviour on a clean machine (.NET apphost prompt, MSIX dependency failure, host messages), a real browser stream from the installed app, license review (the Windows SDK projection lists only a licence URL), release signing. The self-signed publisher becomes a different package identity once a real certificate is used. Logos are placeholders.
