# Hardware encoder backends

Approved direction (2026-09-21): VidVNC gains Intel Quick Sync, AMD AMF and Microsoft
Media Foundation encoder backends alongside today's NVENC, so it runs on integrated
graphics and on AMD and Intel discrete cards. Encoder choice becomes automatic, preferring
the GPU that captured the frame, with an explicit host override. No software encoder and
no software capture: hardware encoding stays a requirement.

## Background

Today the worker is NVENC-only in five places, and each has to change:

- `video-codec.hpp` gives each codec exactly one `encoder` element name, all three
  `nvd3d11*enc`.
- `pipeline_description` in `media-worker.cpp` appends NVENC-only properties to whatever
  that element is: `preset=p3`, `tune=ultra-low-latency`, `bframes=0`, `zerolatency=true`.
- `rate-control.hpp` emits NVENC property spellings: `rc-mode`, `qp-min-i`, `qp-min-p`.
- `preflight` hard-requires the `nvd3d11h264enc` factory, so the worker refuses to start
  on any non-NVIDIA machine before it ever reaches the probe.
- `MINIMUM_DIMENSIONS` in `video-codecs.mjs` holds NVENC's input-size floors (AV1
  192x128, H.265 144x48) as if they were codec properties. They are encoder properties.

Packaging bundles only `gstnvcodec.dll`, so the new elements would not exist in a
packaged build even where the hardware supports them.

### Why this is worth doing

Discrete desktop graphics cards were 12.5 million of 75.5 million PC GPUs shipped in
Q2 2026. Better than four in five PCs display through integrated graphics, and VidVNC
refuses to start on all of them. On Steam, which skews heavily toward gaming desktops and
so overstates NVIDIA's share for our purposes, the split in July 2026 was NVIDIA 72.7%,
AMD 18.7%, Intel 8.2% — and in June 2026 a laptop GPU led the individual-card chart for
the first time.

### Hardware capability on 2021 and newer silicon

H.264 and H.265 encoding are universal across every vendor and tier in scope. AV1
encoding is the 2022-and-newer tier everywhere: NVIDIA from Ada (RTX 40), Intel from Arc
and Core Ultra (Meteor Lake) — notably *not* 11th-to-14th-generation Xe integrated
graphics — and AMD from RDNA3 (RX 7000, Radeon 780M), with RDNA2 decoding AV1 but not
encoding it.

This matters for the codec-order defaults: on a large share of newly supported machines
AV1 will simply be absent, and H.265 becomes the efficient choice rather than the middle
one.

### Why Media Foundation and not Direct3D 12

Both were considered as the vendor-neutral fallback. `mfh264enc` and `mfh265enc` accept
`memory:D3D11Memory` directly, so they drop into the existing
`d3d11screencapturesrc ! d3d11convert` chain with no topology change, and they expose a
real `low-latency` property. `d3d12h264enc` requires `memory:D3D12Memory`, which would
mean maintaining a second capture path through `d3d12screencapturesrc`; it is H.264-only,
and exposes neither a low-latency nor a B-frame property. Media Foundation gives more
coverage for less surface, so Direct3D 12 is out of scope.

### The property dialects differ

The four backends do not agree on how to ask for the same thing. Bitrate is in kbit/s
everywhere, which is the one portable part; nothing else is.

| | NVENC | QSV | AMF | Media Foundation |
|---|---|---|---|---|
| Low latency | `preset=p3 tune=ultra-low-latency zerolatency=true` | no such property | `usage=ultra-low-latency preset=speed` | `low-latency=true` |
| Rate control | `rc-mode` | `rate-control` | `rate-control` | `rc-mode` |
| VBR spelling | `vbr` | `vbr` | `vbr` | `pcvbr` (no plain `vbr`) |
| QP floor | `qp-min-i`, `qp-min-p` | `min-qp-i`, `min-qp-p` | **varies by codec**, see below | `min-qp` (not per frame type) |
| B-frames | `bframes` | `b-frames` | `b-frames` on H.264 only | `bframes` |
| AV1 | Ada and newer | `qsvav1enc` | `amfav1enc` | none |
| Minimum input | AV1 192x128 | 16x16 | 128x128 | 64x64 |

Three consequences run through the rest of this document. Media Foundation has no plain
`vbr` and only a single global QP floor, so it is the backend most likely to need
per-backend special handling rather than table entries. QSV has no low-latency or
target-usage property at all, so its latency has to come from `rate-control=cbr`,
`b-frames=0`, `ref-frames=1` and a short GOP.

The third is the sharpest, and was found by checking the installed elements rather than
the documentation. **AMF does not spell its properties consistently across its own
codecs**, verified on 2026-09-21:

| | `amfh264enc` | `amfh265enc` | `amfav1enc` |
|---|---|---|---|
| QP floor | `min-qp` (global) | `min-qp-i`, `min-qp-p` | none at all |
| B-frames | `b-frames` | absent | absent |

This is not a detail. A property name an element does not declare is not ignored —
`gst_parse_launch` refuses the whole pipeline, so a table that assumed one AMF spelling
would have taken AMD support from "works" to "does not start", and the self-test gate
would have reported the hardware as simply unavailable. A family therefore cannot hold a
single property name for its codecs. The floors are stored as an ordered list of candidate
spellings and the first name the element actually declares is the one emitted; where an
element declares none, the property is dropped and logged. Dropping a floor costs quality
at the VBR tiers, which is recoverable; emitting an unknown name loses the vendor outright.

### The constraint that shapes the design

The development machine carries an AMD Radeon integrated GPU and an NVIDIA RTX 5060 Ti,
which is itself the hybrid configuration this design cares most about. Checked on
2026-09-21 with `gst-inspect-1.0` and a 30-frame `gst-launch-1.0` encode:

| Backend | Registers here | Encodes here |
|---|---|---|
| NVENC | yes | yes, and already in production use |
| AMF | yes | yes |
| Media Foundation | yes | yes |
| Quick Sync | no | no Intel graphics on this machine |

So three of the four backends can be verified, and **only Quick Sync ships without ever
being run**. That is a much better position than assumed when this work started, but it
does not change the design. The defensive decisions below — runtime property
introspection, a per-backend self-test gate, degrading instead of failing — are what make
a backend verifiable rather than merely plausible, and they are what will carry Quick Sync.
They should not be simplified away later on the grounds that most backends turned out to
be testable.

The development machine can also exercise adapter affinity for real, because it genuinely
has two adapters. Its display turns out to be driven by the RTX 5060 Ti rather than the
integrated Radeon, so today's NVENC-only pipeline is *not* paying a cross-adapter copy
here; affinity is still worth building, but this machine confirms it rather than being
rescued by it. The probe reports `nvenc` and `mediafoundation` on the capture adapter and
`amf` off it, which is exactly the arrangement the ranking has to get right.

## Goals and decisions

- **Backends:** NVENC, Quick Sync (QSV), AMF and Media Foundation. A backend is a
  property dialect plus a set of element names, not a vendor.
- **Codec identifiers do not change.** `h264`, `h265` and `av1` stay the protocol, policy
  and CLI vocabulary everywhere. The backend is an implementation detail of how a codec
  gets encoded, never part of the codec identity, the SDP, or the stream registry's
  sharing key beyond what already varies.
- **Selection is automatic and prefers the capture adapter.** The worker prefers a backend
  on the same GPU that DXGI captured from, then falls back to a fixed order. A host
  setting overrides it.
- **The override is a host-level setting, not a per-profile field.** Profiles stay about
  what the stream looks like; which silicon encodes it is a machine property.
- **Encoder properties are built by introspection, not concatenation.** The worker asks
  the element class which properties exist and what their numeric ranges are, and emits
  only what is there. A missing property is skipped, never a pipeline parse failure on a
  user's machine.
- **VBR quality floors are stored normalised and scaled per element.** The measured RTX
  5060 Ti floors become fractions of the QP range, rescaled to whatever range the target
  element declares at runtime.
- **A backend that cannot complete a real encode is not advertised.** Availability means
  a passed self-test, not a found factory.
- **`preflight` requires one working H.264 encoder, not NVENC.**
- **Not in scope:** software encoding, software capture, Direct3D 12 encoding, VP9,
  10-bit or HDR, multi-GPU encode load balancing, changing backend mid-session, and any
  re-tuning of the NVENC VBR floors themselves.

## Encoder backends in the native worker

### Splitting the codec table

`video-codec.hpp` currently holds one row per codec mixing two unrelated concerns. It
splits:

- `VideoCodec` keeps what is genuinely codec-level and backend-independent: the id,
  label, caps string, parser, payloader, payloader extras, RTP
  encoding-name, rtpmap and the browser-unsupported message. These describe the bitstream
  and how it is carried, and are identical whichever chip produced it.
- A new `encoder-backend.hpp` holds `EncoderBackend`: the backend id and label, the
  element name per codec id (absent where the backend has no encoder for that codec), the
  property dialect, the low-latency property fragment, and the per-codec minimum input
  dimensions.

The one-line lookup that replaces `video_codec->encoder` takes a backend and a codec id
and returns an element name or nothing. "Nothing" is the normal answer for Media
Foundation and AV1, and is not an error.

`encoder_extra` is worth a note: today it carries H.264's `repeat-sequence-header=true`,
which is an NVENC spelling. It moves into the backend dialect as "the property that makes
the encoder repeat SPS/PPS", since each backend spells that differently or achieves it
through the parser instead.

### The property dialect

`EncoderBackend` names, for its own element family, the property used for rate-control
mode and the enum spelling it wants for constant and variable bitrate; the target and
peak bitrate properties; the GOP-length property; the B-frame property; the QP-floor
properties for I and P frames, or the single global one where that is all the backend
has; and the literal fragment that requests lowest latency.

Media Foundation is the awkward case and the design accepts that rather than forcing it
into the table. It has no plain `vbr`: its variable mode is `pcvbr` driven by
`max-bitrate`, and it has one `min-qp` covering all frame types rather than one per frame
type. The dialect therefore allows a backend to declare a single QP floor property, in
which case the worker applies the I-frame floor to it and drops the P-frame floor.

### Building encoder properties by introspection

`rate-control.hpp` stops returning a property string and starts returning the intent:
mode, target bitrate, peak bitrate, GOP length, and the two QP floors as normalised
fractions. A new step turns that intent into a property string for a specific element.

That step loads the element factory, takes its class, and for each property it wants to
set asks whether the class actually has it. Present, it is emitted; absent, it is skipped
and noted in the worker log. For the QP floors it also reads the property's declared
numeric maximum from the parameter specification and scales the normalised floor onto it.

This is what makes "port the floors by scale conversion" safe to ship blind. The GStreamer
documentation does not publish the QP ranges for QSV and AMF AV1 encoding, and the three
AV1 encoders do not obviously agree — a hand-written conversion table would be a guess
about hardware that cannot be checked here. Reading the range from the element removes the
guess. The measured NVENC floors stay the source of truth for what quality tier means; only
the arithmetic to express them changes per element.

The residual risk is bounded and worth stating plainly: a floor that lands too low costs
efficiency, because the encoder spends more bits, but it cannot breach the bitrate cap.
`max-bitrate` at twice the sustained rate still holds regardless of the floor. The failure
mode is a VBR stream that behaves more like CBR on an untested backend, not a stream that
overruns its budget.

## Selecting a backend

### Adapter affinity

DXGI desktop duplication captures on whichever GPU drives the monitor. On a hybrid
laptop that is normally the integrated one, so `d3d11screencapturesrc` produces textures
on the Intel or AMD adapter even when an NVIDIA card is present. Those textures are then
handed to an NVIDIA encoder, which means a cross-adapter copy of every frame at capture
resolution. Adding Intel and AMD backends is therefore not only a compatibility change:
on a machine wired that way, picking the encoder that already owns the texture removes
per-frame work.

Which GPU drives the display is a per-machine fact and not something to assume. The
development machine drives its display from the discrete card, so it pays no such copy
today — the point of affinity is that the worker measures this rather than guessing it
either way.

The capture element does not report its adapter. Checked on 2026-09-21,
`d3d11screencapturesrc` exposes only `adapter`, a DXGI index that applies to Windows
Graphics Capture mode, and no `adapter-luid`. The worker therefore derives the capture
adapter from the monitor it is capturing: the display inventory already holds each
monitor's handle, and DXGI's adapter and output enumeration maps that handle to the
adapter that drives it, which is exactly the GPU desktop duplication captures on. Where
that mapping fails, the capture adapter is reported as unknown and ranking degrades to the
fixed order.

Encoder elements do report theirs: `nvd3d11h264enc` exposes `adapter-luid`, checked the
same day. The worker reads it per candidate and ranks them:

1. Elements that declare an `adapter-luid` matching the capture adapter.
2. Elements that declare an `adapter-luid` for some other adapter.
3. Elements that do not expose the property at all, which are treated as
   adapter-agnostic and cannot be reasoned about.

Ties inside a rank break by a fixed backend order: NVENC, QSV, AMF, then Media
Foundation last, because it wraps whichever Media Foundation Transform the system
provides and gives the least control over latency. In practice the vendor order rarely
decides anything, since a machine with an Intel GPU has no NVENC elements registered at
all; what the order really settles is that a vendor backend always beats the generic one.

Whether a given element exposes `adapter-luid` is not assumed. The same introspection
used for encoder properties answers it, and an element that does not expose it still
works — it is simply ranked last rather than excluded.

### The host override

Stream policy gains a top-level `encoderBackend` field alongside `videoCodecs`:
`auto` (the default), `nvenc`, `qsv`, `amf` or `mediafoundation`. It belongs in stream
policy rather than access settings because changing it must restart streams, and access
settings exists precisely for values that must not.

`schemaVersion` stays 1. A saved policy without the field is filled in with `auto` before
validation, the same way `videoCodecs` and `displaySharing` already are, so upgrading
changes nothing. Any other value is rejected with `Encoder backend is invalid`.

A forced backend that turns out to be unavailable on this machine does not fail the
session. The worker falls back to automatic selection and records the substitution, which
surfaces in diagnostics and in the host app. Refusing to stream because a saved setting
no longer matches the hardware would be the wrong trade for a setting that follows a
machine's configuration file onto different hardware.

## Probe protocol and the server contract

`--probe` reports `encoder` as the literal string `nvd3d11h264enc` and `codecs` as a
flat array of codec ids. Both change.

- `codecs` keeps its meaning and its shape: the codec ids this machine can encode with at
  least one backend. Existing server code that intersects it with policy keeps working
  unchanged.
- A new `backends` array describes what is actually available: for each backend, its id,
  its label, the codec ids it can encode, its per-codec minimum input dimensions, and
  whether it sits on the capture adapter.
- `encoder` becomes the element name the worker would choose right now under the current
  selection policy, rather than a constant. It stays a single string for diagnostics.

`MINIMUM_DIMENSIONS` in `video-codecs.mjs` is deleted. Minimum input size is a property of
an encoder element, not of a codec, and hardcoding NVENC's floors would reject profiles
that QSV — whose floor is 16x16 — would encode happily, while accepting profiles AMF
cannot take. `selectVideoCodec` instead takes the minimums from the probe's `backends`
entry for the backend that will actually be used, and a codec is only eligible if some
available backend can encode it at the resolved profile's size.

This is the one place where backend leaks into the server, and it does so as data from
the probe rather than as a hardcoded table. The server never names an element.

## Preflight, self-test and failure

### Preflight

`preflight`'s element list splits into two parts. The elements that are genuinely
mandatory — the capture, conversion, WebRTC, RTP, DTLS, SRTP, SCTP and ICE elements —
stay a hard requirement, since nothing works without them. The encoder, parser and
payloader requirement becomes: at least one backend must offer a working H.264 encoder,
with `h264parse` and `rtph264pay` present.

H.264 stays the codec that must exist because it is the universal fallback throughout the
protocol and the only codec stream policy refuses to let a host disable.

The failure message changes from naming NVENC to naming what was looked for and what was
found, because on a machine with no supported GPU this is the message a user will paste
into an issue.

### Per-backend self-test

`--self-test-codec <codec>` becomes `--self-test-codec <backend> <codec>`, running the
existing short encode against a named backend. The `hardware` test tier runs it for every
backend the probe reports, skipping those the machine does not have.

The worker runs the same self-test at startup for each candidate backend before
advertising it, and drops any that cannot complete a real encode. A found element factory
is not evidence that the hardware, driver and element agree — particularly on Media
Foundation, where a registered element may front a transform that refuses the caps, and
particularly on backends nobody here can test. Availability means a passed encode.

The cost is a short encode per backend at startup, on a path that already pays for a
probe. If that proves too slow in practice the result is cacheable against the driver
version, but it is not cached in the first version: a cache that goes stale silently would
undo the guarantee it exists to provide.

### Mid-session failure

Backend selection is made once, when a stream starts, and never changes mid-session.
A pipeline that fails after a stream is running is handled by the existing recovery path
and is not special-cased here. Changing encoders under a live WebRTC session would mean
renegotiating codec parameters to a client that has no reason to expect it.

## Packaging

`packaging/windows/inputs.json` adds `gstqsv.dll`, `gstamfcodec.dll` and
`gstmediafoundation.dll` to the plugin list, with their component entries, licences and
any new dependency DLLs those plugins pull in. The existing PE dependency walker in
`packaging/shared/pe-dependencies.mjs` finds the transitive DLLs; the licence metadata is
manual, as it is for every existing component.

All three plugins ship on every machine regardless of its hardware, because the packages
are built once and installed anywhere. The elements inside them register only where the
hardware supports them, so an NVIDIA-only machine simply sees no QSV or AMF elements.

This grows both packages. If the increase is material, the numbers belong in
`docs/PACKAGING.md` rather than being a reason to ship per-vendor packages, which would
multiply the build matrix and the support burden for a download-size saving.

## CLI, host app and web client

- **CLI:** the encoder backend joins the settings commands as a stream policy field, with
  the same validation and conflict advice as the other policy values. `diagnostics` gains
  the chosen backend, the chosen element, and the reason — adapter match, fixed order, or
  forced by setting.
- **Host app:** the Codecs page gains the backend selector. It lists the backends the
  probe reported, names the automatic choice, and shows which codecs each backend can
  actually encode on this machine. A backend the machine does not have is not offered.
  Where a forced backend was substituted, the page says so.
- **Web client:** unchanged. Clients choose codecs and profiles; the encoder backend is
  never visible to them and never appears in the protocol.

Labelling matters, but it applies to one backend rather than three. NVENC, AMF and Media
Foundation are all exercised on the development machine; Quick Sync is not, because there
is no Intel graphics to run it on. The host app and README should mark Quick Sync as
untested against real hardware and leave the other three unqualified. Presenting all four
as equal would overstate Quick Sync; marking all three new ones as untested would now
understate AMF and Media Foundation, which is its own kind of inaccuracy.

## Testing and validation

### Automated, no GPU

- The backend lookup: every backend and codec pair resolves to an element name or to
  nothing, and the pairs known to be absent — Media Foundation and AV1 — return nothing.
- Normalised QP floors: a floor scaled onto a declared range reproduces the measured NVENC
  values when the range is NVENC's, and stays inside bounds at range extremes, including
  a range maximum of zero and a single-value range.
- Dialect completeness: every backend declares each property the rate-control intent can
  ask for, or explicitly declares it absent. A backend missing an entry is a test failure,
  not a silent skip at runtime.
- Media Foundation's single-QP-floor path: the I-frame floor is applied and the P-frame
  floor dropped.
- Stream policy: `encoderBackend` validation, the fill-in of a missing field with `auto`,
  rejection of unknown values, and that the exact-key-set check includes it.
- `selectVideoCodec` against probe-reported minimums: a codec is rejected when no
  available backend can encode the resolved size, and accepted when one can, including
  the case where the NVENC floor would have rejected it but QSV's does not.
- Probe parsing: a probe response with several backends, with one backend, and a response
  without the `backends` field at all.

### On the development machine, with a GPU

- The existing NVENC self-tests for all three codecs, in CBR and VBR, must produce encoder
  property strings equivalent to those the current code emits. This is the regression that
  matters most: the refactor must not change NVENC behaviour, and NVENC is the only
  backend where that can be proved.
- The VBR measurements from the variable-bitrate investigation are re-run for H.264 to
  confirm the normalised-floor arithmetic reproduces the previous bitrates.
- The probe reports NVENC, AMF and Media Foundation as available and Quick Sync as absent.
- Forcing an unavailable backend falls back to automatic and reports the substitution.

### AMF and Media Foundation, on the development machine

These are verifiable here and must actually be verified rather than reasoned about:

- The per-backend self-test passes for every codec each backend claims: AMF for H.264,
  H.265 and AV1 if the integrated GPU is RDNA3 or newer, and Media Foundation for H.264
  and H.265. Whichever codecs the self-test rejects are dropped from the advertised set,
  and that dropping is itself the behaviour under test.
- The property strings built by introspection are inspected once per backend and recorded,
  because this is the only chance to see what the dialects actually produce. In particular,
  confirm Media Foundation's `pcvbr` path and its single `min-qp`, and confirm AMF accepts
  `usage=ultra-low-latency` together with `preset=speed`.
- Adapter affinity is exercised for real. With two adapters present, capture on the monitor
  driven by the integrated GPU must select AMF over NVENC, and forcing `nvenc` must
  override that. This is the feature's only genuine test.
- A short interactive session runs end to end on AMF, since a passing self-test proves the
  encoder accepts caps, not that the stream is usable.

### What cannot be verified here

Quick Sync alone. There is no Intel graphics on the development machine, so `qsvh264enc`
does not register and nothing about that backend can be exercised. The self-test gate is
what stands in for verification: a backend that does not work is not advertised, so the
worst realistic outcome on an Intel machine is that VidVNC behaves as it does today and
declines to stream, rather than starting a session that fails later.

Before Quick Sync is promoted from untested to supported it needs the same treatment the
others had: a real Intel machine, the self-tests across all codecs in both bitrate modes,
and the VBR bitrate measurements that produced the current floors. Its latency is the
specific thing to measure, because it is the one backend with no low-latency property.

## Risks

- **Quick Sync ships unrun.** Mitigated by introspection, the self-test gate and honest
  labelling, not eliminated. The first external bug reports are likely to be Quick Sync
  latency, since it is the one backend with no low-latency property and its latency rests
  entirely on CBR, no B-frames, one reference frame and a short GOP.
- **QP floor scaling is arithmetic over a range that is verified for three backends and
  not for Quick Sync.** Bounded either way: `max-bitrate` still caps the stream, so a
  wrong floor costs efficiency rather than breaching a budget. Worth an explicit note in
  the host app that VBR quality tiers are calibrated on NVENC.
- **Adapter affinity changes behaviour on existing hybrid machines**, which would now
  prefer an integrated encoder where they previously used NVENC — including the
  development machine itself. This is intended and should be faster, but it is a
  behaviour change for users who are working today, and the override exists partly for
  them. It also means the development machine's own behaviour changes during this work,
  so a regression there is a signal, not noise.
- **Media Foundation may front the same hardware as a vendor backend** with less control,
  which is why it ranks last. Where it is chosen, it is because nothing better was found.
- **Package size grows** for all users, including NVIDIA-only ones who gain nothing.
  Accepted: a single package that runs everywhere is worth more than a smaller one that
  needs the user to pick correctly.
