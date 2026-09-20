# Variable bitrate profiles

Approved direction (2026-09-20): add a per-profile variable bitrate (VBR) mode with a
quality level, alongside today's constant bitrate (CBR). Hosts opt profiles in; nothing
changes for existing installs. Variable frame rate is out of scope.

Background and measurements: [Variable frame rate and variable bitrate
investigation](../../investigations/VARIABLE-RATE-INVESTIGATION.md). In short, plain VBR
saves almost nothing at NVENC's low-latency settings. The saving (about 93% on a static
screen, 89% idle-then-burst, 78% scrolling, H.264 at 2560x1440) comes from a quality
floor (`qp-min-*`), a peak ceiling (`max-bitrate`) and a longer keyframe interval,
applied together.

## Goals and decisions

- **Control:** per profile, host-defined. Each profile gets `bitrateMode` (`cbr` or
  `vbr`) and `quality` (`efficient`, `balanced` or `high`), mirroring the existing
  `frameDelivery` field. Clients still choose a profile or Automatic. Client custom
  options stay CBR.
- **Meaning of `bitrateKbps`:** under VBR it is the sustained cap. The worker sets the
  peak (`max-bitrate`) to twice that. Its range (100 to 50000) and its use in host
  budgets and shared-encode keys do not change.
- **Quality:** a per-profile level rather than a fixed constant. It sets the quality floor
  per codec and only takes effect under VBR.
- **Keyframes:** VBR profiles use a 10 second interval. CBR profiles keep one second.
  Loss recovery on VBR profiles depends on the existing keyframe-request paths.
- **Defaults:** every seeded profile and every saved profile without the new fields is
  `cbr` / `balanced`. Upgrading changes no behaviour.
- **Where the mapping lives:** the native worker. The profile carries only mode and
  quality; the worker owns a per-codec table of encoder settings.
- **Not in scope:** variable frame rate and any Windows Graphics Capture keepalive,
  client-selectable mode, VBR in custom client options, per-display settings, adaptive
  bitrate and live reconfiguration.

## Profile model and policy (server)

- `stream-policy.mjs` profiles gain `bitrateMode` (`cbr` | `vbr`) and `quality`
  (`efficient` | `balanced` | `high`). The exact-key-set check includes both.
  `frameDelivery` stays `fixed` and its "not supported yet" message is unchanged.
- `schemaVersion` stays 1. Before validating, `validateStreamPolicy` fills in a profile's
  missing fields with `cbr` and `balanced`, the same way it already fills `displaySharing`
  and `videoCodecs`. `defaultStreamPolicy` and the seeds in `profiles.mjs` carry the same
  values.
- Any other value for either field is rejected with `Bitrate mode is invalid` or
  `Quality is invalid`.
- `resolveStreamPolicy` returns `bitrateMode` and `quality` in `profile`. Custom client
  settings (client options mode) resolve to `cbr` / `balanced`; `allowedOptions` is
  unchanged.
- `sourceKey` in `stream-registry.mjs` adds `bitrateMode`, and `quality` only when the
  mode is `vbr`, because GOP length and QP floors change the encoded bytes. Two profiles
  that differ only in an ignored quality still share one encode.
- Budget checks keep summing `bitrateKbps` and `width x height x fps`. The 2x peak is not
  budgeted separately.
- `native-media.mjs` adds the two fields to the `streamPlan` it sends the worker.

## Native worker

### Protocol

`streamPlan` carries `bitrateMode` and `quality` strings in addition to the five current
numbers. `parse_stream_profile` stays strict: exactly seven keys, five integers plus two
strings that must be one of the allowed values. Any other shape is fatal, as today. There is
no five-key compatibility path because the server and worker ship together.

`StreamProfile` gains a mode and a quality with default values `cbr` and `balanced`. The
legacy named profiles in `media-worker.cpp` are aggregate-initialised and remain CBR
without edits.

### Rate-control table

A new `native/media-worker/src/rate-control.hpp` holds a pure function from codec and
profile to the encoder's rate-control properties and GOP length.

- **CBR:** exactly today's output: `rc-mode=cbr bitrate=<B> gop-size=<fps>`. A test pins
  this to the current string.
- **VBR:** `rc-mode=vbr bitrate=<B> max-bitrate=<2B> qp-min-i=<i> qp-min-p=<p>
  gop-size=<fps x 10>`, with `i` and `p` taken from the table below.

Starting QP floors (`qp-min-i` / `qp-min-p`). H.264 `balanced` and `efficient` are
measured in the investigation. The other values are starting points that implementation
replaces with values chosen by the procedure in [Testing](#testing-and-validation):

| Quality | H.264 and H.265 (0 to 51) | AV1 (0 to 255) |
| --- | --- | --- |
| `efficient` | 30 / 34 | 150 / 170 |
| `balanced` | 24 / 28 | 120 / 140 |
| `high` | 20 / 24 | 100 / 120 |

`gst-inspect-1.0` shows `qp-min-i`, `qp-min-p` and `max-bitrate` on all three encoders
(`nvd3d11h264enc`, `nvd3d11h265enc`, `nvd3d11av1enc`). The rest of the pipeline is
unchanged: preset p3, ultra-low-latency tuning, no B-frames, zero latency, repeated
headers, the keyframe recovery paths and the `fps == 15` mobile coupling. The H.264 level
3.1 cap for 15 fps at 720p or below is unaffected, since the largest peak there
(2 x 2000 kbit/s) is far below the level's limit.

### Diagnostics and failure

- `metrics` reports `bitrateMode` and `quality`. No server-measured encode bitrate is
  added; the client already reports received Mbit/s.
- If an encoder lacks a property, the pipeline fails to parse and the stream errors
  visibly. There is no per-codec VBR capability negotiation.

## CLI, host app and web client

The CLI and host app stay in parity (`cli-parity.test.mjs`).

- **CLI:** `profile add` and `profile edit` gain `--bitrate-mode cbr|vbr` and
  `--quality efficient|balanced|high`. New profiles default to CBR and balanced.
  `--quality` on a CBR profile is accepted and stored but ignored. `policy-edits.mjs` adds
  the fields to its defaults and editable list. The `profiles` table's Bitrate column reads
  `6 Mbit/s` for CBR and `up to 6 Mbit/s (VBR, balanced)` for VBR. Usage text and Tab
  completion cover the new flags and values. The `options` commands are unchanged.
- **Windows host app:** the profile editor in `HostWindow.Profiles.cs` gets a Bitrate mode
  choice (Constant or Variable) and a Quality choice, enabled only for Variable. Under
  Variable, the bitrate field's label becomes "Maximum sustained bitrate (kbit/s)". New
  profile defaults gain the two fields. The profile row shows "up to 6 Mbit/s · Variable".
- **Web client:** the profile picker line reads "up to 6 Mbit/s" for VBR profiles and the
  diagnostics "Targets" line names the mode. The profile catalog payload adds
  `bitrateMode` and `quality` so both can be labelled. Clients cannot choose a mode.
- **Sessions and diagnostics:** wherever they already show the profile they also show its
  mode and quality, presented as targets, never as measurements.
- **Docs:** the changelog and a short README note at release time. The ROADMAP's adaptive
  Automatic quality section links to the investigation and this design.

## Testing and validation

### Automated, no GPU

- `stream-policy.test.mjs`: profiles missing the new fields load as `cbr` / `balanced`;
  both enums reject invalid values; resolved plans carry mode and quality; custom client
  settings resolve to CBR.
- `stream-registry.test.mjs`: VBR and CBR get different source keys; quality splits keys
  only under VBR; budgets are unchanged.
- CLI tests: `cli-policy-edits`, `cli-commands`, `cli-completion`, formatting and parity.
- Native: `stream-profile.cpp` covers the seven-key parse and the enum rejections. A new
  rate-control test pins the CBR string, and checks that VBR produces a 2x peak, a GOP of
  ten seconds of frames and the per-codec QP floors.
- Host app and web client tests for the new labels, in their existing test projects.

### GPU, on the development machine

- A VBR profile starts and produces frames on each codec (worker self-test and the
  shared-stream check).
- QP tuning: repeat the investigation's static, burst, scroll and video measurements per
  codec and quality. The floors must give strictly ordered bitrates (`efficient` below
  `balanced` below `high`) and none may exceed the sustained cap. Record the chosen
  values with the measurements that justified them, in the table's comments and in the
  investigation document.
- Visual check: capture frames of dense small text at each level and judge legibility by
  eye. `balanced` must stay readable at 100%. The investigation measured bitrate only, so
  this is the first look at picture quality.

### Before changing the seeded profiles to VBR

This is not needed to ship, because VBR is opt-in.

- A real iPhone test with forced packet loss, timing recovery under the 10 second interval
  and the worker's one-per-2-seconds recovery keyframe limit.
- A browser check that a long GOP decodes, and that a client joining a static screen
  mid-interval receives a keyframe promptly.

## Risks

- QP scales differ between H.264/H.265 and AV1, so each codec's floors need their own
  tuning.
- A 2x peak on iPhone paths may aggravate the burst behaviour the roadmap already flags.
- With a 10 second interval, a lost packet heals only through a keyframe request or the
  next keyframe.
