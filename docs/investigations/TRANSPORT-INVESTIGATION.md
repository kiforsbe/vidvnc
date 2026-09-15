# iPhone transport investigation

## 2026-09-12: recovery-path defect and burst instrumentation

Keep the selected resolution, video bitrate, frame rate and Opus configuration unchanged. No further quality reductions in this investigation.

Confirmed in code and a failing real Chromium offer/answer test: the client restricted codec preferences to H.264, excluding RTX. The server did not explicitly enable transceiver `do-nack`. The client now retains H.264 plus RTX capabilities, and the server enables NACK on new transceivers. The same offer/answer test passes after the change. This confirms repair negotiation, not yet successful iPhone loss recovery.

Added bounded, metadata-only probes at video RTP output and ICE sink input, including buffer lists. Rolling 1 ms and 10 ms byte peaks reset each reporting interval. No media payloads or SDP are logged. Added rtprtxsend request/sent counters and maximum queue byte/time occupancy sampled once per second. The performance page shows these alongside browser NACK and interval packet loss, plus the actual selected profile and audio targets.

Local Chromium runs with the iPhone 720p profile decoded about 15 fps with audio off and on. ICE-input 1 ms peaks in two samples were 51,002 and 60,500 bytes. One RTX sender was present; zero RTX requests occurred on the loss-free local path. These measurements are before the network sink, not NIC transmission measurements. Queue sampling can miss transient buildup and does not inspect OS socket buffers. Chromium is not a substitute for iOS Safari testing.

## 2026-09-12: RTX SSRC 0 track dissociation defect and resolution

When RTX negotiation was added, `webrtcbin` inspected the unbuffered RTP payloader during SDP answer creation. Because `rtph264pay` defaults its SSRC dynamically upon the first pushed buffer, `webrtcbin` saw SSRC 0, emitting `a=ssrc-group:FID 0 <rtx-ssrc>` with MSID attached only to the RTX repair SSRC. When the payloader subsequently assigned an arbitrary random SSRC on the wire, the browser WebRTC engine received and decoded packets at the RTP layer (`framesDecoded` advanced), but never routed frames to the `MediaStreamTrack` associated with the video element. As a result, the `<video>` element remained stalled at `videoWidth = 0`, `videoHeight = 0`, and `readyState = 0` (`HAVE_NOTHING`).

Explicitly configuring `ssrc=10000001` on `rtph264pay` alongside a matching `application/x-rtp,media=video,encoding-name=H264,ssrc=(uint)10000001` capsfilter ensures `webrtcbin` emits the primary video SSRC and MSID properly mapped in the SDP answer. Browser validation confirms immediate transition to `readyState = 4` (`HAVE_ENOUGH_DATA`), full video resolution rendering, and passing browser media checks.

## Next controlled test

1. Connect iPhone 12 Pro with `iphone-720p-test`, audio on; keep all quality settings fixed. Run the same moving video for at least two minutes.
2. Inspect profile, video/ICE burst peaks, browser interval loss/NACK, RTX requests/packets, complete-frame FPS, and sampled queue occupancy. Metrics are saved to `diagnostics/metrics.ndjson`.
3. NACK growth without sender RTX requests suggests negotiation/feedback routing; requests without sent RTX suggests cache/mapping issues. Sent RTX with continued incomplete frames calls for return-path, timing and packet-level investigation. Counters need not match one-for-one.
4. If stalls persist and burst correlation holds, test a separate sender-pacing configuration with identical encoding parameters. Do not combine pacing, cache and quality changes. On-wire capture may be needed to locate loss beyond the ICE probe.

References: [GStreamer retransmission design](https://gstreamer.freedesktop.org/documentation/additional/design/rtp.html), [rtprtxsend counters](https://gstreamer.freedesktop.org/documentation/rtpmanager/rtprtxsend.html), [webrtcbin](https://gstreamer.freedesktop.org/documentation/webrtc/), [GStreamer guidance on do-nack](https://discourse.gstreamer.org/t/how-webrtcbin-support-qos-methods-just-like-pli-and-fir-and-nack/290).

## Lifecycle work

Server stop/disconnect now waits for worker closure, repeated stop shares the same completion promise, and a deadline forcibly stops an unresponsive worker. Native stdin EOF triggers orderly shutdown with a self-termination deadline. Local streaming disconnect tests and native worker lifecycle tests pass. No leftover media worker was found in process checks; full OS-crash/driver-hang coverage remains unverified.
