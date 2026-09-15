# iOS compatibility experiment

The reported iPhone 12 Pro runs iOS 27 beta 6. Previous samples showed video
and audio packet loss, with decoded video stopping. This does not establish a
hardware decoder overload: incomplete RTP frames can prevent decoding even
while bytes continue arriving. The cause of that loss remains unconfirmed.

Mobile and low-bandwidth profiles now use H.264 constrained baseline Level
3.1, no B frames, one-second GOP, and RTP aggregation disabled. Desktop retains
automatic level selection and zero-latency aggregation. All profiles repeat
sequence headers, and the payloader inserts SPS/PPS with each IDR.

Native metrics expose encoder force-key-unit events, encoded keyframes and
actual SPS profile/level. Browser diagnostics expose complete frames per second,
decoded keyframes, PLI/FIR counts, and video-element paused/ready state.
Normal upstream keyframe events continue to reach the encoder. An authenticated
telemetry fallback requests a keyframe on a new PLI/FIR, at most once per three
seconds; native commands have an additional two-second limit. NACKs alone do
not trigger this fallback. A keyframe can itself create a traffic burst, so
this is a bounded recovery experiment, not a packet-loss fix.

## Device comparison

With the stable baseline, the user observed 15 fps, zero video
packet loss, and unchanged cumulative freeze counts with quarter-screen and
near-fullscreen YouTube content, with audio enabled.

**Picture quality → iPhone 720p test** selects `iphone-720p-test`: 1280×720,
15 fps, 1000 kbit/s, 1200-byte MTU, H.264 constrained baseline Level 3.1,
aggregation none, the same GOP/recovery and 32 kbit/s mono Opus. Resolution
is the only difference from `low-bandwidth`. At the user's request, Auto now
selects the 720p experiment on iPhone. Select 540p and reconnect if it regresses;
there is no automatic mid-session quality downgrade yet. The older `mobile` profile is different (2000 kbit/s),
so use the new test profile for the controlled comparison.

Refresh the client. Connect with **Include desktop audio** unchecked; play the
same server-side content for at least a minute. Disconnect, then reconnect with
it checked. This disables the audio capture/track when unchecked; muting the
toolbar only silences playback and does not remove network traffic.

Compare completeFrameFps with decodeFps, keyframes and interval packet loss.
If complete frames stop too, investigate packet delivery/reassembly/recovery.
If complete frames keep increasing while decoding stops, investigate decoder
input/codec state. If decoding advances while the displayed video freezes,
investigate playback/rendering. Counters unsupported by Safari remain unknown.

## Verification

Native mobile self-test captures 60 real NVIDIA-encoded frames, verifies SPS
profile 66 and level 31, and requires an extra keyframe after a forced request.
34 automated tests pass. The opt-in browser-media-check.mjs test passes for
audio-off and audio-on, decoding approximately 15 fps locally and receiving
Opus packets. It uses Chromium with an iPhone user-agent for profile routing;
it is not evidence of iOS/Safari or Wi-Fi stability. An initial browser run timed
out during negotiation; the repeat passed both modes. iPhone validation remains
necessary.

References: [GStreamer keyframe events](https://gstreamer.freedesktop.org/documentation/video/video-event.html),
[H.264 RTP payloader](https://gstreamer.freedesktop.org/documentation/rtp/rtph264pay.html).
The documented default WebRTC recommendation is zero-latency aggregation;
disabling it here is a compatibility experiment, not a known Safari fix.
