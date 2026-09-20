# Variable Bitrate Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host mark any streaming profile as variable bitrate with a quality level, cutting idle and light-motion bitrate by roughly 80 to 90% without changing anything for existing installs.

**Architecture:** Profiles gain `bitrateMode` and `quality`. The server validates them, carries them through policy, resolution, shared-encode keys and the worker's `streamPlan`. The native worker owns a pure per-codec table that turns mode and quality into NVENC properties (quality floor, 2x peak, 10 second GOP). CLI, Windows host app and web client expose and label the fields; clients cannot choose a mode.

**Tech Stack:** Node.js (ESM, `node --test`) server and CLI; C++17 native worker (MSVC, GStreamer 1.28, NVENC); WinUI 3 (.NET) host app; plain JavaScript web client.

**Spec:** [docs/superpowers/specs/2026-09-20-variable-bitrate-design.md](../specs/2026-09-20-variable-bitrate-design.md). Measurements and method: [docs/investigations/VARIABLE-RATE-INVESTIGATION.md](../../investigations/VARIABLE-RATE-INVESTIGATION.md).

## Global Constraints

Every task's requirements include these, copied from the spec.

- `bitrateMode` is `cbr` or `vbr`. `quality` is `efficient`, `balanced` or `high`. A profile missing either field loads as `cbr` / `balanced`.
- `schemaVersion` stays 1.
- `bitrateKbps` keeps its range of 100 to 50000. Under VBR it is the sustained cap. The peak (`max-bitrate`) is twice that and is not budgeted separately.
- CBR encoder settings are exactly `rc-mode=cbr bitrate=<B> gop-size=<fps>`, unchanged from today.
- VBR encoder settings are `rc-mode=vbr bitrate=<B> max-bitrate=<2B> qp-min-i=<i> qp-min-p=<p> gop-size=<fps x 10>`.
- Invalid values are rejected with the messages `Bitrate mode is invalid` and `Quality is invalid`.
- The worker's `streamPlan` has exactly seven keys: `width`, `height`, `fps`, `bitrateKbps`, `mtu`, `bitrateMode`, `quality`. There is no five-key compatibility path.
- Custom client settings (client options mode) always resolve to `cbr` / `balanced`. `allowedOptions` does not change.
- `frameDelivery` stays `fixed`. Variable frame rate is out of scope, as are client-selectable mode, per-display settings, adaptive bitrate and live reconfiguration.
- Every seeded profile and every saved profile without the new fields stays `cbr` / `balanced`. Upgrading changes no behaviour.
- The rest of the encoder pipeline is unchanged: preset p3, ultra-low-latency tune, no B-frames, zero latency, repeated headers, the keyframe recovery paths and the `fps == 15` mobile coupling.
- Platform: Windows 11 25H2 (build 26200) and an NVIDIA GPU for GPU steps; Node 20.6 or newer; native code is C++17 with MSVC `/W4`.
- Formatting: run `npm run format` before committing. `npm run format:check` must pass.
- Commits: conventional style (`feat:`, `test:`, `docs:`), ending with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Commit steps below apply only when the user has authorised commits for the execution session; otherwise stop after the verification step and leave the work uncommitted.
- This plan contains no implementation code by design. Each task lists required behaviour, exact names and test cases; the implementer writes the code test-first.

## Test policy: what MUST be run, and nothing else

Principles:

- Write few tests. Each new test proves one behaviour that no existing test covers. Do not add a test for something an existing test or the type of the code already guarantees.
- Write no new end-to-end tests. Behaviour that crosses the server and the worker is proven by the single existing hardware test named in Task 6, and by the one VBR self-test in Task 5.
- Run only the commands in this table, at the step where the task says so. Do not widen a run "to be safe".

| Task | MUST run | Why this and nothing more |
| --- | --- | --- |
| 1 | `node --test apps/server/tests/stream-policy.test.mjs`, then once `node tools/test.mjs server` | The profile shape changes, so an existing test elsewhere in the server suite may assert it. This is the one full server run for the server-side tasks. |
| 2 | `node --test apps/server/tests/stream-registry.test.mjs` | Only the registry changed. |
| 3 | `.\build-native.cmd` | It is the only way to build; it also runs the native unit tests, which take seconds. |
| 4 | `.\build-native.cmd` | Same. |
| 5 | `.\build-native.cmd`, then `node --test native/media-worker/tests/native-worker.test.mjs` (needs the GPU) | The only proof that the worker accepts the VBR encoder properties. It also re-runs the existing CBR self-tests, which guards CBR. |
| 6 | `node --test apps/server/tests/stream-runtime.test.mjs apps/server/tests/host-status.test.mjs`, then once `node --test apps/server/tests/native-media.test.mjs` (needs the GPU and the Task 5 build) | The existing hardware test is the only check that the server and the rebuilt worker agree on the seven-key plan. Do not write a new end-to-end test. |
| 7 | No tests. Measurements and the picture check only, then `.\build-native.cmd` | The task changes numbers, and the Task 4 unit test carries them. |
| 8 | `node --test apps/server/tests/cli-policy-edits.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs apps/server/tests/cli-parity.test.mjs` | The parity test walks every profile field, so it must run. |
| 9 | `dotnet build apps/windows-host/VidVnc.Host.csproj`, then the Navigation regression once, as written in `apps/windows-host/tests/Navigation/README.md` | The fixture changes, and the regression is the only test that compiles and opens the editor. |
| 10 | `node --test apps/web-client/tests/profile-labels.test.mjs apps/server/tests/http-security.test.mjs` | The label logic is a pure module, and the HTTP test is the only guard that the new module is served. No browser run. |
| 11 | None (documentation only) | |
| 12 | `npm run format:check`, then once `node tools/test.mjs server` | The final gate. |

Never run for this work: `npm test`, `npm run test:hardware`, anything under `tests/system`, the web client browser checks (`stream-browser-check.mjs`, `web-browser-check.mjs`, `toolbar-browser-check.mjs`), the multi-stream and shared-stream checks, or packaging. If a required run fails for a reason unrelated to this work, stop and report it instead of widening the run.

Useful single-purpose commands: `node --test <file>` for one Node test file, and `.\build-native.cmd` for the native build, which formats, configures, builds and runs every C++ test.

## File structure

New files:

- `apps/server/src/rate-control.mjs`: the allowed mode and quality values and their defaults. One responsibility: a single source of truth for the server, mirroring `video-codecs.mjs`.
- `native/media-worker/src/rate-control.hpp`: the pure per-codec table mapping a profile to encoder rate-control properties and GOP length.
- `native/media-worker/tests/rate-control.cpp`: its unit test.

Modified files, by layer:

- Server: `apps/server/src/profiles.mjs`, `stream-policy.mjs`, `stream-registry.mjs`, `native-media.mjs`, `host-status.mjs`.
- CLI: `apps/server/src/cli/policy-edits.mjs`, `cli/commands/profiles.mjs`, `cli/format.mjs`, `cli/completion.mjs`.
- Native: `native/media-worker/src/stream-profile.hpp`, `media-worker.cpp`, `telemetry.hpp` if it carries the metrics, and `native/media-worker/CMakeLists.txt`.
- Host app: `apps/windows-host/HostWindow.Profiles.cs` and the Navigation test project.
- Web client: `apps/web-client/src/app.js`, `diagnostics.js`.
- Docs: `README.md`, `docs/ROADMAP.md`, the spec (final QP values) and the investigation doc.

## Ordering notes

- Tasks 1 and 2 change no wire format and can land first.
- Tasks 5 and 6 are a lockstep pair: the worker rejects a five-key plan and the server sends seven keys after Task 6. Land them together. Unit tests stay green in between because server tests use a fake worker, but an end-to-end stream does not work between them.
- Task 7 needs only Task 4's table and a GPU (it drives `gst-launch-1.0` directly), so it can run any time after Task 4. Tasks 8, 9, 10 and 11 are independent of each other; Tasks 9 and 10 read fields that Tasks 1 and 6 produce. Task 12 comes last.

---

### Task 1: Server mode and quality fields, policy validation and resolution

**Files:**
- Create: `apps/server/src/rate-control.mjs`
- Modify: `apps/server/src/profiles.mjs`, `apps/server/src/stream-policy.mjs`
- Test: `apps/server/tests/stream-policy.test.mjs` only. The seeded profiles reach the default policy through `getProfile`, so a separate `profiles.test.mjs` case would test the same thing twice.

**Interfaces:**
- Consumes: `VIDEO_CODECS` pattern in `apps/server/src/video-codecs.mjs` (follow its export style).
- Produces: `apps/server/src/rate-control.mjs` exporting `BITRATE_MODES` (`['cbr', 'vbr']`), `QUALITY_LEVELS` (`['efficient', 'balanced', 'high']`), `DEFAULT_BITRATE_MODE` (`'cbr'`) and `DEFAULT_QUALITY` (`'balanced'`). Resolved plan profile shape from `resolveStreamPolicy`: `{ name, width, height, fps, bitrateKbps, bitrateMode, quality, mtu }`. Policy profile shape gains `bitrateMode` and `quality`.

- [ ] **Step 1: Write four failing tests in `stream-policy.test.mjs`**

  1. Defaults: `defaultStreamPolicy` returns every seeded profile with `bitrateMode: 'cbr'` and `quality: 'balanced'`.
  2. Upgrade: `validateStreamPolicy` on a policy whose profiles lack both fields returns each profile as `cbr` / `balanced`, and does not mutate its input.
  3. Validation: a `vbr` profile with a valid quality is accepted; `bitrateMode: 'abr'` is rejected with `Bitrate mode is invalid`; `quality: 'ultra'` is rejected with `Quality is invalid`.
  4. Resolution: `resolveStreamPolicy` returns `bitrateMode` and `quality` for a named VBR profile, and returns `cbr` / `balanced` for custom client settings.

  Do not add cases for extra profile fields, `frameDelivery` or the 64 KiB limit; existing tests already cover them.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `node --test apps/server/tests/stream-policy.test.mjs`
Expected: the four new tests fail (missing fields or messages); existing tests in the file still pass.

- [ ] **Step 3: Implement**

  - Create `rate-control.mjs` with the four exports above.
  - Add the two fields to each seeded profile in `profiles.mjs`, leaving `auto` alone.
  - In `stream-policy.mjs`: add both fields to `defaultStreamPolicy`; in `validateStreamPolicy` fill missing per-profile fields before the exact-key-set check (same style as the existing `displaySharing` and `videoCodecs` back-fill) and add both to the profile key list; validate each against the constants with the exact messages from Global Constraints; have `resolveStreamPolicy` return both fields in `profile`, and force `cbr` / `balanced` for custom settings.

- [ ] **Step 4: Run the required tests**

Run: `node --test apps/server/tests/stream-policy.test.mjs`, then once `node tools/test.mjs server`
Expected: all pass. The full server run is required here because the profile shape changed. Any existing test that asserts an exact resolved profile object needs the two new fields added; that is the only acceptable edit to existing tests.

- [ ] **Step 5: Format and commit**

Run: `npm run format`, then `git add apps/server/src/rate-control.mjs apps/server/src/profiles.mjs apps/server/src/stream-policy.mjs apps/server/tests/stream-policy.test.mjs`
Commit message: `feat: add bitrate mode and quality to stream profiles`

---

### Task 2: Shared-encode key and registry validation

**Files:**
- Modify: `apps/server/src/stream-registry.mjs`
- Test: `apps/server/tests/stream-registry.test.mjs`

**Interfaces:**
- Consumes: plan profiles with optional `bitrateMode` and `quality` (Task 1 shape). Legacy plans without them must keep working.
- Produces: `sourceKey(plan)` whose key text differs when `bitrateMode` differs, and, only when the mode is `vbr`, when `quality` differs. A missing mode counts as `cbr`.

- [ ] **Step 1: Write two failing tests**

  1. Keys: CBR versus VBR plans that are otherwise identical get different keys; two VBR plans differing only in quality get different keys; two CBR plans differing only in quality get the same key; a plan with no `bitrateMode` gets the same key as the same plan with `cbr` / `balanced`.
  2. Validation: `subscribe` throws `Invalid stream plan` for a `bitrateMode` or `quality` that is present but not an allowed value.

  Do not add a budget test; the budget arithmetic is untouched.

- [ ] **Step 2: Run to confirm failure**

Run: `node --test apps/server/tests/stream-registry.test.mjs`
Expected: the two new tests fail.

- [ ] **Step 3: Implement**

Update `sourceKey` and the plan validation in `subscribe` per the interface. Import the allowed values from `rate-control.mjs`. Leave the budget arithmetic alone.

- [ ] **Step 4: Run the required test**

Run: `node --test apps/server/tests/stream-registry.test.mjs`
Expected: all pass. If an existing test asserts an exact key string, update only that expectation and mention it in the commit body. No full-suite run; Task 1 already ran it.

- [ ] **Step 5: Format and commit**

Commit message: `feat: key shared encodes on bitrate mode and quality`

---

### Task 3: Native profile parsing

**Files:**
- Modify: `native/media-worker/src/stream-profile.hpp`
- Test: `native/media-worker/tests/stream-profile.cpp`

**Interfaces:**
- Consumes: json-glib objects, as today.
- Produces: in `stream-profile.hpp`, an `enum class BitrateMode { Cbr, Vbr }` and an `enum class Quality { Efficient, Balanced, High }`, and two new members on `StreamProfile` appended after `mtu`: `bitrate_mode` (default `BitrateMode::Cbr`) and `quality` (default `Quality::Balanced`). Appending with defaults keeps the aggregate-initialised legacy profiles (`{w, h, fps, bitrate, mtu}`) in `media-worker.cpp` compiling and CBR. `parse_stream_profile(JsonObject*, StreamProfile&)` keeps its signature but accepts exactly seven keys: the five integers as today plus string members `bitrateMode` (`"cbr"` or `"vbr"`) and `quality` (`"efficient"`, `"balanced"` or `"high"`).

- [ ] **Step 1: Update the existing cases and add four**

The existing valid and invalid cases use five keys and will now all fail for the wrong reason, so update them: every case gets the two new keys, and each invalid case must fail only for the one defect it names. Then add only:
  - one valid seven-key VBR plan, asserting the parsed mode and quality;
  - rejected: a five-key plan; an unknown mode string; an unknown quality string;
  - rejected: a mode given as a number rather than a string.

  The existing extra-key and missing-key cases already cover the other key-count failures once they are updated to seven keys, and a default-constructed profile is guaranteed by the struct's default values.

- [ ] **Step 2: Build and confirm the tests fail**

Run: `.\build-native.cmd`
Expected: build succeeds, then `media-worker.stream-profile` fails.

- [ ] **Step 3: Implement**

Add the enums and members, extend the key check from five to seven, and validate the two strings, keeping the existing integer validation untouched.

- [ ] **Step 4: Build and run all native tests**

Run: `.\build-native.cmd`
Expected: every native test passes, with no new `/W4` warnings.

- [ ] **Step 5: Commit**

Commit message: `feat: parse bitrate mode and quality in the worker stream plan`

---

### Task 4: Native rate-control table

**Files:**
- Create: `native/media-worker/src/rate-control.hpp`, `native/media-worker/tests/rate-control.cpp`
- Modify: `native/media-worker/CMakeLists.txt`

**Interfaces:**
- Consumes: `StreamProfile` and its enums from Task 3; codec ids `"h264"`, `"h265"`, `"av1"` from `video-codec.hpp`.
- Produces: a `RateControl` struct holding `properties` (the encoder property string, without leading or trailing space) and `gop_frames` (int), and a function `rate_control(const std::string& codec_id, const StreamProfile& profile)` returning it. An unknown codec id throws `std::invalid_argument`.

Required behaviour:
  - CBR returns exactly `rc-mode=cbr bitrate=<B> gop-size=<fps>` and `gop_frames == fps`.
  - VBR returns `rc-mode=vbr bitrate=<B> max-bitrate=<2B> qp-min-i=<i> qp-min-p=<p> gop-size=<fps x 10>` and `gop_frames == fps x 10`.
  - QP floors come from a per-codec, per-quality table. Starting values (Task 7 replaces them with tuned values):

| Quality | h264 and h265 (i / p) | av1 (i / p) |
| --- | --- | --- |
| efficient | 30 / 34 | 150 / 170 |
| balanced | 24 / 28 | 120 / 140 |
| high | 20 / 24 | 100 / 120 |

- [ ] **Step 1: Write the failing test `rate-control.cpp`**

Use `assert` like the sibling tests. Keep it to five checks:
  - CBR at 30 fps and 6000 kbit/s equals `rc-mode=cbr bitrate=6000 gop-size=30`, and gives the same string with `high` quality. This pins today's behaviour.
  - VBR h264 balanced, 30 fps, 6000 equals `rc-mode=vbr bitrate=6000 max-bitrate=12000 qp-min-i=24 qp-min-p=28 gop-size=300`.
  - VBR av1 high (a different QP scale) yields the AV1 table's `high` floors.
  - VBR at 15 fps has `gop_frames == 150`.
  - An unknown codec id throws.

- [ ] **Step 2: Register the test**

In `CMakeLists.txt` add `rate-control` to the test name list and link it against `gstreamer_sdk` (it includes `stream-profile.hpp`, which pulls in json-glib), next to the existing `stream-profile-test` line.

- [ ] **Step 3: Build and confirm the test fails**

Run: `.\build-native.cmd`
Expected: fails to compile or fails the assertions because `rate-control.hpp` does not exist yet.

- [ ] **Step 4: Implement `rate-control.hpp`**

A header-only pure function and a small constant table, in the style of `video-codec.hpp`. No GStreamer calls.

- [ ] **Step 5: Build and run all native tests**

Run: `.\build-native.cmd`
Expected: all pass, including `media-worker.rate-control`.

- [ ] **Step 6: Commit**

Commit message: `feat: add per-codec rate-control table to the media worker`

---

### Task 5: Worker pipeline wiring, metrics and a VBR self-test

**Files:**
- Modify: `native/media-worker/src/media-worker.cpp` (`pipeline_description` near line 543; the self-test result near line 677; the metrics sample near line 1215; the argument handling near line 1321)
- Test: `native/media-worker/tests/native-worker.test.mjs`

**Interfaces:**
- Consumes: `rate_control(codec_id, profile)` and `RateControl` from Task 4; `StreamProfile` fields from Task 3; the global `profile` and `video_codec` already in `media-worker.cpp`.
- Produces: `pipeline_description` builds the encoder's rate-control portion from `rate_control(...)`. The self-test result and every `metrics` sample gain string members `bitrateMode` (`"cbr"` or `"vbr"`) and `quality`, beside the existing `codec`. A new argument `--self-test-vbr <codec>` runs the self-test with a 2560x1440, 30 fps, 6000 kbit/s, `vbr`, `balanced` profile for the given codec, mirroring the existing `--self-test-codec <id>`. Task 6 relies on `bitrateMode` and `quality` appearing in `metrics`.

- [ ] **Step 1: Write one failing hardware test in `native-worker.test.mjs`**

`--self-test-vbr h264` exits 0 and its JSON reports `bitrateMode: 'vbr'`, `quality: 'balanced'` and `encodedFrames` greater than zero. Also add one assertion to the existing `--self-test` case that it reports `bitrateMode: 'cbr'`. Do not add H.265 or AV1 cases; Task 7 exercises those encoders. Do not add a before-and-after pipeline diff; the Task 4 unit test pins the CBR fragment and the existing self-tests in this file prove the CBR pipeline still runs.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test native/media-worker/tests/native-worker.test.mjs`
Expected: the new test and the new assertion fail. This file is excluded from `npm test`, so it is run directly, and it needs the GPU.

- [ ] **Step 3: Implement**

Replace only the `rc-mode=cbr bitrate=... gop-size=...` fragment of `pipeline_description` with the table output, leaving preset, tune, `bframes=0`, `zerolatency=true`, the codec's extra properties, caps, the H.264 level suffix and the parser exactly as they are. Add the two metrics members in both places. Add the `--self-test-vbr` argument with the profile above, and update the usage error text at the end of `main` to mention it.

- [ ] **Step 4: Run the required commands**

Run: `.\build-native.cmd`, then `node --test native/media-worker/tests/native-worker.test.mjs`
Expected: builds cleanly, and every test in the file passes, including the existing CBR self-tests.

- [ ] **Step 5: Commit**

Commit message: `feat: build VBR encoder settings in the media worker`

---

### Task 6: Server wire format and session rows (lockstep with Task 5)

**Files:**
- Modify: `apps/server/src/native-media.mjs` (the `streamPlan` object near line 143), `apps/server/src/host-status.mjs` (the stream row near line 54)
- Test: `apps/server/tests/stream-runtime.test.mjs`, `apps/server/tests/host-status.test.mjs`; the fake worker `apps/server/tests/fixtures/media-process.mjs` only if it rejects the two new keys

**Interfaces:**
- Consumes: resolved plan profiles `{ name, width, height, fps, bitrateKbps, bitrateMode, quality, mtu }` from Task 1, and Task 5's worker.
- Produces: the `start` message's `streamPlan` has exactly the seven keys listed in Global Constraints. Each stream row from `host-status.mjs` gains `bitrateMode` and `quality` (both `null` when the session has no resolved profile). The CLI (Task 8) and host app (Task 9) read these two row fields.

- [ ] **Step 1: Write two failing tests**

  1. Wire: find the existing test that inspects the `start` message written to the worker (search `streamPlan` under `apps/server/tests`) and extend it, or add one using the fake worker fixture, so a VBR profile yields a `streamPlan` with exactly the seven keys and the right values, and a default CBR profile yields `cbr` / `balanced`.
  2. Rows: `host-status.test.mjs` shows a session with a VBR profile yielding a stream row with `bitrateMode: 'vbr'` and its quality, and a session without a resolved profile yielding `null` for both.

  Do not write a new hardware or end-to-end test; Step 4 uses an existing one.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test apps/server/tests/stream-runtime.test.mjs apps/server/tests/host-status.test.mjs`
Expected: the two new tests fail.

- [ ] **Step 3: Implement**

Add the two fields to the `streamPlan` object and to the stream row. Change the fake worker fixture only if it rejects the new keys.

- [ ] **Step 4: Run the required commands**

Run: `node --test apps/server/tests/stream-runtime.test.mjs apps/server/tests/host-status.test.mjs`, then once `node --test apps/server/tests/native-media.test.mjs` (needs the GPU and the Task 5 build)
Expected: all pass. The second command is the existing hardware test; it starts the real worker through the server, so it is the one check that the server and the rebuilt worker agree on the seven-key plan.

- [ ] **Step 5: Commit**

Commit message: `feat: send bitrate mode and quality to the worker and session rows`

---

### Task 7: Tune the quality floors on this GPU and check the picture

This task changes numbers, not structure, and runs no test suite. It needs Task 4's table and a GPU, and it uses `gst-launch-1.0` directly, so it does not depend on Tasks 5 and 6.

**Files:**
- Modify: `native/media-worker/src/rate-control.hpp` (the QP table), `native/media-worker/tests/rate-control.cpp` (the two VBR expectations that name floors), `docs/superpowers/specs/2026-09-20-variable-bitrate-design.md` (the table), `docs/investigations/VARIABLE-RATE-INVESTIGATION.md` (a results section)
- Throwaway, not committed: a measurement script and a test page in the scratchpad directory

**Interfaces:**
- Consumes: the property strings produced by `rate_control`, applied through `gst-launch-1.0` from `.deps/gstreamer/bin`.
- Produces: final QP floors per codec and quality, recorded with the measurements that justify them.

- [ ] **Step 1: Rebuild the measurement harness**

Follow the "Method" section of the investigation doc: an Edge kiosk page in a throwaway profile with `static`, `scroll` and `video` content (skip `burst`, which sits between them), and a run of about 450 source buffers per configuration that ends by `num-buffers`, computing kbit/s from output bytes over elapsed time. Details worth keeping: `gst-launch` block-buffers stdout when piped, so end runs by construction rather than by killing; kill only the probe's own Edge processes; the screen is covered while a run is in progress, so tell the user before starting.

- [ ] **Step 2: Measure every codec and quality**

For h264, h265 and av1, run `efficient`, `balanced` and `high` at 2560x1440, 30 fps, `bitrateKbps` 6000, using the property strings from `rate_control`, on the three content modes. That is 27 runs of about 15 seconds.

- [ ] **Step 3: Apply the pass criteria**

For each codec: mean bitrate on `scroll` and `video` content must be strictly ordered `efficient` < `balanced` < `high`; no mean bitrate may exceed the 6000 kbit/s cap; `static` must stay below 20% of the CBR figure from the investigation (4772 kbit/s). Adjust floors and re-measure only the affected codec and quality until they hold. AV1 uses a 0 to 255 scale and its starting numbers are guesses, so expect to change them.

- [ ] **Step 4: Check picture quality by eye, for two levels only**

For each codec, at `efficient` and `balanced` (`high` has a lower floor than `balanced`, so it is sharper by construction), encode about 60 frames of the dense-text `static` page, decode the file with `gst-launch-1.0` and save one late frame as a PNG (for example `filesrc ! parsebin ! <decoder> ! d3d11download ! videoconvert ! pngenc snapshot=true ! filesink`). Open each PNG with the Read tool and judge legibility of the smallest text at 100%. Pass: `balanced` is comfortably readable; `efficient` may look soft but small text must still be readable. Lower the failing level's floor numbers and repeat Steps 2 to 4 for that level only.

- [ ] **Step 5: Record and update**

Write the final floors into the table in `rate-control.hpp` and the matching expectations in `rate-control.cpp`. Replace the spec's "starting values" wording with the tuned values. Append a dated results section to the investigation doc with the measured table and one sentence on the visual check.

- [ ] **Step 6: Build**

Run: `.\build-native.cmd`
Expected: passes with the tuned values.

- [ ] **Step 7: Commit**

Commit message: `feat: tune VBR quality floors per codec`

---

### Task 8: CLI flags, table and completion

**Files:**
- Modify: `apps/server/src/cli/policy-edits.mjs` (defaults near line 3, editable list near line 10, the profile builder near lines 100 to 116), `apps/server/src/cli/commands/profiles.mjs` (value flags near line 16, parsing near lines 20 to 36, usage text near lines 102 and 129), `apps/server/src/cli/format.mjs` (the profiles table near line 85 and the sessions stream listing near line 168), `apps/server/src/cli/completion.mjs`
- Test: `apps/server/tests/cli-policy-edits.test.mjs`, `cli-commands.test.mjs`, `cli-completion.test.mjs`, `cli-parity.test.mjs`

**Interfaces:**
- Consumes: `BITRATE_MODES`, `QUALITY_LEVELS` and the defaults from `rate-control.mjs` (Task 1); stream rows with `bitrateMode` and `quality` (Task 6).
- Produces: flags `--bitrate-mode cbr|vbr` and `--quality efficient|balanced|high` on `profile add` and `profile edit`. A `UsageError` for an invalid value that names the allowed values. The profiles table shows `6 Mbit/s` for CBR and `up to 6 Mbit/s (VBR, balanced)` for VBR in the Bitrate column. The sessions stream listing appends the mode and, for VBR, the quality next to the target it already shows.

- [ ] **Step 1: Write four failing tests and update the parity script**

  1. `cli-policy-edits`: a new profile defaults to `cbr` / `balanced`, and editing sets each field independently, with `quality` accepted on a CBR profile.
  2. `cli-commands`: `profile add "X" --bitrate-mode vbr --quality high` produces the expected edit, and an invalid mode produces a usage error that lists the allowed values. One case covers `edit`; do not repeat every combination.
  3. Formatting: a VBR profile row in the profiles table reads `up to 6 Mbit/s (VBR, balanced)`. The CBR row is already covered by existing tests.
  4. `cli-completion`: after `--bitrate-mode` the candidates are `cbr` and `vbr`, and after `--quality` the three levels.
  5. `cli-parity`: it walks every key of the first policy profile except `id` and `frameDelivery`, so `bitrateMode` and `quality` now need coverage. This is a required update, not an added test: add commands that set both to its scripted command list so the check passes.

  The sessions listing change has no new test; update an existing expectation only if it breaks.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test apps/server/tests/cli-policy-edits.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs apps/server/tests/cli-parity.test.mjs`
Expected: the new tests fail, and the parity test fails on the two uncovered fields.

- [ ] **Step 3: Implement**

Follow the existing flag and validation style in `commands/profiles.mjs`. Keep the `profile add` summary's stated defaults accurate, and add one sentence saying a VBR profile treats the bitrate as a sustained cap.

- [ ] **Step 4: Run the required tests**

Run: the command from Step 2.
Expected: all pass. No full-suite run; Task 12 runs it once.

- [ ] **Step 5: Format and commit**

Commit message: `feat: set bitrate mode and quality from the CLI`

---

### Task 9: Windows host app editor, profile rows and sessions

**Files:**
- Modify: `apps/windows-host/HostWindow.Profiles.cs` (the row labels near line 151, the new-profile object near line 210, the editor fields near lines 217 to 222), `apps/windows-host/HostWindow.Sessions.cs` (the Profile line near line 165)
- Test: `apps/windows-host/tests/Navigation/App.xaml.cs` (the fixture policy JSON near line 56 and the profile assertions near lines 256 to 290)

**Interfaces:**
- Consumes: the policy fields `bitrateMode` (`cbr` or `vbr`) and `quality` from Task 1, saved back in the same shape; stream rows with `bitrateMode` and `quality` from Task 6. A row without them must render exactly as it does today.
- Produces: no new interfaces for other tasks.

Required behaviour:
  - The profile editor gains a Bitrate mode choice (Constant or Variable) and a Quality choice (Efficient, Balanced or High). Quality is enabled only for Variable. Under Variable, the bitrate field's title reads "Maximum sustained bitrate (kbit/s)"; under Constant it keeps today's title.
  - The saved policy JSON carries `bitrateMode` and `quality` for every profile. The new-profile default object gains `cbr` and `balanced`.
  - The Video bitrate cell in a profile row shows `6 Mbit/s` for Constant and `up to 6 Mbit/s · Variable` for Variable.
  - The Sessions page Profile line appends ` · Variable (High)` (with the row's quality) for a Variable stream, and is unchanged otherwise.

- [ ] **Step 1: Update the fixture and add one assertion block**

Add `bitrateMode: "cbr"` and `quality: "balanced"` to the fixture's existing profile, and add a second fixture profile that is `vbr` / `high`. In the profiles assertions add one block checking that the Variable profile's row text contains `up to` and `Variable`, and that its editor exposes controls titled `Bitrate mode` and `Quality`. Add nothing else.

- [ ] **Step 2: Build and confirm the assertion fails**

Run: `dotnet build apps/windows-host/tests/Navigation/Navigation.csproj -c Debug`, then run the Navigation regression as written in `apps/windows-host/tests/Navigation/README.md`.
Expected: the new assertion block fails.

- [ ] **Step 3: Implement**

Follow the existing control-building style in `HostWindow.Profiles.cs`. Read the two policy members defensively so a profile from an older policy still shows as Constant.

- [ ] **Step 4: Run the required commands**

Run: `dotnet build apps/windows-host/VidVnc.Host.csproj`, then the Navigation regression once.
Expected: the build succeeds and the regression passes, including all its existing assertions.

- [ ] **Step 5: Commit**

Commit message: `feat: edit bitrate mode and quality in the host app`

---

### Task 10: Web client labels

**Files:**
- Create: `apps/web-client/src/profile-labels.js`, `apps/web-client/tests/profile-labels.test.mjs`
- Modify: `apps/web-client/src/app.js` (the profile picker summary near line 276), `apps/web-client/src/diagnostics.js` (the Targets line near line 124), `apps/server/src/http-app.mjs` (the static asset allowlist near line 152), `apps/server/tests/http-security.test.mjs` (the asset list near line 28)

**Interfaces:**
- Consumes: catalog profiles and the diagnostics profile, which already carry `bitrateMode` and `quality` because the server passes whole policy profiles through.
- Produces: `apps/web-client/src/profile-labels.js` exporting two pure functions. `bitrateText(profile)` returns `6 Mbit/s` for a CBR profile or one with no mode, and `up to 6 Mbit/s` for VBR. `targetBitrateText(profile)` returns `6000 kbit/s` for CBR or no mode, and `VBR up to 6000 kbit/s` for VBR. Both take `bitrateKbps` and `bitrateMode` from the argument.

- [ ] **Step 1: Write one failing test file**

`profile-labels.test.mjs` with one test per function: CBR and missing mode give the plain text, VBR gives the `up to` text.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test apps/web-client/tests/profile-labels.test.mjs`
Expected: fails because the module does not exist.

- [ ] **Step 3: Implement and wire in**

Create the module, use `bitrateText` in the profile picker summary and `targetBitrateText` in the diagnostics Targets line. Add `/profile-labels.js` to the allowlist in `http-app.mjs`. Without that line the module returns 404 and the whole client page fails to load, and no unit test would notice. Guard against that with one line, not a new test: add `'/profile-labels.js'` to the asset list in the existing "serves every browser entry asset" test in `http-security.test.mjs`.

- [ ] **Step 4: Run the required tests**

Run: `node --test apps/web-client/tests/profile-labels.test.mjs apps/server/tests/http-security.test.mjs`
Expected: both pass. No browser check.

- [ ] **Step 5: Format and commit**

Commit message: `feat: label variable bitrate profiles in the web client`

---

### Task 11: Documentation

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Update the README**

Where the README describes streaming profiles, add two or three sentences: a profile can be variable bitrate with a quality level; the bitrate is then the sustained cap; VBR profiles use a 10 second keyframe interval, so recovery from packet loss relies on the client's keyframe request; existing profiles stay constant bitrate. Also list the two new CLI flags if the README lists profile flags.

- [ ] **Step 2: Update the roadmap**

In the "Adaptive Automatic quality" section, add a sentence linking the investigation and the VBR design, noting that the encoder properties for bitrate, peak, quality floor and GOP are changeable while streaming and that this was not yet exercised.

- [ ] **Step 3: Leave the changelog alone**

Release notes are written at release time, as the repository does for its other releases. Do not add an entry now. Suggested wording for that entry: "Added: variable bitrate profiles with a quality level, for much lower bandwidth on idle and light-motion screens."

- [ ] **Step 4: Commit**

No tests. Commit message: `docs: describe variable bitrate profiles`

---

### Task 12: Final gate

- [ ] **Step 1: Format check**

Run: `npm run format:check`
Expected: passes. If it fails, run `npm run format` and include the formatting in the affected task's files.

- [ ] **Step 2: Full server suite, once**

Run: `node tools/test.mjs server`
Expected: all pass. This is the second and last full server run.

- [ ] **Step 3: Confirm the spec is satisfied by pointing at the code**

Without running anything, check each spec section against the merged files: policy fields and normalisation (Task 1), registry key (Task 2), seven-key plan and enums (Task 3), rate-control table and 10 second GOP (Tasks 4 and 5), session rows (Task 6), tuned floors recorded (Task 7), CLI, host app and web client (Tasks 8 to 10), docs (Task 11). Report anything without a matching change.

- [ ] **Step 4: Report, do not run extra suites**

Report what was run and what passed. State plainly that no end-to-end browser or packaging suite was run, and that the loss-recovery and long-GOP iPhone checks in the spec are still outstanding before the seeded profiles may move to VBR.

- [ ] **Step 5: Commit any remaining changes**

Only if the format step changed files. Commit message: `chore: format variable bitrate changes`
