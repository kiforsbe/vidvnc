#pragma once
// MG2 prototype only (throwaway): ScreenCaptureKit capture of the main display into a
// VTCompressionSession, producing Annex B access units (D1 in the macOS design).
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

struct ScreenEncoderSettings {
    int width = 1920, height = 1080, fps = 60;
    int bitrate_kbps = 20000, max_bitrate_kbps = 0; // max 0: CBR
    int gop_frames = 60;
    bool hevc = false;
};

class ScreenEncoder {
  public:
    // `unit` runs on an encoder thread for each access unit: Annex B bytes, keyframe flag.
    using Unit = std::function<void(const std::uint8_t *data, std::size_t size, bool keyframe)>;
    using Failure = std::function<void(const std::string &message)>;
    static std::unique_ptr<ScreenEncoder> create();
    virtual ~ScreenEncoder() = default;
    virtual void start(const ScreenEncoderSettings &settings, Unit unit, Failure failure) = 0;
    virtual void request_keyframe() = 0;
    virtual void stop() = 0;
    // Counters and latency percentiles since the last call, as a JSON object.
    virtual std::string take_stats() = 0;
};

// MG3: asks ScreenCaptureKit for the shareable displays once; "ok <n> displays" or the error.
std::string screen_capture_probe();

// MG8: create a hardware VTCompressionSession for H.264 or HEVC and encode 10 synthetic NV12
// frames; "ok <n> frames" or the error.
std::string vt_probe(bool hevc);
