#pragma once
// The worker's own GStreamer elements on macOS (design D1). GStreamer has no ScreenCaptureKit
// source, and its `vtenc` does not expose VideoToolbox's low-latency rate control, so the
// worker registers three elements of its own and builds pipelines from them the way the
// Windows layer builds them from d3d11screencapturesrc and the encoder families:
//
//   vidvncscreensrc  one SCStream on one display, NV12 IOSurface frames at the profile's size
//                    and rate, the cursor drawn; a still screen repeats its last frame
//   vidvncvtenc      VTCompressionSession, real time, no reordering, Annex B access units
//   vidvncaudiosrc   ScreenCaptureKit system audio, 48 kHz stereo float, without the audio of
//                    VidVNC's own processes
//
// Frames pass from the source to the encoder as IOSurface-backed CVPixelBuffers attached to
// otherwise empty buffers (caps feature memory:CVPixelBuffer), so raw pixels never reach system
// memory, as on Windows. Nothing else can link to those caps.
#if defined(__OBJC__) && !__has_feature(objc_arc)
#error "The macOS platform layer needs ARC (CMakeLists.txt sets it)."
#endif
#include <CoreVideo/CoreVideo.h>
#include <gst/gst.h>
#include <string>
#include "vt-rate-control.hpp"

namespace macos {

// Registers the three elements once, after gst_init.
void register_elements();

// The frame vidvncscreensrc attached to `buffer`, or null; the buffer keeps its reference.
CVPixelBufferRef frame_pixels(GstBuffer *buffer);
void attach_frame_pixels(GstBuffer *buffer, CVPixelBufferRef pixels);

// Whether VideoToolbox lists a hardware encoder for `codec_id` ("h264", "h265"). Cheap: no
// session is opened.
bool hardware_encoder_listed(const std::string &codec_id);

// Opens a hardware, low-latency session for `codec_id` at `width`x`height` with `settings`, and
// encodes `frames` synthetic frames through it. True only if every frame came back encoded.
// What --probe calls "available".
bool encoder_self_test(const std::string &codec_id, int width, int height,
                       const VtRateSettings &settings, int frames, std::string &error);

} // namespace macos
