# Hardware Encoder Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run VidVNC on Intel and AMD graphics, integrated and discrete, by adding Quick Sync, AMF and Media Foundation encoder backends beside NVENC, with automatic per-machine selection that prefers the GPU the frame was captured on.

**Architecture:** The one-encoder-per-codec assumption in `video-codec.hpp` splits into a codec table (bitstream facts) and a backend table (each vendor's property dialect). Encoder properties stop being concatenated from literals and are instead built by asking the GStreamer element class which properties exist and what their numeric ranges are, so a property a backend lacks is skipped rather than failing pipeline parse, and the measured NVENC quality floors are stored as fractions and rescaled onto whatever QP range the target element declares. A backend is advertised only after passing a real short encode. The server learns backends from the probe as data and never names an element.

**Tech Stack:** C++17 native worker (MSVC `/W4`, GStreamer 1.28.6, GObject introspection via `g_object_class_find_property`); Node.js ESM server and CLI (`node --test`); WinUI 3 (.NET) host app; plain JavaScript web client.

**Spec:** [docs/superpowers/specs/2026-09-21-hardware-encoders-design.md](../specs/2026-09-21-hardware-encoders-design.md). Prior rate-control measurements this plan must not regress: [docs/investigations/VARIABLE-RATE-INVESTIGATION.md](../../investigations/VARIABLE-RATE-INVESTIGATION.md).

## Global Constraints

Every task's requirements include these, copied from the spec.

- Backend ids are exactly `nvenc`, `qsv`, `amf`, `mediafoundation`. The policy value `auto` means automatic selection and is the default.
- Codec ids do not change: `h264`, `h265`, `av1`. The backend never appears in the protocol to clients, in the SDP, or in any client-visible surface.
- Element names per backend and codec: NVENC `nvd3d11h264enc` / `nvd3d11h265enc` / `nvd3d11av1enc`; QSV `qsvh264enc` / `qsvh265enc` / `qsvav1enc`; AMF `amfh264enc` / `amfh265enc` / `amfav1enc`; Media Foundation `mfh264enc` / `mfh265enc` and **no AV1 encoder**.
- Property dialects, exactly. NVENC: `rc-mode` with `cbr`/`vbr`, `bitrate`, `max-bitrate`, `gop-size`, `bframes`, `qp-min-i`, `qp-min-p`, low-latency fragment `preset=p3 tune=ultra-low-latency zerolatency=true`, header repeat `repeat-sequence-header=true`. QSV: `rate-control` with `cbr`/`vbr`, `bitrate`, `max-bitrate`, `gop-size`, `b-frames`, `min-qp-i`, `min-qp-p`, **no low-latency property**, add `ref-frames=1`. AMF: `rate-control` with `cbr`/`vbr`, `bitrate`, `max-bitrate`, `gop-size`, `b-frames`, low-latency fragment `usage=ultra-low-latency preset=speed`, and QP floors that **vary by codec** — see the next constraint. Media Foundation: `rc-mode` with `cbr` and **`pcvbr` (there is no plain `vbr`)**, `bitrate`, `max-bitrate`, `gop-size`, `bframes`, a **single** `min-qp` covering all frame types, low-latency fragment `low-latency=true`.
- Bitrate and max-bitrate are in kbit/s on every backend. `bitrateKbps` keeps its range of 100 to 50000; under VBR it is the sustained cap and the peak is twice it.
- Where a backend declares a single QP floor property rather than one per frame type, the I-frame floor is applied to it and the P-frame floor is dropped.
- A family's QP floor is an **ordered list of candidate property names**, not one name, because AMF differs across its own codecs. Verified against the installed elements on 2026-09-21: `amfh264enc` has a global `min-qp` and `b-frames`; `amfh265enc` has `min-qp-i` and `min-qp-p` and **no** `b-frames`; `amfav1enc` has none of the three. AMF's I-floor candidates are therefore `min-qp-i` then `min-qp`, and its P-floor candidate is `min-qp-p`. The first candidate the element declares is emitted; if it declares none, the floor is dropped and logged. Emitting a name an element lacks is not ignored — `gst_parse_launch` refuses the whole pipeline and the backend is lost.
- QP floors are stored normalised as a fraction of the property's declared range and rescaled per element. Rescaling onto NVENC's declared ranges must reproduce today's literal values: H.264 and H.265 `efficient` 30/34, `balanced` 24/28, `high` 20/24; AV1 `efficient` 150/170, `balanced` 120/140, `high` 100/120.
- A property the element class does not declare is skipped and logged, never emitted.
- Minimum input dimensions come from the element, not the codec. `MINIMUM_DIMENSIONS` in `video-codecs.mjs` is deleted. Known floors: NVENC AV1 192x128, NVENC H.265 144x48, QSV 16x16, AMF 128x128, Media Foundation 64x64.
- `schemaVersion` stays 1. A saved stream policy without `encoderBackend` loads as `auto`. An unknown value is rejected with exactly `Encoder backend is invalid`.
- A forced backend that is unavailable falls back to automatic selection and records the substitution. It never fails the session.
- `preflight` requires at least one backend with a working H.264 encoder plus `h264parse` and `rtph264pay`, not NVENC specifically. All other currently-required elements stay hard requirements.
- Availability means a passed short real encode, not a found element factory. Self-test results are not cached in this version.
- Backend selection happens once at stream start and never changes mid-session.
- Selection order: same-adapter elements first, then other-adapter elements, then elements with no `adapter-luid`; ties break `nvenc`, `qsv`, `amf`, `mediafoundation`.
- Not in scope: software encoding, software capture, Direct3D 12 encoding, VP9, 10-bit or HDR, multi-GPU load balancing, changing backend mid-session, re-tuning the NVENC VBR floors.
- NVENC behaviour must not change. It is the backend already in production use, and every task that touches shared code must prove NVENC's emitted properties are unchanged. AMF and Media Foundation can also be exercised on the development machine; only Quick Sync cannot.
- Platform: Windows 11 25H2 (build 26200) and an NVIDIA GPU for GPU steps; Node 20.6 or newer; C++17 with MSVC `/W4`.
- Formatting: run `npm run format` before committing. `npm run format:check` must pass.
- Commits: conventional style (`feat:`, `test:`, `refactor:`, `docs:`), ending with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Commit steps below apply only when the user has authorised commits for the execution session; otherwise stop after the verification step and leave the work uncommitted.
- This plan contains no implementation code by design. Each task lists required behaviour, exact names and test cases; the implementer writes the code test-first.

## Test policy: what MUST be run, and nothing else

Principles:

- Write few tests. Each new test proves one behaviour no existing test covers. The development machine has an AMD Radeon integrated GPU and an NVIDIA RTX 5060 Ti, so NVENC, AMF and Media Foundation can all be exercised for real and must be; only Quick Sync cannot. Do not write tests that pretend to exercise Quick Sync — test the tables and the arithmetic, which are pure, and let the self-test gate cover it at runtime.
- Write no new end-to-end tests. The existing hardware tests named below are the only cross-process proof.
- Run only the commands in this table, at the step where the task says so. Do not widen a run "to be safe".

| Task | MUST run | Why this and nothing more |
| --- | --- | --- |
| 1 | `.\build-native.cmd` | It is the only way to build, and it runs the C++ unit tests in seconds. The new table is pure. |
| 2 | `.\build-native.cmd` | Same. The normalised-floor arithmetic is pure and its regression test lives in the native suite. |
| 3 | `.\build-native.cmd` | Same. Introspection needs a real GStreamer registry, which the native test environment already has on `PATH`. |
| 4 | `.\build-native.cmd` | Same. The ranking is pure and needs no GPU. |
| 5 | `.\build-native.cmd`, then `node --test native/media-worker/tests/native-worker.test.mjs` (needs the GPU) | The only proof that selection, the new probe shape and the two-argument self-test work against real elements. It also re-runs the existing NVENC self-tests, which guards NVENC. |
| 6 | `node --test apps/server/tests/stream-policy.test.mjs`, then once `node tools/test.mjs server` | The policy shape changes, so an existing test elsewhere may assert it. This is the one full server run for the server-side tasks. |
| 7 | `node --test apps/server/tests/video-codecs.test.mjs`, then `node --test apps/server/tests/native-media.test.mjs` (needs the GPU and the Task 5 build) | `MINIMUM_DIMENSIONS` is deleted and codec selection is reworked; those two files own that logic. |
| 8 | `node --test apps/server/tests/stream-runtime.test.mjs apps/server/tests/host-status.test.mjs` | Only the plan hand-off and status projection changed. |
| 9 | `node --test apps/server/tests/cli-policy-edits.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs apps/server/tests/cli-parity.test.mjs` | The parity test walks every policy field, so it must run. |
| 10 | `dotnet build apps/windows-host/VidVnc.Host.csproj`, then the Navigation regression once, as written in `apps/windows-host/tests/Navigation/README.md` | The Codecs page changes, and the regression is the only test that compiles and opens it. |
| 11 | `node --test packaging/tests/staging.test.mjs packaging/tests/pe-dependencies.test.mjs` | Only the plugin manifest changed; these own staging and the dependency walk. Do not build a package here. |
| 12 | None (documentation only) | |
| 13 | `npm run format:check`, then once `node tools/test.mjs server`, then `npm run package` | The final gate. The package build is required exactly once, here, because Task 11 changed what ships and nothing before this proves the new plugins stage and sign. |

Never run for this work: `npm run test:hardware` as a whole, anything under `tests/system`, the web client browser checks (`stream-browser-check.mjs`, `web-browser-check.mjs`, `toolbar-browser-check.mjs`), or the multi-stream and shared-stream checks. If a required run fails for a reason unrelated to this work, stop and report it instead of widening the run.

## Cluster gates (2026-09-21, user instruction)

The per-task runs above stay as the inner loop. On top of them, tasks land in clusters,
and **each cluster ends with `npm test` and a commit**. A cluster that does not pass is
not committed.

`npm test` is the portable suite: every Node `.test.mjs` except `native-media.test.mjs`
and `native-worker.test.mjs`. It does not build or run the C++ unit tests and it does not
touch the GPU, so native clusters must run `.\build-native.cmd` as well — `npm test`
alone would prove nothing about Tasks 1 to 4.

| Cluster | Tasks | Gate, in order |
| --- | --- | --- |
| A | 1, 2, 3 | `.\build-native.cmd`, then `npm test` |
| B | 4, 5 | `.\build-native.cmd`, then `node --test native/media-worker/tests/native-worker.test.mjs` (GPU), then `npm test` |
| C | 6, 7, 8 | `node --test apps/server/tests/native-media.test.mjs` (GPU), then `npm test` |
| D | 9, 10 | `dotnet build apps/windows-host/VidVnc.Host.csproj`, the Navigation regression once, then `npm test` |
| E | 11, 12 | `npm test` |
| F | 13 | `npm run format:check`, `npm test`, `npm run package`, then `node --test native/media-worker/tests/native-worker.test.mjs` |

Cluster A is indivisible: Task 1 removes `encoder` from `VideoCodec` while
`media-worker.cpp` still uses it, and Task 3 restores the build. Do not stop inside it.

Clusters B and C are the probe-shape lockstep pair and should land back to back. Between
them the server still starts, because Task 5 only adds `backends` to the probe and Task 7
treats a missing `backends` as an empty array.

**Cluster B also carries the AMF and Media Foundation verification**, because that is the
first point at which a real encoder can be driven through the new code, and because the
development machine can do it. Beyond the automated cases in Task 5, record by hand and
paste into the cluster's report:

- The property string built for each of `nvenc`, `amf` and `mediafoundation`, for H.264 in
  CBR and in VBR `balanced`. This is the only direct look at what the dialects produce.
  Confirm Media Foundation emits `rc-mode=pcvbr` and a single `min-qp`, and that AMF emits
  `usage=ultra-low-latency preset=speed`.
- Which codecs each backend's self-test accepted and which it rejected. AMF advertises AV1
  only on RDNA3 and newer, so a rejection there is expected behaviour, not a failure.
- Which adapter the capture resolved to, and which backend won the ranking as a result.

**Cluster F additionally runs one interactive session on AMF**, forced through the host
override. A passing self-test proves the encoder accepts caps; it does not prove the stream
is usable. Only Quick Sync ships without this treatment.

Commits are authorised for this execution session: one commit per task as each task's
step 5 describes, and the cluster gate must pass before the cluster's last commit.

Useful single-purpose commands: `node --test <file>` for one Node test file, and `.\build-native.cmd` for the native build, which formats, configures, builds and runs every C++ test.

## File structure

New files:

- `native/media-worker/src/encoder-backend.hpp`: the backend table. One responsibility — given a backend id and a codec id, name the element; given a backend id, name its property dialect and its minimum input dimensions. Pure data and lookup, no GStreamer calls.
- `native/media-worker/tests/encoder-backend.cpp`: its unit test.
- `native/media-worker/src/encoder-properties.hpp`: turns a rate-control intent plus a backend and an element name into a property string, by introspecting the element class. The only file that calls `g_object_class_find_property`.
- `native/media-worker/tests/encoder-properties.cpp`: its unit test. Links the GStreamer SDK.
- `native/media-worker/src/encoder-selection.hpp`: ranks candidate backends for a capture adapter and picks one. Pure ranking over a list of candidates; the GStreamer queries that build that list live in `media-worker.cpp`.
- `native/media-worker/tests/encoder-selection.cpp`: its unit test.
- `apps/server/src/encoder-backends.mjs`: the allowed backend values and the default, mirroring `video-codecs.mjs` and `rate-control.mjs`.

Modified files, by layer:

- Native: `native/media-worker/src/video-codec.hpp` (loses `encoder` and `encoder_extra`), `rate-control.hpp` (returns intent, not a string), `media-worker.cpp` (preflight, probe, selection, self-test arguments, `start_source`), `CMakeLists.txt` (three new tests).
- Native tests: `native/media-worker/tests/video-codec.cpp`, `rate-control.cpp`, `native-worker.test.mjs`.
- Server: `apps/server/src/stream-policy.mjs`, `video-codecs.mjs`, `native-media.mjs`, `stream-runtime.mjs`, `host-status.mjs`, `diagnostics.mjs`.
- CLI: `apps/server/src/cli/policy-edits.mjs`, `cli/commands/settings.mjs`, `cli/format.mjs`, `cli/completion.mjs`.
- Host app: `apps/windows-host/HostWindow.Codecs.cs` and the Navigation test project.
- Packaging: `packaging/windows/inputs.json`.
- Docs: `README.md`, `docs/ROADMAP.md`, `docs/PACKAGING.md`.

The web client is deliberately absent. The backend is never visible to clients.

## Ordering notes

- Tasks 1 to 4 are pure — no GPU, no GStreamer element beyond the core ones any install has. Nothing observable changes until Task 5 wires them in.
- Task 2 is a refactor with a hard regression gate: `rate_control` stops returning a property string, so the NVENC strings it used to produce must be reproduced exactly by Task 3's builder. Do not land Task 2 without Task 3 following immediately — between them, no caller can build an encoder.
- Tasks 5 and 7 are a lockstep pair on the probe shape: Task 5 changes what `--probe` emits and Task 7 changes what the server reads. Land them together. Server unit tests stay green in between because they use a fake worker, but a real stream does not start between them.
- Task 6 changes no wire format and can land before or after the native tasks.
- Task 8 needs Tasks 5 and 6. Tasks 9, 10 and 12 are independent of each other and need Task 6's field. Task 11 is independent of everything. Task 13 comes last.

---

### Task 1: Backend table and the codec table split

**Files:**
- Create: `native/media-worker/src/encoder-backend.hpp`, `native/media-worker/tests/encoder-backend.cpp`
- Modify: `native/media-worker/src/video-codec.hpp`, `native/media-worker/tests/video-codec.cpp`, `native/media-worker/CMakeLists.txt`
- Note: `media-worker.cpp` still references `video_codec->encoder` and `->encoder_extra` and will not compile after this task alone. Task 3 restores it. Keep the two tasks adjacent.

**Interfaces:**
- Consumes: the existing `VideoCodec` table and `find_video_codec` in `video-codec.hpp`.
- Produces, in `encoder-backend.hpp`:
  - `struct PropertyValue { std::string property; std::string value; }`.
  - `struct Dimensions { int width; int height; }`.
  - `struct EncoderDialect` with `std::string rc_mode_property`, `cbr_value`, `vbr_value`, `bitrate_property`, `max_bitrate_property`, `gop_property`, `bframes_property`, `qp_floor_i_property`, `qp_floor_p_property` (empty means the backend has a single floor and the P floor is dropped), `header_repeat_property` (empty means none), and `std::vector<PropertyValue> low_latency`.
  - `struct EncoderBackend` with `std::string id`, `std::string label`, `EncoderDialect dialect`, and a per-codec element name and minimum dimensions.
  - `const std::vector<EncoderBackend> &encoder_backends()` returning the four backends in the fixed tie-break order `nvenc`, `qsv`, `amf`, `mediafoundation`.
  - `const EncoderBackend *find_encoder_backend(const std::string &id)`, null for unknown.
  - `std::string encoder_element(const EncoderBackend &, const std::string &codec_id)`, empty when that backend has no encoder for that codec.
  - `Dimensions encoder_minimum(const EncoderBackend &, const std::string &codec_id)`.
- Also produces: `VideoCodec` with `encoder` and `encoder_extra` **removed**. All other fields keep their current names and values.

- [x] **Step 1: Write the failing test in `tests/encoder-backend.cpp`**

  Six cases, all pure assertions over the table:

  1. Element names: for each of `nvenc`, `qsv`, `amf`, `encoder_element` returns the three names listed in Global Constraints for `h264`, `h265`, `av1`. For `mediafoundation` it returns `mfh264enc` and `mfh265enc`, and an **empty string** for `av1`. An unknown codec id returns empty for every backend.
  2. Lookup: `find_encoder_backend` returns a backend for each of the four ids and null for `auto`, for the empty string, and for an unknown id. `auto` is a policy value, not a backend, and must not resolve here.
  3. Order: `encoder_backends()` yields ids in exactly the order `nvenc`, `qsv`, `amf`, `mediafoundation`.
  4. Dialect completeness: for every backend, `rc_mode_property`, `cbr_value`, `vbr_value`, `bitrate_property`, `max_bitrate_property`, `gop_property`, `bframes_property` and `qp_floor_i_property` are all non-empty. `qp_floor_p_property` is empty for `mediafoundation` only. This test is the guard that a later edit cannot silently leave a backend half-declared.
  5. Dialect values: `mediafoundation`'s `vbr_value` is `pcvbr` and the other three are `vbr`; `nvenc` and `mediafoundation` use `rc-mode` while `qsv` and `amf` use `rate-control`; `nvenc` and `mediafoundation` use `bframes` while `qsv` and `amf` use `b-frames`; `qsv`'s `low_latency` list contains `ref-frames` with value `1` and contains no `preset` or `usage`; `nvenc`'s `header_repeat_property` is `repeat-sequence-header` and the other three are empty.
  6. Minimums: `nvenc` gives 192x128 for `av1` and 144x48 for `h265`; `qsv` gives 16x16, `amf` 128x128 and `mediafoundation` 64x64 for every codec they support.

  Do not test the `VideoCodec` fields that did not change; `tests/video-codec.cpp` already covers them.

- [x] **Step 2: Run the build and confirm the new test fails**

Run: `.\build-native.cmd`
Expected: `encoder-backend-test` fails to compile or fails its assertions because `encoder-backend.hpp` does not exist yet.

- [x] **Step 3: Implement**

  - Create `encoder-backend.hpp` with the structures and the four-entry table, using the exact element names, property spellings, low-latency pairs and minimum dimensions from Global Constraints.
  - Remove `encoder` and `encoder_extra` from `VideoCodec` and from the three rows of `video_codecs()`. Leave every other field untouched, including the caps strings and the H.264 `level=(string)3.1` logic's inputs.
  - Update `tests/video-codec.cpp` to drop any assertion on the two removed fields.
  - Register `encoder-backend` in the `CMakeLists.txt` test loop.

- [x] **Step 4: Run the required test**

Run: `.\build-native.cmd`
Expected: `media-worker.encoder-backend` and `media-worker.video-codec` pass. The `media-worker` executable itself does not build yet; that is expected and is resolved in Task 3.

- [x] **Step 5: Format and commit**

Run: `npm run format`, then `git add native/media-worker/src/encoder-backend.hpp native/media-worker/src/video-codec.hpp native/media-worker/tests/encoder-backend.cpp native/media-worker/tests/video-codec.cpp native/media-worker/CMakeLists.txt`
Commit message: `refactor: split encoder backends out of the video codec table`

---

### Task 2: Rate control returns intent with normalised quality floors

**Files:**
- Modify: `native/media-worker/src/rate-control.hpp`, `native/media-worker/tests/rate-control.cpp`

**Interfaces:**
- Consumes: `StreamProfile` (`stream-profile.hpp`) and `find_video_codec` unchanged.
- Produces:
  - `enum class RateMode { Cbr, Vbr }`.
  - `struct RateControl { RateMode mode; int bitrate_kbps; int max_bitrate_kbps; int gop_frames; double qp_floor_i; double qp_floor_p; }`. Under CBR, `max_bitrate_kbps` is 0 and both floors are -1, meaning "not requested". Under VBR the floors are fractions in the range 0 to 1 inclusive.
  - `RateControl rate_control(const std::string &codec_id, const StreamProfile &)` — same name and arguments as today, new return type. It still throws `std::invalid_argument` with the message `unknown video codec: <id>` for an unknown codec.
  - `int qp_reference_maximum(const std::string &codec_id)` returning 51 for `h264` and `h265` and 255 for `av1`. This is the scale the measured NVENC values were expressed on, and is the reference the normalisation divides by.
- Removed: the old `RateControl { std::string properties; int gop_frames; }` and the `QpFloors` struct returning integers. The literal tables move into the normalisation.

- [x] **Step 1: Write the failing tests in `tests/rate-control.cpp`**

  Four cases. Rewrite the existing file's expectations rather than adding alongside them; the old string assertions cannot survive the type change.

  1. Floor round-trip, the regression that matters. For each codec (`h264`, `h265`, `av1`) and each quality (`efficient`, `balanced`, `high`), the returned `qp_floor_i` and `qp_floor_p`, multiplied by `qp_reference_maximum(codec)` and rounded half away from zero, equal the values in Global Constraints — 30/34, 24/28, 20/24 for H.264 and H.265; 150/170, 120/140, 100/120 for AV1. Eighteen assertions, and they are the proof that the refactor preserved the measured tuning.
  2. CBR intent: a CBR profile returns `RateMode::Cbr`, `bitrate_kbps` equal to the profile's bitrate, `max_bitrate_kbps` 0, `gop_frames` equal to the profile's fps, and both floors -1.
  3. VBR intent: a VBR profile returns `RateMode::Vbr`, `max_bitrate_kbps` twice the profile's bitrate, and `gop_frames` equal to fps times 10.
  4. Unknown codec still throws `std::invalid_argument`.

- [x] **Step 2: Run the build and confirm the tests fail**

Run: `.\build-native.cmd`
Expected: `rate-control-test` fails to compile against the new struct.

- [x] **Step 3: Implement**

  - Replace the `RateControl` struct and delete the property-string construction. Keep the two literal floor tables exactly as they are today and divide each by `qp_reference_maximum` for the codec to produce the fractions.
  - Keep the existing CBR and VBR branch conditions, the doubling of the bitrate for the peak, and the ten-second GOP, all unchanged in meaning.
  - Do not clamp or round here. Scaling onto a real element's range is Task 3's job, and rounding twice would lose the round-trip.

- [x] **Step 4: Run the required test**

Run: `.\build-native.cmd`
Expected: `media-worker.rate-control` passes, including all eighteen round-trip assertions.

- [x] **Step 5: Format and commit**

Run: `npm run format`, then `git add native/media-worker/src/rate-control.hpp native/media-worker/tests/rate-control.cpp`
Commit message: `refactor: express quality floors as fractions of the qp range`

---

### Task 3: Build encoder properties by introspection

**Files:**
- Create: `native/media-worker/src/encoder-properties.hpp`, `native/media-worker/tests/encoder-properties.cpp`
- Modify: `native/media-worker/src/media-worker.cpp`, `native/media-worker/CMakeLists.txt`

**Interfaces:**
- Consumes: `EncoderBackend` and `EncoderDialect` (Task 1), `RateControl` and `RateMode` (Task 2).
- Produces:
  - `int scale_qp_floor(double normalised, GParamSpec *spec)` — reads the declared minimum and maximum from a `GParamSpecInt` or `GParamSpecUInt`, multiplies the fraction by the maximum, rounds half away from zero, and clamps into the declared range.
  - `struct EncoderProperties { std::string text; std::vector<std::string> skipped; }`.
  - `EncoderProperties encoder_properties(const EncoderBackend &, const std::string &element_name, const std::string &codec_id, const RateControl &)` — returns the property text for the element and the names of every property that was wanted but not declared.
- Emission order, which must be stable because this task's NVENC regression asserts an exact string: the backend's `low_latency` pairs in declared order, then the rate-control mode, the target bitrate, the peak bitrate (VBR only), the I floor, the P floor (VBR only, and only when `qp_floor_p_property` is non-empty), the GOP length, then the B-frame property with value `0`, then the header repeat property with value `true` when the backend declares one and the codec is `h264`.

- [x] **Step 1: Write the failing tests in `tests/encoder-properties.cpp`**

  Four cases. The test links the GStreamer SDK and calls `gst_init`, but must not require any vendor hardware.

  1. `scale_qp_floor` arithmetic, using parameter specifications built directly with `g_param_spec_int` and `g_param_spec_uint` so no element is needed: the fraction for H.264 `balanced` I (24/51) onto a 0-to-51 maximum gives 24; the AV1 `balanced` I fraction (120/255) onto a 0-to-255 maximum gives 120; the same fraction onto a 0-to-51 maximum gives 24, proving cross-scale conversion; a value above the declared maximum clamps to it; a value below the declared minimum clamps up to it; a maximum of 0 yields the minimum without dividing by zero.
  2. Presence and absence, using the core element `identity`, which every GStreamer install has: a dialect naming a property `identity` really has is emitted with its value; a dialect naming a property it does not have is omitted from `text` and listed in `skipped`. This proves the skip path without needing Intel or AMD hardware.
  3. Media Foundation's single floor: a dialect with an empty `qp_floor_p_property` emits the I floor only, and does not list the P floor as skipped, because it was never wanted.
  4. NVENC regression, the gate on this whole refactor. Guarded so it is skipped when `nvd3d11h264enc` is not registered. For a 1920x1080 30 fps 6000 kbit/s profile, the H.264 CBR text equals exactly `preset=p3 tune=ultra-low-latency rc-mode=cbr bitrate=6000 gop-size=30 bframes=0 zerolatency=true repeat-sequence-header=true`, and the VBR `balanced` text equals the same with `rc-mode=vbr bitrate=6000 max-bitrate=12000 qp-min-i=24 qp-min-p=28 gop-size=300` in place of the CBR middle. Assert H.265 CBR too, which differs only by having no `repeat-sequence-header`.

- [x] **Step 2: Run the build and confirm the tests fail**

Run: `.\build-native.cmd`
Expected: `encoder-properties-test` fails to compile because the header does not exist.

- [x] **Step 3: Implement**

  - Create `encoder-properties.hpp`. Obtain the element class by finding the factory for `element_name`, loading it, and taking its type's class; release what you take. Use `g_object_class_find_property` for every wanted property and skip what is absent.
  - Emit in the order fixed above. Values are formatted as plain integers or literal strings, with a single space between pairs and no leading or trailing space.
  - In `media-worker.cpp`, replace the encoder section of `pipeline_description` so it calls `encoder_properties` for the selected backend and element instead of concatenating `preset=p3 tune=ultra-low-latency`, the old `rate_control(...).properties`, `bframes=0 zerolatency=true` and `video_codec->encoder_extra`. Until Task 5 lands, hardcode the backend to `nvenc` at the single call site so the worker keeps building and behaving exactly as before.
  - Log every skipped property name once per pipeline build to the existing worker log.
  - Register `encoder-properties` in the `CMakeLists.txt` test loop and link it against `gstreamer_sdk`.

- [x] **Step 4: Run the required test**

Run: `.\build-native.cmd`
Expected: `media-worker.encoder-properties` passes, the NVENC case included on this machine, and the `media-worker` executable builds again.

- [x] **Step 5: Format and commit**

Run: `npm run format`, then `git add native/media-worker/src/encoder-properties.hpp native/media-worker/tests/encoder-properties.cpp native/media-worker/src/media-worker.cpp native/media-worker/CMakeLists.txt`
Commit message: `feat: build encoder properties from element introspection`

---

### Task 4: Backend ranking

**Files:**
- Create: `native/media-worker/src/encoder-selection.hpp`, `native/media-worker/tests/encoder-selection.cpp`
- Modify: `native/media-worker/CMakeLists.txt`

**Interfaces:**
- Consumes: `encoder_backends()` order (Task 1).
- Produces:
  - `struct EncoderCandidate { std::string backend_id; std::string element_name; bool has_adapter; gint64 adapter_luid; }`.
  - `enum class SelectionReason { AdapterMatch, FixedOrder, Forced, ForcedUnavailable }`.
  - `struct Selection { bool found; EncoderCandidate candidate; SelectionReason reason; }`.
  - `Selection select_encoder(const std::vector<EncoderCandidate> &candidates, bool capture_adapter_known, gint64 capture_adapter_luid, const std::string &forced_backend_id)` — `forced_backend_id` is `auto` or empty for automatic.

  Ranking, highest first: a candidate whose `has_adapter` is true and whose `adapter_luid` equals the capture adapter; then a candidate whose `has_adapter` is true with a different adapter; then a candidate with `has_adapter` false. Within a rank, the earlier backend in `encoder_backends()` order wins. When the capture adapter is unknown, every candidate falls into the second rank and the fixed order alone decides.

- [x] **Step 1: Write the failing tests in `tests/encoder-selection.cpp`**

  Six cases, all pure:

  1. Adapter match beats fixed order: given an `amf` candidate on the capture adapter and an `nvenc` candidate on another adapter, `amf` is chosen with reason `AdapterMatch`, even though `nvenc` sorts first.
  2. Fixed order decides a tie: two candidates both on the capture adapter, `qsv` and `nvenc`, choose `nvenc` with reason `AdapterMatch`.
  3. Adapter-agnostic ranks last: a `mediafoundation` candidate with `has_adapter` false loses to an `amf` candidate on a non-capture adapter, with reason `FixedOrder`.
  4. Unknown capture adapter: with `capture_adapter_known` false, the fixed order alone decides and the reason is `FixedOrder`.
  5. Forced backend wins outright: forcing `qsv` selects the `qsv` candidate with reason `Forced`, even when an `nvenc` candidate sits on the capture adapter.
  6. Forced but absent: forcing `qsv` when no `qsv` candidate exists falls back to automatic selection, returns the automatically chosen candidate, and reports reason `ForcedUnavailable`. An empty candidate list returns `found` false.

- [x] **Step 2: Run the build and confirm the tests fail**

Run: `.\build-native.cmd`
Expected: `encoder-selection-test` fails to compile because the header does not exist.

- [x] **Step 3: Implement**

  - Create `encoder-selection.hpp` implementing the ranking above as a pure function over the candidate list. No GStreamer calls: building the list is Task 5's job.
  - Register `encoder-selection` in the `CMakeLists.txt` test loop.

- [x] **Step 4: Run the required test**

Run: `.\build-native.cmd`
Expected: `media-worker.encoder-selection` passes.

- [x] **Step 5: Format and commit**

Run: `npm run format`, then `git add native/media-worker/src/encoder-selection.hpp native/media-worker/tests/encoder-selection.cpp native/media-worker/CMakeLists.txt`
Commit message: `feat: rank encoder backends by capture adapter`

---

### Task 5: Wire selection, preflight, probe and self-test into the worker

**Files:**
- Modify: `native/media-worker/src/media-worker.cpp`, `native/media-worker/tests/native-worker.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1 to 4.
- Produces:
  - `--probe` JSON gains `backends`: an array of objects `{ "id", "label", "codecs": [...], "minimums": { "<codec>": { "width", "height" } }, "onCaptureAdapter": bool }`. `codecs` keeps its existing meaning and shape — the union of every advertised backend's codecs. `encoder` becomes the element name selection would choose right now, still a single string.
  - `--self-test-codec <backend> <codec>` replaces `--self-test-codec <codec>`. Both arguments are required; the old one-argument form is removed, not kept as a fallback.
  - `start_source` reads an optional `encoderBackend` string from its configuration object, defaulting to `auto` when absent or empty.

- [x] **Step 1: Write the failing tests in `tests/native-worker.test.mjs`**

  Four cases, against the real worker binary on this machine:

  1. Probe shape: `--probe` returns a `backends` array with at least one entry; every entry has all five fields; `codecs` at the top level equals the union of the backends' `codecs`; `encoder` is a non-empty string that appears as an element name for the chosen backend.
  2. On this machine `backends` contains `nvenc`, `amf` and `mediafoundation`, and does not contain `qsv`. NVENC's `minimums` give 192x128 for `av1` and 144x48 for `h265`; `mediafoundation` lists no `av1`. Assert membership, not an exact set, so the test does not break on a machine with different hardware.
  3. Two-argument self-test: `--self-test-codec nvenc h264` succeeds; `--self-test-codec amf h264` succeeds, because AMF really works here; `--self-test-codec qsv h264` fails cleanly with a non-zero exit and a message naming the backend, rather than hanging or crashing; `--self-test-codec h264` (the old form) is rejected as a usage error.
  4. Adapter affinity fires for real. This machine has two adapters, so the probe's `onCaptureAdapter` is true for exactly one backend, and `encoder` names an element from that backend. This is the only genuine test of the feature and it exists only because the development machine happens to be hybrid.
  5. The existing NVENC self-tests in this file still pass unchanged. Do not rewrite them.

- [x] **Step 2: Run the build and the worker test, and confirm the new cases fail**

Run: `.\build-native.cmd`, then `node --test native/media-worker/tests/native-worker.test.mjs`
Expected: the four new cases fail — no `backends` key, and the two-argument self-test is a usage error.

- [x] **Step 3: Implement**

  - Candidate discovery: for each backend in `encoder_backends()` and each codec, look up the encoder element factory together with the codec's parser and payloader factories, exactly as the existing probe already does for codecs. A backend offers a codec only when all three are found.
  - Encoder adapter LUID: instantiate the candidate encoder element and read `adapter-luid` when the element class declares it; otherwise record `has_adapter` false. `nvd3d11h264enc` declares it, verified 2026-09-21.
  - Capture adapter LUID: **do not look for `adapter-luid` on `d3d11screencapturesrc` — it does not have one.** Verified 2026-09-21: the element exposes only `adapter`, a DXGI index that applies to Windows Graphics Capture mode and does not identify the adapter DXGI duplication actually used. Derive the LUID from the monitor instead. The display inventory already carries each monitor's handle; walk DXGI adapters and their outputs, match the output whose monitor handle equals the captured one, and take that adapter's LUID. When no monitor is selected, use the primary monitor. When the walk finds no match, report the capture adapter as unknown, which degrades ranking to the fixed order.
  - Self-test gate: before advertising a backend, run the existing short encode for its first supported codec and drop the backend when it fails. Do not cache the result.
  - `preflight`: keep every currently-required element except the three NVENC-specific ones. Replace those with a check that at least one backend survives the gate with an `h264` element, and that `h264parse` and `rtph264pay` are present. On failure, raise a message naming the encoders looked for and stating that none worked.
  - `--probe`: emit `backends` as specified, keep `codecs` as the union, and set `encoder` from `select_encoder` under the current policy.
  - `--self-test-codec`: take two arguments, resolve the backend with `find_encoder_backend`, and fail with a usage error when either argument is missing or unknown.
  - `start_source`: read `encoderBackend`, pass it to `select_encoder` as the forced id, and record the resulting `SelectionReason`. Make the chosen backend id, chosen element and reason available to the existing telemetry or sample payload that already reports `codec`, so Task 8 can surface it.
  - `pipeline_description`: drop the hardcoded `nvenc` from Task 3 and use the selected backend and element.

- [x] **Step 4: Run the required tests**

Run: `.\build-native.cmd`, then `node --test native/media-worker/tests/native-worker.test.mjs`
Expected: all pass, the pre-existing NVENC self-tests included. If an existing case asserts the old `encoder` constant, updating that one assertion is the only acceptable edit to existing tests.

- [x] **Step 5: Format and commit**

Run: `npm run format`, then `git add native/media-worker/src/media-worker.cpp native/media-worker/tests/native-worker.test.mjs`
Commit message: `feat: select an encoder backend per machine`

---

### Task 6: Server backend constants and policy field

**Files:**
- Create: `apps/server/src/encoder-backends.mjs`
- Modify: `apps/server/src/stream-policy.mjs`
- Test: `apps/server/tests/stream-policy.test.mjs` only. The seeded policy reaches validation through the same path, so a second file would test it twice.

**Interfaces:**
- Consumes: the export style of `apps/server/src/video-codecs.mjs` and `rate-control.mjs`. Follow it.
- Produces: `encoder-backends.mjs` exporting `ENCODER_BACKENDS` (`['nvenc', 'qsv', 'amf', 'mediafoundation']`), `ENCODER_BACKEND_CHOICES` (`['auto', ...ENCODER_BACKENDS]`), `BACKEND_LABELS` (`{ nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD AMF', mediafoundation: 'Media Foundation' }`) and `DEFAULT_ENCODER_BACKEND` (`'auto'`). Stream policy gains a top-level `encoderBackend` string, and `resolveStreamPolicy` returns it alongside the resolved profile.

- [ ] **Step 1: Write the failing tests in `stream-policy.test.mjs`**

  Four cases:

  1. Default: `defaultStreamPolicy` has `encoderBackend: 'auto'`.
  2. Upgrade: `validateStreamPolicy` on a policy with no `encoderBackend` returns `auto` and does not mutate its input, matching how `videoCodecs` and `displaySharing` are already back-filled.
  3. Validation: each of the five allowed values is accepted; `nvidia` and the empty string are rejected with exactly `Encoder backend is invalid`; the exact-key-set check includes `encoderBackend`, so a policy carrying an unknown extra key is still rejected.
  4. Resolution: `resolveStreamPolicy` returns the policy's `encoderBackend`, including for custom client settings, because the backend is a host property and does not vary by client.

  Do not add cases for `videoCodecs` or profile fields; existing tests cover them.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `node --test apps/server/tests/stream-policy.test.mjs`
Expected: the four new cases fail; the rest of the file passes.

- [ ] **Step 3: Implement**

  - Create `encoder-backends.mjs` with the four exports above.
  - In `stream-policy.mjs`: add `encoderBackend` to `defaultStreamPolicy`; back-fill a missing value with `auto` before the exact-key-set check; add it to the top-level key list beside `videoCodecs`; validate against `ENCODER_BACKEND_CHOICES` with the exact message; return it from `resolveStreamPolicy`.
  - `schemaVersion` stays 1.

- [ ] **Step 4: Run the required tests**

Run: `node --test apps/server/tests/stream-policy.test.mjs`, then once `node tools/test.mjs server`
Expected: all pass. The full server run is required here because the policy shape changed. Any existing test asserting an exact policy object needs the new field added; that is the only acceptable edit to existing tests.

- [ ] **Step 5: Format and commit**

Run: `npm run format`, then `git add apps/server/src/encoder-backends.mjs apps/server/src/stream-policy.mjs apps/server/tests/stream-policy.test.mjs`
Commit message: `feat: add an encoder backend setting to stream policy`

---

### Task 7: Codec eligibility from probe data

**Files:**
- Modify: `apps/server/src/video-codecs.mjs`, `apps/server/src/native-media.mjs`
- Test: `apps/server/tests/video-codecs.test.mjs`, and `apps/server/tests/native-media.test.mjs` for the probe parse
- Lockstep: land with Task 5. Between them a real stream does not start.

**Interfaces:**
- Consumes: the probe's `backends` array (Task 5) and `encoderBackend` (Task 6).
- Produces:
  - `MINIMUM_DIMENSIONS` **deleted** from `video-codecs.mjs`.
  - `selectVideoCodec(sdp, policyCodecs, backends, profile, encoderBackend)` replacing today's `(sdp, policyCodecs, hostCodecs, profile)`. `backends` is the probe array. It returns the chosen codec id and still throws a 400 with `Browser must offer a supported video codec.` when nothing fits.
  - Eligibility for a codec: the browser offered it, policy allows it, and at least one *usable* backend supports it at the resolved profile's size. A backend is usable when `encoderBackend` is `auto`, or when its id equals `encoderBackend`, or when `encoderBackend` names a backend absent from `backends` — the last case mirrors the worker's fallback to automatic rather than failing.
  - `offeredVideoCodecs` is unchanged.
  - `native-media.mjs` exposes the probe's `backends` alongside the existing `codecs`.

- [ ] **Step 1: Write the failing tests**

  In `video-codecs.test.mjs`, five cases:

  1. Size eligibility by backend: a 100x100 profile with AV1 offered and allowed is rejected for `nvenc` alone (minimum 192x128) but accepted when a `qsv` backend (minimum 16x16) also supports AV1 — the case `MINIMUM_DIMENSIONS` could not express.
  2. Policy order still wins: with two usable backends both supporting all codecs, the first codec in `policyCodecs` that the browser offered is chosen.
  3. Forced backend narrows the choice: `encoderBackend` of `mediafoundation` with AV1 offered and allowed falls through to H.265, because that backend has no AV1.
  4. Forced but absent: `encoderBackend` of `qsv` when `backends` has only `nvenc` behaves exactly as `auto`.
  5. Nothing fits: an empty `backends` array throws the 400 with the existing message.

  In `native-media.test.mjs`, one case: a probe response is parsed into both `codecs` and `backends`, and a response without `backends` yields an empty array rather than throwing, so an old worker binary cannot crash the server.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test apps/server/tests/video-codecs.test.mjs`
Expected: the five new cases fail on the changed signature.

- [ ] **Step 3: Implement**

  - Delete `MINIMUM_DIMENSIONS` and rewrite `selectVideoCodec` to the signature and rules above.
  - Surface `backends` from the probe in `native-media.mjs`, defaulting to an empty array.

- [ ] **Step 4: Run the required tests**

Run: `node --test apps/server/tests/video-codecs.test.mjs`, then `node --test apps/server/tests/native-media.test.mjs` (needs the GPU and the Task 5 build)
Expected: all pass.

- [ ] **Step 5: Format and commit**

Run: `npm run format`, then `git add apps/server/src/video-codecs.mjs apps/server/src/native-media.mjs apps/server/tests/video-codecs.test.mjs apps/server/tests/native-media.test.mjs`
Commit message: `feat: choose codecs from per-backend encoder limits`

---

### Task 8: Plan hand-off and status reporting

**Files:**
- Modify: `apps/server/src/stream-runtime.mjs`, `apps/server/src/host-status.mjs`, `apps/server/src/diagnostics.mjs`
- Test: `apps/server/tests/stream-runtime.test.mjs`, `apps/server/tests/host-status.test.mjs`

**Interfaces:**
- Consumes: `resolveStreamPolicy`'s `encoderBackend` (Task 6), the new `selectVideoCodec` signature (Task 7), and the worker's reported backend, element and selection reason (Task 5).
- Produces: `StreamRuntime` gains a `videoBackends` constructor field carrying the probe's `backends`, replacing the `videoCodecs` argument at the `selectVideoCodec` call site around `stream-runtime.mjs:301`. The worker plan sent by `native-media.mjs` gains `encoderBackend` beside the existing `codec`. Host status and diagnostics report the available backends, the chosen backend, the chosen element and the selection reason.

- [ ] **Step 1: Write the failing tests**

  Three cases:

  1. `stream-runtime.test.mjs`: the plan handed to the worker carries `encoderBackend` taken from resolved policy, and carries `auto` when policy says `auto`.
  2. `stream-runtime.test.mjs`: `selectVideoCodec` receives the runtime's `videoBackends` and the resolved `encoderBackend`, not a flat codec list.
  3. `host-status.test.mjs`: status projects the available backend ids with their labels, and the active backend, element and reason when a stream is running; with no stream running it reports the available backends and no active one.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test apps/server/tests/stream-runtime.test.mjs apps/server/tests/host-status.test.mjs`
Expected: the three new cases fail.

- [ ] **Step 3: Implement**

  - Thread `videoBackends` through `StreamRuntime` and update the `selectVideoCodec` call.
  - Add `encoderBackend` to the worker plan.
  - Project the backend fields in `host-status.mjs` and `diagnostics.mjs`, including the substitution case where a forced backend was unavailable.

- [ ] **Step 4: Run the required tests**

Run: `node --test apps/server/tests/stream-runtime.test.mjs apps/server/tests/host-status.test.mjs`
Expected: all pass.

- [ ] **Step 5: Format and commit**

Run: `npm run format`, then `git add apps/server/src/stream-runtime.mjs apps/server/src/host-status.mjs apps/server/src/diagnostics.mjs apps/server/tests/stream-runtime.test.mjs apps/server/tests/host-status.test.mjs`
Commit message: `feat: report the selected encoder backend`

---

### Task 9: CLI

**Files:**
- Modify: `apps/server/src/cli/policy-edits.mjs`, `apps/server/src/cli/commands/settings.mjs`, `apps/server/src/cli/format.mjs`, `apps/server/src/cli/completion.mjs`
- Test: `apps/server/tests/cli-policy-edits.test.mjs`, `apps/server/tests/cli-commands.test.mjs`, `apps/server/tests/cli-completion.test.mjs`, `apps/server/tests/cli-parity.test.mjs`

**Interfaces:**
- Consumes: `ENCODER_BACKEND_CHOICES` and `BACKEND_LABELS` from `encoder-backends.mjs` (Task 6); the status fields from Task 8.
- Produces: an `encoder-backend` policy field in the settings commands, accepting the five values, with the same conflict advice and revision handling as the other top-level policy fields. `diagnostics` output gains the available backends, the active backend and element, and the selection reason.

- [ ] **Step 1: Write the failing tests**

  Four cases, one per file:

  1. `cli-policy-edits.test.mjs`: setting `encoder-backend` to `qsv` produces the expected policy edit; setting it to `nvidia` fails with `Encoder backend is invalid`; the field participates in the existing revision-conflict advice the same way `video-codecs` does.
  2. `cli-commands.test.mjs`: the settings command shows the current backend using its label, not its raw id, and shows `Automatic` for `auto`.
  3. `cli-completion.test.mjs`: completing the value of `encoder-backend` offers exactly the five allowed values.
  4. `cli-parity.test.mjs`: this test walks every policy field, so it must be extended to include `encoder-backend`. Adding it here is the point of the task, not an incidental edit.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test apps/server/tests/cli-policy-edits.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs apps/server/tests/cli-parity.test.mjs`
Expected: the four new cases fail.

- [ ] **Step 3: Implement**

  - Add the field to the policy edit map, the settings command output, the formatter and the completion values, following the existing `video-codecs` field in each file.
  - Add the backend fields to the `diagnostics` output.

- [ ] **Step 4: Run the required tests**

Run: `node --test apps/server/tests/cli-policy-edits.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs apps/server/tests/cli-parity.test.mjs`
Expected: all pass.

- [ ] **Step 5: Format and commit**

Run: `npm run format`, then `git add apps/server/src/cli apps/server/tests/cli-policy-edits.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs apps/server/tests/cli-parity.test.mjs`
Commit message: `feat: expose the encoder backend in the CLI`

---

### Task 10: Windows host app Codecs page

**Files:**
- Modify: `apps/windows-host/HostWindow.Codecs.cs`, and the Navigation test project under `apps/windows-host/tests/Navigation/`
- Test: the Navigation regression, run as written in `apps/windows-host/tests/Navigation/README.md`

**Interfaces:**
- Consumes: the host status fields from Task 8 — available backends with labels, the active backend and element, and the selection reason.
- Produces: a backend selector on the Codecs page whose options are `Automatic` plus the backends this machine actually reported. A backend the machine does not have is not offered.

- [ ] **Step 1: Extend the Navigation regression**

  Three cases:

  1. The Codecs page shows a backend selector whose options are `Automatic` plus the reported backends, and no others.
  2. With a stream running, the page names the active backend and the reason it was chosen.
  3. When a forced backend was substituted because it is unavailable, the page says so rather than showing the forced value as if it were in effect.

- [ ] **Step 2: Build and run the regression, and confirm the cases fail**

Run: `dotnet build apps/windows-host/VidVnc.Host.csproj`, then the Navigation regression as documented
Expected: the three new cases fail; the existing Codecs cases pass.

- [ ] **Step 3: Implement**

  - Add the selector, bound to the policy field, following how the existing codec checkboxes on this page read and write policy.
  - Show the active backend, element and reason, and the substitution notice.
  - Mark Quick Sync alone as untested against real hardware, and leave NVENC, AMF and Media Foundation unqualified, since all three are exercised on the development machine. The interface must not present four equal options, and it must not imply AMF and Media Foundation are unverified when they are not. One short line on the Quick Sync option is enough; match the README wording from Task 12.

- [ ] **Step 4: Run the required tests**

Run: `dotnet build apps/windows-host/VidVnc.Host.csproj`, then the Navigation regression once
Expected: all pass.

- [ ] **Step 5: Format and commit**

Run: `npm run format`, then `git add apps/windows-host`
Commit message: `feat: choose an encoder backend from the host app`

---

### Task 11: Package the new GStreamer plugins

**Files:**
- Modify: `packaging/windows/inputs.json`
- Test: `packaging/tests/staging.test.mjs`, `packaging/tests/pe-dependencies.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks. This task is independent and can land at any point.
- Produces: `gstqsv.dll`, `gstamfcodec.dll` and `gstmediafoundation.dll` in the staged plugin set, with component entries carrying their licences, and any transitive DLLs those three pull in.

- [ ] **Step 1: Write the failing tests**

  Two cases:

  1. `staging.test.mjs`: the staged plugin list contains the three new plugin DLLs alongside the existing ones, and every plugin named in `inputs.json` has a component entry that declares a licence. The second half is the guard that a future plugin cannot be added without its licence metadata.
  2. `pe-dependencies.test.mjs`: the dependency walk over the new plugins resolves every import to either a staged file or a known system DLL, with nothing unresolved.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test packaging/tests/staging.test.mjs packaging/tests/pe-dependencies.test.mjs`
Expected: both new cases fail — the plugins are absent from the manifest.

- [ ] **Step 3: Implement**

  - Add the three plugin DLLs to the `plugins` list.
  - Add or extend component entries for them. `gstqsv.dll` and `gstmediafoundation.dll` come from `gst-plugins-bad-1.0`, which already has an entry; `gstamfcodec.dll` comes from the same recipe. Verify each against the SDK's own licence directories rather than assuming, the same way the existing entries were derived.
  - Run the dependency walker's output and add any newly required transitive DLLs to the right component, with licences.
  - Do not build a package in this task. Task 13 does that once.

- [ ] **Step 4: Run the required tests**

Run: `node --test packaging/tests/staging.test.mjs packaging/tests/pe-dependencies.test.mjs`
Expected: both pass.

- [ ] **Step 5: Format and commit**

Run: `npm run format`, then `git add packaging/windows/inputs.json packaging/tests/staging.test.mjs packaging/tests/pe-dependencies.test.mjs`
Commit message: `feat: package the Quick Sync, AMF and Media Foundation plugins`

---

### Task 12: Documentation

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`, `docs/PACKAGING.md`

**Interfaces:**
- Consumes: the finished behaviour from every earlier task.
- Produces: no code. Documentation only, so no tests run for this task.

- [ ] **Step 1: Update the README**

  - The "Currently implemented" paragraph says NVIDIA H.264 hardware encoding and states that there is no fallback. Replace the hardware sentence with the four backends and what each covers, and keep the statement that there is no software encoder or software capture fallback, which is still true.
  - The install prerequisites say "An NVIDIA graphics card with its current driver" in both package sections. Replace with the real requirement: a GPU with a supported hardware encoder — NVIDIA, Intel or AMD — with a current driver.
  - State plainly which backends are verified. NVENC, AMF and Media Foundation have been exercised on real hardware; Quick Sync has not, because no Intel graphics was available. Mark Quick Sync alone as untested and leave the other three unqualified — marking all three new backends as untested would now understate two of them. A user should be able to learn this from the README without reading the spec.

- [ ] **Step 2: Update the roadmap**

  Record that multi-vendor encoding landed, that NVENC, AMF and Media Foundation were exercised on real hardware, and that promoting Quick Sync from untested to supported needs an Intel machine, the self-tests across all codecs in both bitrate modes, the VBR bitrate measurements that produced the NVENC floors, and a latency measurement in particular, since it is the one backend with no low-latency property.

- [ ] **Step 3: Update the packaging document**

  Note the three added plugins and, if the package size moved materially, the new figures.

- [ ] **Step 4: No tests**

  This task changes no code path. Do not run a test suite.

- [ ] **Step 5: Commit**

Run: `git add README.md docs/ROADMAP.md docs/PACKAGING.md`
Commit message: `docs: describe the supported encoder backends`

---

### Task 13: Final gate

**Files:** none. This task only verifies.

**Interfaces:**
- Consumes: every earlier task.
- Produces: a green tree and a package that builds with the new plugins staged.

- [ ] **Step 1: Formatting**

Run: `npm run format:check`
Expected: passes. If it fails, run `npm run format` and commit the result.

- [ ] **Step 2: Server suite**

Run: `node tools/test.mjs server`
Expected: passes. Report every failing test name from a full read of the output; do not truncate.

- [ ] **Step 3: Package build**

Run: `npm run package`
Expected: both packages build and the three new plugin DLLs appear in the staged plugin directory. This is the only package build in the plan, and it is the only proof that Task 11's manifest changes actually stage and sign.

- [ ] **Step 4: Confirm the NVENC regression one last time**

Run: `node --test native/media-worker/tests/native-worker.test.mjs`
Expected: passes, including the pre-existing NVENC self-tests. NVENC behaviour must be identical to before this plan.

- [ ] **Step 5: One interactive session on AMF**

  Force `encoder-backend` to `amf` in stream policy, start a session, connect a browser and use it briefly. Confirm the stream is watchable and responsive, not merely that it negotiated. Then set the policy back to `auto`. A passing self-test proves the encoder accepts caps; only this proves the stream is usable.

- [ ] **Step 6: Report**

  State plainly what was verified and what was not:

  - NVENC, AMF and Media Foundation were exercised on the development machine's AMD Radeon integrated GPU and NVIDIA RTX 5060 Ti. Say which codecs each one accepted and which its self-test rejected.
  - Adapter affinity was tested on a genuinely hybrid machine. Say which adapter captured and which backend won.
  - **Quick Sync was never executed.** No Intel graphics was available. Do not describe it as working, tested or supported — only as shipped behind the runtime self-test gate.
  - NVENC behaviour is identical to before this plan, proven by the exact-string regression in Task 3 and the pre-existing self-tests.
