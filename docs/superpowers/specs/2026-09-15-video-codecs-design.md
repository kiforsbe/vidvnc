# Video codecs: AV1 and H.265

Approved direction (2026-09-15): add AV1 and H.265 alongside H.264, chosen automatically
per device, at the profile's bitrate. H.264 remains the universal fallback.

## Goals and decisions

- **Codecs:** AV1 (`nvd3d11av1enc`) and H.265/HEVC (`nvd3d11h265enc`), both NVENC hardware
  encoders. VP9 is out of scope: NVIDIA has no VP9 encoder, and software `vp9enc` cannot
  sustain 1080p/1440p at 30 fps with low latency.
- **Selection:** automatic per device. The browser limits its offer to codecs it can decode
  in hardware (plus H.264); the server picks the first host-enabled codec, in host order,
  that the offer contains. Profiles stay codec-free. There is no client codec picker.
- **Bitrate:** unchanged. AV1 and H.265 spend their efficiency on quality at the profile's
  bitrate; host budgets are unaffected.
- **Latency:** every codec uses the same low-latency configuration as H.264 today: preset
  p3, ultra-low-latency tuning, CBR, GOP of one second, no B-frames, headers repeated on
  keyframes so late joiners can decode.

Test machine: GeForce RTX 5060 Ti; the GStreamer 1.28 SDK provides
`nvd3d11h265enc`, `nvd3d11av1enc`, `h265parse`, `av1parse`, `rtph265pay` and `rtpav1pay`.

## Native worker

### Codec table

A new header `native/media-worker/src/video-codec.hpp` describes each codec:

| | `h264` | `h265` | `av1` |
| --- | --- | --- | --- |
| Encoder | `nvd3d11h264enc` | `nvd3d11h265enc` | `nvd3d11av1enc` |
| Caps after encoder | Current caps (unchanged) | `video/x-h265,profile=main,stream-format=byte-stream,alignment=au` | `video/x-av1,stream-format=obu-stream,alignment=tu` |
| Parser | `h264parse` | `h265parse` | `av1parse` |
| Payloader (per peer) | `rtph264pay` with current settings (unchanged) | `rtph265pay config-interval=-1` | `rtpav1pay` |
| RTP caps encoding-name | `H264` | `H265` | `AV1` |
| Offer rtpmap | `H264/90000` | `H265/90000` | `AV1/90000` |
| Offer fmtp requirement | Current rule (unchanged) | `profile-id=1` or no `profile-id` | `profile=0` or no `profile` |

The encoder element keeps the name `encoder` so telemetry, recovery probes and
`request_keyframe` work for every codec. Encoder property names common to all three
(`preset`, `tune`, `rc-mode`, `bitrate`, `gop-size`, `bframes`, `zerolatency`,
`repeat-sequence-header`) must be verified per element with `gst-inspect-1.0` before
implementation; any property an element lacks is omitted for that codec, and the table
records the substitute.

### Protocol

- `start` gains `codec`: `"h264"` (default when absent), `"h265"` or `"av1"`. Any other value
  is fatal (`Invalid video codec`). `codec` is ignored when `video` is false.
- `select_payloads(sdp, codec)` selects the video payload for the source's codec with the
  rules in the table. H.264 keeps its current choice among multiple matches; for H.265 and
  AV1 the first match wins. Payload numbers keep the 1–3 digit ≤ 127 guard for every codec.
- `add-peer` for an offer without the codec fails the peer with
  `Browser must offer AV1.` / `Browser must offer H.265.` / the existing H.264 message.
- `metrics` gains `codec`.

### Probe, preflight and self-test

- The `nvcodec` plugin registers only encoders the GPU supports, so `--probe` adds
  `codecs`: the codecs whose encoder, parser and payloader factories all exist, in the order
  `h264`, `h265`, `av1`.
- Preflight still requires only the H.264 chain; GPUs without H.265 or AV1 keep working.
- `--self-test-codec <codec>` encodes 60 frames with that codec (1280×720, 30 fps) and
  reports frames and keyframes. SPS profile/level parsing stays H.264-only.

### Unchanged

Capture, the tee fan-out, peer bins, SSRC rules, input, control permission, recovery
limits and one worker per source.

## Server

### Host setting

- The stream policy gains `videoCodecs`: an ordered array of enabled codecs. Default
  `['av1', 'h265', 'h264']`.
- Validation: entries are known codecs, no duplicates, and `h264` must be present.
- A stored policy without the field loads with the default; no migration step.
- Editing the list bumps the policy revision like other policy edits. Live streams keep
  their codec until they reconnect; revalidation does not stop them for a codec change.

### Selection

- `selectVideoCodec(offerSdp, policyCodecs, hostCodecs)` (pure, in a new
  `apps/server/src/video-codecs.mjs`) reads the offer's video `a=rtpmap` encoding names and
  returns the first codec in `policyCodecs` that is also in `hostCodecs` (from the probe) and
  in the offer. With no match it throws `Browser must offer a supported video codec.`
  with `status: 400`.
- `StreamRuntime.offerVideo` selects the codec after policy resolution and before admission,
  and stores it in the plan as `codec`.
- `hostCodecs` comes from `probe().codecs` in `main.mjs` (missing → `['h264']`) and is passed
  to `StreamRuntime` as `videoCodecs`.
- `media.start` receives `codec`; `NativeMedia.start` writes it into the `start` command.

### Sharing, budgets, responses

- The video source key appends the codec:
  `video|<revision>|<display id>|<x>,<y>,<width>,<height>,<rotation>|<width>x<height>@<fps>|<bitrateKbps>|<codec>`.
  Viewers with different codecs get separate encodes; same-codec viewers still share.
- Host budgets are unchanged (bitrate and pixels are codec-independent).
- The offer response gains `codec`. `status()` stream rows gain `codec`. Diagnostics record
  it through `startStream`.
- The legacy `/api/offer` route and `NativeMedia.offer` compatibility stay H.264-only.

### CLI

- `codecs` shows the host order, whether each codec is enabled, and whether this GPU
  supports it.
- `codecs set <list>` (for example `codecs set av1,h265,h264`) replaces the order and
  enabled set, with the same confirmation and revision handling as other policy edits. It
  is also available in `config` mode, with `--json` for the read form.
- The sessions table gains a `Codec` column (`AV1`, `H.265`, `H.264`).

## Browser client

- A shared helper `videoCodecPreferences(profile)` builds the codec preference list used by
  `stream-subscriptions.js` and `app.js`:
  1. For AV1, then H.265: include the codec only if `RTCRtpReceiver.getCapabilities('video')`
     lists it and `navigator.mediaCapabilities.decodingInfo({ type: 'webrtc', video: {
     contentType: 'video/AV1' | 'video/H265', width, height, framerate, bitrate } })` resolves
     with `powerEfficient: true`.
  2. H.264 always follows, then RTX.
  3. If capability checks are missing or throw, the list is H.264 and RTX only.
- The transceiver uses `setCodecPreferences(list)`. The "cannot decode H.264" error stays.
- The diagnostics target line shows the negotiated codec from the offer response instead of
  the fixed "H.264".

## Windows host app

- The Streaming profiles page gains a **Video codecs** card: AV1, H.265 and H.264 rows, each
  with an on/off switch and reorder buttons matching the existing profile-order controls.
  H.264's switch is on and disabled. Codecs missing from the probe show
  "Not supported by this GPU" and cannot be enabled.
- Changes are sent through the owner pipe and applied as a policy revision.
- Sessions stream rows gain a **Codec** value next to Profile, updated in place on metric
  ticks.

## Failures

| Situation | Behaviour |
| --- | --- |
| Offer contains no enabled, host-supported codec | 400 `Browser must offer a supported video codec.`; nothing admitted |
| Worker cannot build the chosen encoder | `start` fails fatally; subscriptions on that source fail as today |
| Peer offer lacks the source codec (should not happen after selection) | `peer-failed` with the codec-specific message |
| Host GPU changes and loses a codec | Probe omits it; selection skips it; stored policy keeps it |

## Risks to verify first

1. **Answer compatibility.** `webrtcbin` builds the answer from payloader caps. H.265
   `level-id`/`tier-flag` and AV1 `profile`/`level-idx`/`tier` must be acceptable to Chrome
   and Safari; Safari is strict. If needed, caps carry the offer's fmtp parameters.
2. **AV1 encoder properties.** `nvd3d11av1enc` must support CBR, one-second GOP, no
   B-frames, low-latency tuning and repeated sequence headers.
3. **Late join and recovery.** Join keyframes and PLI-triggered keyframes must produce
   decodable key frames for AV1 (`rtpav1pay` sending the sequence header with key frames)
   and H.265 (`config-interval=-1` sending VPS/SPS/PPS).

These are checked by a hardware gate before server and client work, as in the shared
streams plan.

## Testing

- **Native unit tests:** `select_payloads` per codec (AV1 profile 0 and absent, H.265
  profile-id 1 and absent, incompatible profiles, missing codec, injected payload numbers);
  `video-codec.hpp` descriptions per codec.
- **Native session tests:** `--self-test-codec h265` and `av1` encode 60 frames where the
  probe lists the codec (skipped otherwise); `--probe` reports `codecs`.
- **Server tests:** `selectVideoCodec` ordering and fallbacks; policy validation (H.264
  required, duplicates, old files); source key split by codec; runtime passes `codec` to
  `start` and returns it; CLI `codecs` read/set and the sessions `Codec` column.
- **Hardware checks:** `shared-stream-check.mjs` runs per codec on headless Chromium. AV1 is
  required; H.265 runs where Chromium reports hardware HEVC decode and prints NOT TESTED
  otherwise.
- **Navigation fixture:** the Video codecs card (locked H.264, unsupported codec) and the
  Sessions codec value.
- **Manual acceptance:** an iPhone on Safari negotiates H.265 or AV1 and decodes; recorded
  separately from synthetic evidence.
