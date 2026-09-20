# Variable frame rate and variable bitrate investigation

## 2026-09-20: feasibility and encoder measurements

Question: can VidVNC support variable frame rate (VFR) and variable bitrate (VBR), and is it worth doing? The stream today is fixed on every axis. Capture is capped to `framerate=<fps>/1`, and the encoder runs `rc-mode=cbr bitrate=<N> gop-size=<fps> bframes=0` (`pipeline_description` in `native/media-worker/src/media-worker.cpp`). Profiles carry one fixed `fps` and one fixed `bitrateKbps`.

Scope: "variable" can mean content-driven (spend less when the screen is idle, up to a host cap) or network-driven (change fps or bitrate mid-session). This investigation covers content-driven behaviour. It only checks whether live reconfiguration is possible, because network-driven adaptation belongs to the adaptive Automatic quality milestone in the [roadmap](../ROADMAP.md).

### Summary

- Variable bitrate is worth implementing, but `rc-mode=vbr` alone gives almost nothing. The saving comes from three settings together: a quality floor (`qp-min-*`), a peak ceiling (`max-bitrate`) and a longer GOP.
- With those, bitrate falls by about 93% on a static screen, 89% with idle-then-burst activity and 78% while scrolling, compared with the shipped CBR configuration.
- Variable frame rate is much less valuable. The current DXGI capture always paces at a fixed rate, and re-encoding an unchanged frame costs under 1 KB. The change-driven Windows Graphics Capture (WGC) mode emits nothing on a static screen, which breaks keyframe requests unless a keepalive is added.
- Recommendation: implement VBR with a quality floor and longer GOP first. Defer VFR until GPU and decode power measurements justify it.

### Method

Windows 11 (build 26200), NVIDIA GeForce RTX 5060 Ti, driver 610.88, the GStreamer runtime in `.deps/gstreamer`. Each run used the worker's pipeline: `d3d11screencapturesrc` to `d3d11convert` to NV12 at 2560x1440, 30 fps, then `nvd3d11h264enc preset=p3 tune=ultra-low-latency bframes=0 zerolatency=true repeat-sequence-header=true` with the varied properties, constrained-baseline H.264 caps, `h264parse` and `filesink`.

Each run ended by construction with `num-buffers` on the source (450 buffers, about 15 s, except where noted). Bitrate is output bytes divided by wall-clock time from `gst-launch-1.0`, so it includes the initial keyframe. Frame sizes came from `identity silent=false` output over 300 buffers.

The real desktop is not a repeatable input, so a fullscreen Edge kiosk page in a throwaway profile supplied controlled content:

- `static`: a dense, unchanging wall of code-like text.
- `scroll`: the same text scrolling at 90 px/s.
- `video`: a 1280x720 animated plasma canvas over the static text.
- `burst`: static for 3.5 s, then scrolling for 1.5 s, repeating every 5 s.

The harness scripts and page were throwaway and are not committed.

### Rate control results

Bitrate in kbit/s. All runs delivered 30.0 to 30.2 fps.

| Configuration | Static | Burst | Scroll | Video |
| --- | ---: | ---: | ---: | ---: |
| CBR 6000, GOP 30 (shipped) | 4772 | 5377 | 5960 | 6056 |
| VBR 3000, max 6000, GOP 30 | 2472 | 3059 | 3328 | 3208 |
| VBR 6000, max 12000, GOP 30 | 5546 | 6547 | 6893 | 6775 |
| VBR 6000, max 12000, `qp-min-i=24 qp-min-p=28`, GOP 30 | 2559 | 2748 | 3424 | 5994 |
| VBR 6000, max 12000, `qp-min-i=30 qp-min-p=34`, GOP 30 | 1760 | 1874 | 2202 | 4047 |
| Constant QP (`qp-const-i=24 qp-const-p=28`), GOP 30 | 2581 | 2825 | 3386 | 6069 |
| CBR 6000, GOP 300 | 5451 | 6620 | 7113 | not run |
| VBR 6000, max 12000, `qp-min-i=24 qp-min-p=28`, GOP 300 | **328** | **568** | **1327** | not run |
| Constant QP 24/28, GOP 300 | 349 | 627 | 1497 | not run |
| Constant QP 24/28, infinite GOP | 176 | 517 | 1370 | not run |

Findings:

- CBR spends 5 to 7 Mbit/s whatever the content, including a fully static page. Raising the GOP does not help it.
- Plain VBR also spends close to its average target on a static screen. At these low-latency settings the encoder refines quality to use the budget.
- With `gop-size=fps`, the periodic full-frame keyframe dominates the cost of idle content. Constant QP costs 2.6 Mbit/s static and 3.4 Mbit/s scrolling at GOP 30, but 0.35 and 1.5 Mbit/s at GOP 300.
- The quality floor is what makes VBR content-driven. On video-like content the VBR floor configuration reaches the same rate as CBR (5994 against 6056), and `max-bitrate` bounds it.

### Frame sizes (scroll content, 300 frames)

| Configuration | Keyframes | Largest keyframe | P-frame median | P-frame 95th percentile | Largest P-frame |
| --- | ---: | ---: | ---: | ---: | ---: |
| CBR 6000, GOP 30 | 10 | 288 KB | 13.7 KB | 31.5 KB | 47.4 KB |
| VBR floor 24/28, max 12000, GOP 300 | 1 | 274 KB | 4.9 KB | 5.7 KB | 8.9 KB |
| Same, `vbv-buffer-size=4000` | 1 | 266 KB | 4.9 KB | 5.7 KB | 7.9 KB |
| Same, `vbv-buffer-size=1000` | 1 | 113 KB | 5.0 KB | 6.6 KB | 23.0 KB |

CBR already sends keyframes of about 288 KB, so VBR does not create a new keyframe-burst risk. It sends them far less often. A small VBV buffer bounds keyframe size at the cost of a coarser keyframe followed by a larger refinement P-frame.

### Capture pacing results

- DXGI capture (the default) paces at the requested rate even when nothing changes and re-emits the previous frame: 300 buffers took 9.97 s on the static page.
- `framerate=0/1` in the caps does not make DXGI change-driven. The source free-runs at about 55,000 buffers per second, repeating the frame.
- WGC (`capture-api=wgc`) is change-driven. Time for 30 buffers: static page did not finish within 15 s, burst page 2.53 s (DXGI 0.97 s), scroll page 0.97 s.
- A static screen therefore yields no frames under WGC. The encoder cannot produce a keyframe without an input frame, so a joining client or a keyframe request after loss would stall until the screen changes. A VFR design on WGC needs a keepalive that re-sends the last frame after a gap. This was not tested; `videorate` is reactive to incoming buffers and probably does not provide it.
- On DXGI, an unchanged frame encodes to about 0.7 KB (infinite GOP, static page). Once VBR and a longer GOP are in place, VFR saves little bandwidth. Its remaining value is lower GPU encode and client decode power.

### Live reconfiguration

`gst-inspect-1.0` marks `bitrate`, `max-bitrate`, `rc-mode`, `qp-{min,max,const}-{i,p,b}`, `vbv-buffer-size` and `gop-size` as changeable in the PLAYING state on `nvd3d11h264enc`, `nvd3d11h265enc` and `nvd3d11av1enc` (`vbv-buffer-size` is marked conditionally available). This is the hook for adaptive Automatic quality. Changing them mid-stream was not exercised, so which changes force an encoder reset is unknown.

### Not verified

- Only H.264 was measured. H.265 and AV1 expose the same properties, but their QP scales differ, so the floor values need their own tuning.
- Each cell is one run on one GPU with synthetic content. The video-like mode was not run with a long GOP.
- Nothing was tested in a browser or on an iPhone: jitter buffer behaviour, freeze detection, decode of a long GOP, or audio sync.
- Loss recovery with a long GOP has not been tested. With `gop-size=fps` a lost packet heals within about a second without any request. With a long GOP it heals only through a keyframe request, and `KeyframeLimiter::recovery` limits those to one every 2 s.

### Code touchpoints for an implementation

- `native/media-worker/src/stream-profile.hpp`: `parse_stream_profile` requires exactly five keys and validates each range.
- `native/media-worker/src/media-worker.cpp`: hard-coded `rc-mode=cbr` and `gop-size` at `pipeline_description`; the early keyframe in `count_frame` for 15 fps.
- `apps/server/src/stream-policy.mjs` and `profiles.mjs`: profile and approved-option validation, all fixed values.
- `apps/server/src/stream-registry.mjs`: admission budgets sum `bitrateKbps` and `width x height x fps`, so a variable stream would need a ceiling to budget against.
- `apps/server/src/native-media.mjs`: profile passed to the worker.
- CLI, the Windows host app and the web client: settings, formatting, and labels that present targets.
- `fps === 15` is used as a proxy for the mobile profile in several places (audio mix, H.264 level 3.1, RTP aggregate mode, early keyframe). Any change to frame rate semantics has to account for it.

### Recommended next steps

1. Design VBR as a quality target plus a ceiling: `bitrateKbps` becomes the ceiling and budgeting continues to use it. Keep CBR available for constrained mobile profiles.
2. Choose the GOP policy together with the recovery path, then test loss recovery on a real iPhone before shipping a long GOP.
3. Repeat the measurements for H.265 and AV1 and tune the QP floor per codec.
4. Measure GPU and decode power on an idle stream before deciding whether VFR on WGC, with a keepalive, is worth building.
5. Test changing bitrate and QP limits while a stream is running, as input to adaptive Automatic quality.
