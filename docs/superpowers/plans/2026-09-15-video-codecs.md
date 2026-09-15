# Video Codecs (AV1 + H.265) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode each video source with AV1, H.265 or H.264 on the NVIDIA GPU. The server
picks the codec for each device from the codecs its browser can decode in hardware and the
host's ordered codec list.

**Architecture:** The native worker gets a codec table (`video-codec.hpp`) that drives the
encoder, caps, parser and payloader strings, plus codec-aware SDP payload selection. The
server adds `videoCodecs` to the stream policy and picks a codec per offer
(`selectVideoCodec`) before admission. The codec is part of the source key and flows into
`start`, the offer response, status rows, the CLI and the host. The browser narrows its
`setCodecPreferences` list to codecs that `mediaCapabilities` reports as power-efficient,
with H.264 always last.

**Tech Stack:** C++17 + GStreamer 1.28 (`nvcodec` D3D11 encoders, `webrtcbin`), Node ESM
server (`node --test`), browser ES modules, WinUI 3 C# host.

**Spec:** `docs/superpowers/specs/2026-09-15-video-codecs-design.md`

## Global Constraints

- Plan style: no implementation code here; each task gives files, interfaces, required
  behaviour, test cases, and commands.
- No per-task commits. Leave the work uncommitted when done; the user commits.
- Codec identifiers everywhere (protocol, policy, CLI arguments): `h264`, `h265`, `av1`.
  Display names: `H.264`, `H.265`, `AV1`.
- Default host order: `['av1', 'h265', 'h264']`. `h264` must always be present.
- Bitrate, resolution, frame rate and host budgets are unchanged by the codec.
- Low-latency settings for every codec: `preset=p3 tune=ultra-low-latency rc-mode=cbr
  bitrate=<kbps> gop-size=<fps> bframes=0 zerolatency=true`.
- Legacy `/api/offer` and `NativeMedia.offer` stay H.264-only.
- Run only the tests covering the code touched. Report every failing test by name.
- Build native with `build-native.cmd`, then run CTest in the native build directory.
- Playwright checks use
  `C:\Users\kim_f\AppData\Local\npm-cache\_npx\e41f203b7505f1fb\node_modules\playwright`.

### Verified GStreamer facts (gst-inspect on this machine, GStreamer 1.28)

- `nvd3d11h265enc` and `nvd3d11av1enc` both have `preset`, `tune`, `rc-mode`, `bitrate`,
  `gop-size`, `bframes`, `zerolatency`. **Neither has `repeat-sequence-header`** (only the
  H.264 encoder does).
- `nvd3d11h265enc` src caps: `video/x-h265`, profile `main|main-10|main-444|main-444-10`,
  stream-format `byte-stream|hvc1|hev1`, alignment `au`; minimum input 144×48.
- `nvd3d11av1enc` src caps: `video/x-av1,profile=main,stream-format=obu-stream,alignment=tu`;
  minimum input 192×128.
- `h265parse` has `config-interval` (`-1` = send VPS/SPS/PPS with every IDR).
- `av1parse` has no header-repeat property. `rtpav1pay` requires `parsed=true`,
  `stream-format=obu-stream` and has `mtu`, `pt`, `ssrc` (no `config-interval`).
- `rtph265pay` has `config-interval`, `aggregate-mode` (`none|zero-latency|max`), `mtu`,
  `pt`, `ssrc`.

---

### Task 1: Native codec table, codec-aware payloads, `start.codec`, probe and self-test

**Files:**
- Create: `native/media-worker/src/video-codec.hpp`
- Create: `native/media-worker/tests/video-codec.cpp`
- Modify: `native/media-worker/src/sdp-payload.hpp` (`select_payloads`)
- Modify: `native/media-worker/tests/sdp-payload.cpp`
- Modify: `native/media-worker/src/media-worker.cpp`: `pipeline_description` (~469),
  `add_peer` (~819–861), `start_source` (~1000), metrics timer (~1111), `main` probe and
  self-test arguments (~1192–1216)
- Modify: `native/media-worker/CMakeLists.txt` (add `video-codec` to the test `foreach`; no
  GStreamer link needed)
- Modify: `native/media-worker/tests/native-worker.test.mjs`

**Interfaces:**
- Produces, `video-codec.hpp` (header-only, no GStreamer includes):
  - `struct VideoCodec` with string fields `id` (`h264`), `label` (`H.264`), `encoder`
    (factory name), `caps` (caps string after the encoder, without the H.264 level suffix),
    `encoder_extra` (codec-only encoder properties), `parser` (element plus properties),
    `payloader` (factory name), `payloader_extra`, `encoding_name` (`H264|H265|AV1`),
    `rtpmap` (`H264/90000` …), and `unsupported` (the peer-failed message).
  - `const VideoCodec *find_video_codec(const std::string &id)` returns `nullptr` for
    unknown ids.
  - `const std::array<VideoCodec, 3> &video_codecs()` in order h264, h265, av1.
- Produces, `sdp-payload.hpp`: `OfferPayloads select_payloads(const GstSDPMessage *sdp,
  const VideoCodec &codec)`. The old one-argument overload is removed; every caller passes
  a codec.
- Produces, worker protocol: `start.codec` (optional string); `metrics.codec`;
  `--probe` output gains `codecs: string[]`; new CLI argument pair
  `--self-test-codec <id>`.
- Consumed by Task 2 (hardware check) and Task 3 (server `probe().codecs`, `start.codec`).

**Codec table values:**

| field | h264 | h265 | av1 |
| --- | --- | --- | --- |
| encoder | `nvd3d11h264enc` | `nvd3d11h265enc` | `nvd3d11av1enc` |
| caps | `video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au` | `video/x-h265,profile=main,stream-format=byte-stream,alignment=au` | `video/x-av1,profile=main,stream-format=obu-stream,alignment=tu` |
| encoder_extra | `repeat-sequence-header=true` | (none) | (none) |
| parser | `h264parse` | `h265parse config-interval=-1` | `av1parse` |
| payloader / extra | `rtph264pay` / `config-interval=-1 aggregate-mode=<none at 15 fps, else zero-latency>` (existing) | `rtph265pay` / `config-interval=-1 aggregate-mode=zero-latency` | `rtpav1pay` / (none) |
| unsupported | `Browser must offer constrained-baseline H.264 with packetization-mode=1.` (existing text) | `Browser must offer H.265.` | `Browser must offer AV1.` |

The H.264 `aggregate-mode` depends on the profile, so `add_peer` adds it for H.264 only.
The table's `payloader_extra` holds only the fixed part.

- [ ] **Step 1: Write failing unit tests**
  - `tests/video-codec.cpp` (plain asserts like the existing `keyframe-limiter.cpp`):
    - `find_video_codec` returns the right encoder, parser, payloader and encoding name
      for all three ids.
    - It returns `nullptr` for `""`, `"H264"`, `"vp9"`.
    - `video_codecs()` order is h264, h265, av1.
    - Only h264 has a non-empty `encoder_extra`.
  - `tests/sdp-payload.cpp`: add offers covering:
    - A video m-line with `96 VP8`, `98 AV1/90000` (fmtp `98 profile=0`), `100 AV1/90000`
      (fmtp `100 profile=1`), `102 H265/90000` (fmtp `102 profile-id=1`), `104 H265/90000`
      (fmtp `104 profile-id=2`), `106 H264/90000` (existing fmtp), and Opus.
      - AV1 → `98`; H.265 → `102`; H.264 → `106`; audio → Opus payload in every case.
    - AV1 with no fmtp line → selected. H.265 with no fmtp line → selected.
    - AV1 with only `profile=1`, and H.265 with only `profile-id=2` → empty video.
    - An offer without the codec → empty video.
    - Payload-number guard: `rtpmap:1234 AV1/90000` and `rtpmap:9x H265/90000` →
      empty video.
    - Existing H.264 cases keep their expectations, now calling with the h264 codec.
- [ ] **Step 2: Build and confirm the new tests fail to compile or fail.** Run
  `build-native.cmd`.
- [ ] **Step 3: Implement `video-codec.hpp` and codec-aware `select_payloads`**
  - Matching rule for H.265 and AV1: an rtpmap value containing the table `rtpmap`. The
    fmtp for that payload either doesn't exist, or doesn't contain the profile key
    (`profile-id=` / `profile=`), or has value `1` (H.265) or `0` (AV1). **First** match
    wins.
  - H.264 rule and "last match wins" unchanged. Audio rule unchanged.
  - Compare the parameter name exactly. `profile-id=1` must not match `xprofile-id=1`, and
    `profile=0` must not match `profile-id=0`. Split fmtp parameters on `;` after the
    payload number and trim spaces.
- [ ] **Step 4: Wire the codec into the worker**
  - Add a global `const VideoCodec *video_codec = &video_codecs()[0]`.
  - `start_source`: read `string_member(object, "codec")`. Empty → h264. Unknown → fatal
    `Invalid video codec`. Read it only when video is enabled; audio-only sources ignore
    it.
  - `pipeline_description`: build encoder, low-latency properties, `encoder_extra`, caps,
    parser and `name=encoder` from `video_codec`. Keep the H.264-only `,level=(string)3.1`
    suffix under the existing 15 fps ≤ 720p condition.
  - `add_peer`:
    - Call `select_payloads(sdp, *video_codec)`; on a missing video payload the refusal
      uses `video_codec->unsupported`.
    - Build the video branch from `video_codec->payloader`, `mtu`, `pt`, `ssrc`,
      `payloader_extra` (+ H.264 aggregate-mode) and
      `application/x-rtp,media=video,encoding-name=<encoding_name>,ssrc=(uint)<ssrc>`.
    - Keep the SSRC comment.
  - `preflight`: unchanged (H.264 chain only).
  - `recovery_probe`: count keyframes for every codec. Run the SPS byte scan only when
    `video_codec` is h264; for other codecs `spsProfile`/`spsLevel` stay 0.
  - Metrics timer: `json_object_set_string_member(sample, "codec", video_codec->id)`.
  - `--probe`: add `codecs`, listing each table codec whose `encoder`, parser factory
    (first word of `parser`) and `payloader` factories all exist
    (`gst_element_factory_find`).
  - `--self-test-codec <id>` (argc == 3):
    - Unknown id → throw `Invalid video codec`.
    - Otherwise set `video_codec` and `profile = {1280, 720, 30, 4000, 1200}` and run
      `self_test()`.
    - Add `"codec"` to the self-test JSON.
    - The existing `Expected --probe or --self-test.` message stays for other arguments.
- [ ] **Step 5: Extend `native-worker.test.mjs`**
  - Probe test: `Array.isArray(info.codecs)` and `info.codecs[0] === 'h264'`.
  - New test for `h265` and `av1`, one `test` per codec. Skip with `t.skip('GPU has no
    <id> encoder')` when the probe omits the codec. Run `--self-test-codec <id>`, expect
    exit 0, `frames === 60`, `codec === id`, `keyframes >= 2` and
    `metrics.encodedFrames === 60`.
  - Session test: send `start` with `video: false, audioFormat: 'mono-32k', codec: 'bogus'`
    and expect the same output as today (codec ignored for audio). Add a second session
    run: `start` with `video: true, codec: 'bogus'` and no display. Expect exit code 1 and
    stderr containing `Invalid video codec`.
    - Check first how `fatal` reports (stdout event vs stderr) and assert on that channel.
- [ ] **Step 6: Build and run**
  - `build-native.cmd`, then `ctest --output-on-failure` in the native build dir. Expected:
    all pass, including `video-codec-test`.
  - `node --test native/media-worker/tests/native-worker.test.mjs`. Expected: all pass;
    h265 and av1 self-tests pass on the RTX 5060 Ti.
  - If an h265/av1 self-test reports `keyframes < 2`, the encoder ignores `gop-size` in
    this configuration. Fix it before continuing: try `strict-gop=true`, then `i-adapt=false`.

---

### Task 2: Hardware gate: shared stream per codec in Chromium (spec "Risks to verify first")

Run this gate before any server work. If a codec can't pass, stop and report; don't carry
it forward.

**Files:**
- Modify: `native/media-worker/tests/shared-stream-check.mjs`

**Interfaces:**
- Consumes: Task 1 `start.codec`, `metrics.codec`, `probe().codecs`.
- Produces: a check run as `node native/media-worker/tests/shared-stream-check.mjs
  <playwright> [codec]`. Codec defaults to `h264`. Prints the existing PASS line with
  ` (<codec>)` appended, or `NOT TESTED: <codec> …` and exits 0.

- [ ] **Step 1: Parameterise the check**
  - Read `process.argv[3] ?? 'h264'`.
  - If `probe().codecs` lacks it → print `NOT TESTED: GPU has no <codec> encoder` and exit 0.
  - Pass `codec` into `media.start('shared', {...})`.
  - In each viewer page, before `createOffer`, call `setCodecPreferences` on the video
    transceiver. Use only that codec's `RTCRtpReceiver.getCapabilities('video').codecs`
    entries (matching `mimeType` `video/AV1`, `video/H265`, `video/H264`) plus
    `video/rtx`.
  - If the browser has no entry for the codec → print `NOT TESTED: Chromium cannot
    decode <codec>` and exit 0. This covers H.265 on headless Chromium without hardware
    HEVC.
  - Add assertions:
    - `latest.codec === codec`.
    - Each answer SDP has an `a=rtpmap:<pt> <encoding>/90000` line for the codec.
    - After decoding starts, `pc.getStats()` inbound-rtp `codecId` resolves to a codec
      whose `mimeType` matches, compared case-insensitively.
- [ ] **Step 2: Run per codec**
  - `node native/media-worker/tests/shared-stream-check.mjs <playwright> h264` → PASS
    (regression).
  - `… av1` → PASS required.
  - `… h265` → PASS, or NOT TESTED with the reason printed.
- [ ] **Step 3: If a codec fails, diagnose against the three spec risks, fix in the worker,
  and re-run**
  - **Answer rejected by `setRemoteDescription`** (fmtp mismatch):
    - Add the offer's matched fmtp parameters to the payloader output caps in `add_peer`:
      `profile-id`/`level-id`/`tier-flag` for H.265, `profile`/`level-idx`/`tier` for AV1.
    - Pass them as caps fields so `webrtcbin` copies them into the answer.
    - `select_payloads` then also returns the matched fmtp string for the video payload
      (`OfferPayloads.video_fmtp`); add a unit test for that field.
  - **Late join exceeds 1000 ms or never decodes for AV1**: the sequence header isn't
    repeated.
    - First confirm by logging whether the join keyframe buffer contains an OBU of type 1
      (sequence header) at the `encoder` src probe.
    - If absent, insert the stored sequence header before each keyframe. Do it in a
      buffer probe on the `av1parse` src pad: cache the last sequence-header OBU and
      prepend it to non-delta buffers that lack one.
  - **Late join slow for H.265**: confirm `h265parse config-interval=-1` is in the logged
    `SOURCE` description (`VIDVNC_NATIVE_LOG`).
- [ ] **Step 4: Record the outcome.** Put the three PASS / NOT TESTED lines in the task
  report; Task 7 copies them into the verification summary.

---

### Task 3: Server: policy `videoCodecs`, codec selection, source key, runtime and responses

**Files:**
- Create: `apps/server/src/video-codecs.mjs`
- Create: `apps/server/tests/video-codecs.test.mjs`
- Modify: `apps/server/src/stream-policy.mjs` (`defaultStreamPolicy`, `validateStreamPolicy`)
- Modify: `apps/server/tests/stream-policy.test.mjs`
- Modify: `apps/server/src/stream-registry.mjs` (`sourceKey`)
- Modify: `apps/server/tests/stream-registry.test.mjs` (the "each differing key field" case)
- Modify: `apps/server/src/stream-runtime.mjs`: constructor option `videoCodecs`,
  `offerVideo` (~264–307), `status()` stream rows (~146–157)
- Modify: `apps/server/src/diagnostics.mjs` (`startStream` records `codec`)
- Modify: `apps/server/tests/stream-runtime.test.mjs`
- Modify: `apps/server/src/native-media.mjs`: `start` writes `codec` (~67–150)
- Modify: `apps/server/tests/fixtures/media-process.mjs`, only if it needs to expose the
  recorded `start` message
- Modify: `apps/server/tests/media-lifecycle.test.mjs`
- Modify: `apps/server/src/main.mjs`: pass `videoCodecs` to `StreamRuntime`; add `codecs`
  to the desktop `ready` message (~404); change the console banner's `NVIDIA H.264` (~425)
  to the host codec labels

**Interfaces:**
- Produces, `video-codecs.mjs`:
  - `export const VIDEO_CODECS = Object.freeze(['av1', 'h265', 'h264'])`: known ids in
    default order.
  - `export const CODEC_LABELS = Object.freeze({ av1: 'AV1', h265: 'H.265', h264: 'H.264' })`.
  - `export function offeredVideoCodecs(sdp) → Set<string>`: codec ids whose encoding
    name appears in an `a=rtpmap:<pt> <NAME>/90000` line inside an `m=video` section.
    Names are case-insensitive: `AV1`→`av1`, `H265`→`h265`, `H264`→`h264`.
  - `export function selectVideoCodec(sdp, policyCodecs, hostCodecs, profile) → string`:
    returns the first id in `policyCodecs` that is in `hostCodecs`, is offered, and fits
    the encoder minimum (`av1` needs width ≥ 192 and height ≥ 128; `h265` needs width ≥
    144 and height ≥ 48). With no match it throws
    `Error('Browser must offer a supported video codec.')` with `status: 400`.
- Produces, policy: `policy.videoCodecs: string[]`.
- Produces, runtime:
  - `new StreamRuntime({ …, videoCodecs = ['h264'] })`, stored as `this.videoCodecs`.
  - Plans gain `codec`. `media.start(sourceId, { video, profile, display, codec })`.
  - The offer response gains `codec`. `status()` stream rows gain `codec`. `list()` rows
    include `codec` because they spread the plan.
- Produces, desktop owner pipe: the `ready` message gains `codecs: string[]` (host GPU
  support, from the probe). Task 6 consumes it.
- Consumes: Task 1 `probe().codecs`, worker `start.codec`.

**Deviation from spec, noted:** `selectVideoCodec` takes a fourth `profile` argument. The
new encoders have larger minimum input sizes (AV1 192×128, H.265 144×48) than the
policy's 64×64 floor, so a tiny custom profile must fall back instead of failing in the
worker.

**Deviation from spec, noted:** the spec says live streams keep their codec after a codec
edit. In the code, every policy replace already disconnects all sessions
(`PolicyController.replace`), and codec edits use that same path. No extra revalidation
logic is needed.

- [ ] **Step 1: Write failing tests**
  - `video-codecs.test.mjs`, using small offer SDP strings with `m=video` and `m=audio`
    sections:
    - Chrome-like offer (VP8, VP9, AV1, H264) with policy `['av1','h265','h264']` and all
      host codecs → `av1`.
    - Safari-like offer (H265, H264) → `h265`.
    - H264-only offer → `h264`.
    - Host `['h264']` with an AV1+H264 offer → `h264`.
    - Policy `['h264','av1']` → `h264`, so policy order wins over browser order.
    - Profile 160×90 with AV1+H265+H264 offered → `h265`. Profile 128×64 → `h264`.
    - `H264` present only in the audio section → throws with `status === 400` and the
      exact message.
    - Lower-case `a=rtpmap:98 av1/90000` is recognised.
  - `stream-policy.test.mjs`:
    - `defaultStreamPolicy().videoCodecs` deep-equals `['av1','h265','h264']`.
    - A policy object without `videoCodecs` validates and gets the default.
    - Rejected: `['av1','h265']` (no h264), `['h264','h264']`, `['vp9','h264']`, `[]`,
      `'h264'`, `[1]`.
    - `['h264']` alone is valid.
  - `stream-registry.test.mjs`: give the base `plan()` `codec: 'h264'` and add
    `plan({ codec: 'av1' })` to the variants in "each differing key field creates a new
    source".
  - `stream-runtime.test.mjs` (extend `setup` so `videoCodecs` can be passed to the
    runtime; default `['av1','h265','h264']`):
    - An offer containing AV1 → the recorded `start` call has `codec: 'av1'`, the response
      has `codec: 'av1'`, and `status().sessions[0].streams[0].codec === 'av1'`.
    - Two sessions with the same profile and display, one offering AV1 and one only H264
      → two sources and two `start` calls with different codecs.
    - Two sessions offering AV1 → one source.
    - An offer without any known video codec → rejects with `status: 400`, and nothing is
      admitted (`registry.sources()` empty, no `start`).
    - Runtime constructed with `videoCodecs: ['h264']` and an AV1+H264 offer → `h264`.
  - `media-lifecycle.test.mjs`: `NativeMedia.start('s', { video: true, profile, codec:
    'h265' })` → the fixture's recorded `start` message has `codec: 'h265'`. Without
    `codec` it is `'h264'`.
  - Existing runtime test SDPs without an `H264/90000` rtpmap line in a video section must
    gain one.
- [ ] **Step 2: Run to confirm failures**
  - `node --test apps/server/tests/video-codecs.test.mjs apps/server/tests/stream-policy.test.mjs apps/server/tests/stream-registry.test.mjs apps/server/tests/stream-runtime.test.mjs apps/server/tests/media-lifecycle.test.mjs`
- [ ] **Step 3: Implement**
  - `stream-policy.mjs`:
    - Default adds `videoCodecs: [...VIDEO_CODECS]`.
    - `validateStreamPolicy` fills a missing `videoCodecs` with the default, next to the
      existing `displaySharing` normalization.
    - Add `'videoCodecs'` to the key list.
    - Validate: a non-empty array, every entry in `VIDEO_CODECS`, no duplicates, includes
      `'h264'`. Messages: `Video codecs must be a list`, `Unknown video codec`,
      `Video codecs contain duplicates`, `H.264 must stay enabled`.
  - `stream-registry.mjs`: `sourceKey` appends `plan.codec ?? 'h264'` after the bitrate.
    Update the comment.
  - `stream-runtime.mjs` `offerVideo`:
    - After the existing 403 try block, call `selectVideoCodec(request.sdp,
      policy.videoCodecs, this.videoCodecs, effective.profile)`. It throws its own 400.
    - Put `codec` in `plan` and in the `start` object.
    - `configure` passes `codec` to `diagnostics.startStream` as a new optional fourth
      argument, stored in the snapshot as `codec`. Check the current signature first.
    - The response gains `codec`.
  - `status()` stream rows add `codec: stream.plan.codec ?? 'h264'`.
  - `native-media.mjs` `start` destructures `codec = 'h264'` and writes `codec` into the
    `start` JSON when `video` is true. Compatibility `offer` is unchanged, so its worker
    defaults to h264.
  - `main.mjs`:
    - `const hostCodecs = info.codecs?.length ? info.codecs : ['h264']`.
    - Pass `videoCodecs: hostCodecs` to `StreamRuntime`.
    - Add `codecs: hostCodecs` to the `ready` message.
    - Banner: `NVIDIA <labels>`, listing the host codecs in `VIDEO_CODECS` order via
      `CODEC_LABELS`, joined with ` / `.
- [ ] **Step 4: Run the Step 2 command.** Expected: all pass. Then run
  `node --test apps/server/tests/http-app*.test.mjs apps/server/tests/policy-controller.test.mjs apps/server/tests/cli-*.test.mjs`
  to catch fixtures that build full policy objects by hand. Fix them by adding
  `videoCodecs` or by using `defaultStreamPolicy()`; don't relax validation.

---

### Task 4: CLI: `codecs` command and sessions `Codec` column

**Files:**
- Modify: `apps/server/src/cli/policy-edits.mjs` (add `setVideoCodecs`)
- Modify: `apps/server/src/cli/commands/settings.mjs` (add the `codecs` command after `audio`)
- Modify: `apps/server/src/cli/format.mjs` (add `formatCodecs`; add a `Codec` column to the
  sessions table ~132)
- Modify: `apps/server/src/cli/console.mjs` (`createLiveContext` gains `hostCodecs`)
- Modify: `apps/server/src/cli/offline.mjs` (`createOfflineContext` gains `hostCodecs`)
- Modify: `apps/server/src/main.mjs` (pass `hostCodecs` into `createLiveContext`)
- Modify: `apps/server/src/cli/completion.mjs`, only if it lists subcommand arguments
  explicitly (check first)
- Test: `apps/server/tests/cli-policy-edits.test.mjs`, `apps/server/tests/cli-commands.test.mjs`,
  `apps/server/tests/cli-sessions-format.test.mjs`, `apps/server/tests/cli-console.test.mjs`

**Interfaces:**
- Consumes: Task 3 `VIDEO_CODECS`, `CODEC_LABELS`, the policy `videoCodecs` validation,
  and status rows' `codec`.
- Produces:
  - `setVideoCodecs(policy, ids) → policy`, through `edit()` validation.
  - Context method `hostCodecs(): Promise<string[]>`:
    - Live: returns the array passed from `main.mjs`.
    - Offline: lazily imports `probe` from `../native-media.mjs` and returns
      `probe().codecs ?? ['h264']`. Failures are wrapped as `Codec information is
      unavailable: <message>. Check that the media worker is installed and the NVIDIA
      driver is working.` Accept an injectable `probeCodecs` option for tests, like
      `listDisplays`.
  - `formatCodecs(policy, hostCodecs) → string`.

**Command behaviour:**
- `codecs` (`where: 'both'`, `json: true`) prints a table with columns `#`, `Codec`,
  `Enabled`, `This GPU`:
  - Rows list `policy.videoCodecs` in order, numbered from 1, then the known codecs that
    are not enabled, with `#` empty.
  - `Enabled` shows `yes` or `no`. `This GPU` shows `supported` or `not supported`.
  - A final line: `Devices use the first enabled codec their browser can decode in
    hardware; H.264 is always the fallback.`
  - JSON data: `[{ id, label, enabled, order, supported }]` (`order` null when disabled).
- `codecs set <list>` (`mayDisconnect: true`; usage `codecs [set <codec,codec,…>]`):
  - Split on commas, trim, and lower-case. Accept `h.264`/`h.265` as aliases.
  - Unknown ids → `UsageError` naming the value and listing `av1, h265, h264`.
  - Apply through `context.updatePolicy('Use video codecs <labels>', (p) =>
    edits.setVideoCodecs(p, ids), { yes })`.
  - Ids missing from `hostCodecs()` are still saved. Add one line per codec to the
    outcome: `<label> is not supported by this GPU and will be skipped.`
  - Success text: `Video codec order is now AV1, H.265, H.264.` (labels in the saved
    order).
  - Wrong argument count, or a first positional other than `set` → `UsageError` with the
    usage.
- Sessions table header: `['Stream', 'Display', 'Size', 'Target', 'Profile', 'Codec',
  'Shared']`; the cell is `CODEC_LABELS[stream.codec] ?? ''`.

- [ ] **Step 1: Write failing tests**
  - `cli-policy-edits.test.mjs`:
    - `setVideoCodecs(shared, ['h264','av1']).videoCodecs` deep-equals the input.
    - `setVideoCodecs(shared, ['av1'])` throws `H.264 must stay enabled`.
  - `cli-commands.test.mjs`, using the file's fake context plus
    `hostCodecs: async () => ['h264','av1']`:
    - The `codecs` text shows AV1 enabled and supported, and H.265 enabled and not
      supported.
    - `codecs --json` → three rows with `order` 1, 2, 3.
    - `codecs set h264,av1 --yes` → `context.policy().videoCodecs` deep-equals
      `['h264','av1']`, and the text says `H.264, AV1`.
    - `codecs set av1,h265,h264 --yes` → includes
      `H.265 is not supported by this GPU and will be skipped.`
    - `codecs set av1` → error `H.264 must stay enabled`.
    - `codecs set vp9,h264` → usage error naming `vp9`.
    - `codecs bogus` → usage error.
  - `cli-sessions-format.test.mjs`: a stream row with `codec: 'h265'` renders `H.265` under
    a `Codec` header.
  - `cli-console.test.mjs`: the expected sessions header includes `Codec`.
  - Offline: where the tests exercise `createOfflineContext`, add a case where
    `probeCodecs` throws → `codecs` fails with `Codec information is unavailable`.
- [ ] **Step 2: Run to confirm failures:**
  `node --test apps/server/tests/cli-policy-edits.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-sessions-format.test.mjs apps/server/tests/cli-console.test.mjs`
- [ ] **Step 3: Implement** the edit helper, formatter, command, context methods and
  `main.mjs` wiring. Follow the `audio` command for confirmation and `outcome`.
- [ ] **Step 4: Run the Step 2 command.** Expected: all pass. Then run `npm test` in
  `apps/server` once, which covers help, completion and parity tests that enumerate
  commands. List every failure by name.

---

### Task 5: Web client: hardware-decode codec preferences and diagnostics codec

**Files:**
- Create: `apps/web-client/src/codec-preferences.js`
- Create: `apps/web-client/tests/codec-preferences.test.mjs`
- Modify: `apps/web-client/src/stream-subscriptions.js` (~55–63; `select` is already
  `async`)
- Modify: `apps/web-client/src/app.js` (~571–578, the legacy single-stream path)
- Modify: `apps/web-client/src/diagnostics.js` (~122 target line)
- Modify: `apps/web-client/tests/stream-browser-check.mjs`, if its fake answer or
  assertions depend on the H.264-only preference list

**Interfaces:**
- Consumes: Task 3 offer response `codec`; diagnostics snapshot `configuration.codec`.
- Produces, `codec-preferences.js`:
  - `export async function videoCodecPreferences(profile, env = globalThis) →
    RTCRtpCodec[]`, where `env` supplies `RTCRtpReceiver` and `navigator` so unit tests
    can inject fakes.
  - The function throws `Error('This browser cannot decode H.264.')` when capabilities
    have no `video/h264` entry.
  - Exports `CODEC_LABELS` for the diagnostics display, or duplicates the three labels
    locally. Don't import server code into the browser bundle.

**Behaviour of `videoCodecPreferences`:**
1. `const all = env.RTCRtpReceiver.getCapabilities('video').codecs`.
2. For `video/AV1`, then `video/H265`, both compared case-insensitively:
   - Skip the codec if `all` has no entry for it.
   - Call `env.navigator.mediaCapabilities.decodingInfo({ type: 'webrtc', video: {
     contentType: '<mime>', width: profile.width, height: profile.height, bitrate:
     profile.bitrateKbps * 1000, framerate: profile.fps } })`.
   - Include every `all` entry with that mime type only if the result has
     `supported && powerEfficient`.
   - Run the two checks with `Promise.all`.
   - Any throw, rejection or missing `mediaCapabilities` for a codec skips that codec.
3. Then all `video/h264` entries in capability order, then all `video/rtx` entries.
4. When `profile` is missing (legacy path before the profile is known), skip step 2
   entirely, so the result is H.264 + RTX.

- [ ] **Step 1: Write failing tests** (`node:test`, fake `env`):
  - Capabilities AV1, H265, H264 ×2, RTX, VP8; both decoding checks power-efficient →
    mime order `[av1, h265, h264, h264, rtx]` and no VP8.
  - AV1 `supported: true, powerEfficient: false` → no AV1.
  - The H265 `decodingInfo` rejects → no H265, AV1 still present.
  - `navigator.mediaCapabilities` undefined → `[h264, h264, rtx]`.
  - No H264 capability → throws `This browser cannot decode H.264.`
  - `decodingInfo` receives `type: 'webrtc'`, `contentType: 'video/AV1'`, and bitrate in
    bits per second (profile 4000 kbps → 4000000).
  - `profile` undefined → `decodingInfo` never called.
- [ ] **Step 2: Run to confirm failure:**
  `node --test apps/web-client/tests/codec-preferences.test.mjs`
- [ ] **Step 3: Implement and wire**
  - `stream-subscriptions.js`: the request only carries `displayId`, a profile id and the
    inventory revision. The profile's dimensions come back in the answer, after the
    offer. For the decode check, pass the most recent answer profile seen by this
    `StreamSubscriptions` instance (store it as `this.lastProfile` in `negotiate`), or the
    module constant `DECODE_CHECK_PROFILE = { width: 1920, height: 1080, fps: 30,
    bitrateKbps: 4000 }` before any answer.
  - On error: close `row.pc` and rethrow, as today. Also store `answer.codec` on the row
    in `negotiate` (`Object.assign(row, { profile, display, codec })`).
  - `app.js` legacy path: `transceiver.setCodecPreferences(await
    videoCodecPreferences(undefined))`, which stays H.264-only because the legacy route is
    H.264-only.
  - `diagnostics.js`: replace the fixed `H.264` with `CODEC_LABELS[data.configuration?.codec]
    ?? 'H.264'`.
- [ ] **Step 4: Run** `node --test apps/web-client/tests/codec-preferences.test.mjs` and
  `node apps/web-client/tests/stream-browser-check.mjs <playwright>`. Expected: pass.
  - The browser check uses the real `StreamRuntime` with fake media and the default
    `videoCodecs = ['h264']`, so its sources stay H.264.
  - If it fails only on codec-related expectations, update the check, not production code.

---

### Task 6: Windows host: Video codecs card and Sessions codec value

**Files:**
- Create: `apps/windows-host/HostWindow.Codecs.cs` (partial class; `RenderVideoCodecs()`)
- Modify: `apps/windows-host/HostWindow.Profiles.cs`: call `RenderVideoCodecs()` after
  `RenderClientCustomization()` (~185)
- Modify: `apps/windows-host/HostWindow.cs`:
  - Read `codecs` from the `ready` message (~66–71) into a field
    `string[] hostCodecs = ["h264"]`.
  - Replace the fixed `NVIDIA H.264` in `detail.Text` and `displayDescription` with the
    host codec labels joined with ` / `.
- Modify: `apps/windows-host/HostWindow.Sessions.cs`: add a `("Codec", codec)` detail next
  to Profile (~131, ~148, ~165)
- Modify: `apps/windows-host/tests/Navigation/App.xaml.cs`: policy fixture (~56), Sessions
  fixture rows, and assertions

**Interfaces:**
- Consumes:
  - Task 3 policy `videoCodecs`, the `ready.codecs` field and status stream rows' `codec`.
  - Existing `SavePolicy(JsonObject candidate, bool confirmed)`,
    `ConfirmProfileApply(string title)`, `policySaving`, `policyError`, `streamPolicy`,
    `server`, `sessionCards`, `Card`, `Label`, `Secondary`, `ResourceBrush`,
    `HostSpacing`.
- Produces: tags for tests. The card `Border`/panel has `Tag = "codec-card"`; each row
  `Grid` has `Tag = "codec-row"` and a `ToggleSwitch` named by automation name
  `Use <label>`.

**Card behaviour (`RenderVideoCodecs`):**
- Don't render the card when `streamPolicy` is null; the profiles page already shows its
  placeholder.
- Heading `Video codecs`. Description: `Each device uses the first enabled codec its
  browser can decode in hardware. H.264 is always available as the fallback.`
- Rows:
  - Enabled codecs come first, in `videoCodecs` order, then the disabled known codecs in
    the order `av1, h265, h264`.
  - Each row: a `ToggleSwitch` (empty On/Off content, like profile rows), a label (`AV1`,
    `H.265`, `H.264`, semibold), and a secondary text.
  - Secondary text: `Not supported by this GPU` when the codec isn't in `hostCodecs`,
    `Always on` for H.264, otherwise empty.
  - A `…` button with a `MenuFlyout` holding `Move up`/`Move down`, enabled only for
    enabled rows that can move within the enabled block.
- The H.264 toggle is on and disabled.
- An unsupported codec's toggle is disabled when off. When it's already on (stored), the
  toggle stays enabled so the host can turn it off.
- All controls are disabled when `server is null || policySaving`.
- Toggle or move:
  - Clone `streamPolicy` and rebuild `videoCodecs`. Enabling appends the codec before
    `h264`; disabling removes it; a move swaps neighbours.
  - If `sessionCards.Count > 0`, `ConfirmProfileApply("Apply codec change?")`. On cancel,
    re-render to reset the toggle.
  - `await SavePolicy(candidate, true)`.
  - Errors go to `policyError`, then re-render, matching `ChangeProfile`.

**Sessions:** `codec.Text = CodecLabel(row.GetProperty("codec"))`. Use `TryGetProperty`
and default `H.264` when absent, so older status rows still render.

- [ ] **Step 1: Update the navigation test first** (it is the failing test here):
  - Policy fixture JSON: add `"videoCodecs":["av1","h264"]`.
  - Set `hostCodecs` through reflection to `["h264","h265","av1"]` before rendering the
    profiles page.
  - On the `Streaming profiles` page, assert:
    - Exactly three `codec-row` grids, in label order `AV1`, `H.264`, `H.265`.
    - The `H.264` toggle is `IsOn && !IsEnabled`.
    - The `H.265` toggle is `!IsOn`.
    - A `TextBlock` `Always on` exists.
  - Set `hostCodecs` to `["h264"]` and re-render. Assert the `H.265` row shows `Not
    supported by this GPU` with its toggle disabled, and the `AV1` row (stored on) keeps
    an enabled toggle.
  - Sessions fixture: add `"codec":"av1"` to stream-one and omit it on stream-three.
    Assert a `TextBlock` `AV1` and a `TextBlock` `H.264` both exist in the session list.
- [ ] **Step 2: Build and run the navigation test to confirm failure** (commands from
  `apps/windows-host/tests/Navigation/README.md`):
  - `dotnet build apps/windows-host/tests/Navigation/Navigation.csproj -c Debug`
  - Run `apps/windows-host/tests/Navigation/bin/Debug/net10.0-windows10.0.26100.0/win-x64/Navigation.exe`
    and wait for exit. Expected: non-zero exit with a codec card message.
- [ ] **Step 3: Implement** the card, the `ready.codecs` field and the Sessions codec value
  as specified above. Follow the row layout, spacing and styles of `RenderProfiles`; don't
  invent new resources.
- [ ] **Step 4: Rebuild and run the navigation test.** Expected: exit code 0. Also build the
  host project once: `dotnet build apps/windows-host/VidVnc.Host.csproj -c Debug`.

---

### Task 7: End-to-end verification and changelog

**Files:**
- Modify: `CHANGELOG.md` (add an `## [Unreleased]` section above `0.2.0` with Added: AV1
  and H.265 hardware encoding with per-device selection; host `codecs` command and Video
  codecs card; Changed: Sessions show each stream's codec)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Native:** `build-native.cmd`; `ctest --output-on-failure`;
  `node --test native/media-worker/tests/native-worker.test.mjs`.
- [ ] **Step 2: Hardware gates:**
  - `node native/media-worker/tests/shared-stream-check.mjs <playwright> h264`, then
    `av1`, then `h265`.
  - `node native/media-worker/tests/multi-stream-check.mjs <playwright>` as a regression
    check, since source keys now include the codec.
- [ ] **Step 3: Server and web:** `npm test` at the repo root; `node
  apps/web-client/tests/stream-browser-check.mjs <playwright>`.
- [ ] **Step 4: Host:** the navigation test (Task 6 Step 4 commands).
- [ ] **Step 5: Formatting:** `npm run format:check`. If it reports files, run
  `npm run format:web` and re-check. Report formatted files separately so the user can
  commit formatting first, matching the v0.2.0 release.
- [ ] **Step 6: Report:**
  - Every command with PASS/FAIL, and every failing test by name.
  - The three `shared-stream-check` codec lines.
  - Manual acceptance still owed by the user: an iPhone on Safari connects, the
    diagnostics page shows `H.265` or `AV1`, and the picture decodes. It's recorded
    separately from the synthetic checks.
  - Leave everything uncommitted.
