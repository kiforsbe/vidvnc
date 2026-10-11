#pragma once
// Rate-control intent (rate-control.hpp) as VideoToolbox settings: the macOS counterpart of
// encoder-properties.hpp, kept free of Apple headers so it is tested like the other tables.
//
// Measured on macOS 27 (M-series, 2026-10-11): with low-latency rate control
// (kVTVideoEncoderSpecification_EnableLowLatencyRateControl), H.264 and HEVC sessions accept
// AverageBitRate, DataRateLimits, MinAllowedFrameQP, MaxKeyFrameInterval,
// MaxKeyFrameIntervalDuration and ExpectedFrameRate, and refuse ConstantBitRate
// (kVTPropertyNotSupportedErr). So CBR is an average with a one-second limit at the same
// rate, and VBR the same average with a limit at the peak.
#include "../../rate-control.hpp"

struct VtRateSettings {
    long average_bits_per_second;
    // DataRateLimits as one pair: at most `limit_bytes` in any `limit_seconds`.
    long limit_bytes;
    double limit_seconds;
    int max_keyframe_interval;            // Frames.
    double max_keyframe_interval_seconds; // The same interval as a duration.
    // MinAllowedFrameQP, or -1 for none. VideoToolbox has one floor for every frame type, so,
    // as for Media Foundation, the I-frame floor applies to all of them.
    int min_qp;
    int expected_fps;
};

// H.264 and HEVC both use the 0 to 51 scale in VideoToolbox.
constexpr int vt_qp_maximum = 51;

inline VtRateSettings vt_rate_settings(const RateControl &intent, int fps) {
    const bool vbr = intent.mode == RateMode::Vbr;
    const long peak_kbps = vbr ? intent.max_bitrate_kbps : intent.bitrate_kbps;
    int min_qp = -1;
    if (vbr && intent.qp_floor_i >= 0) {
        const double scaled = intent.qp_floor_i * vt_qp_maximum + 0.5;
        min_qp = scaled > vt_qp_maximum ? vt_qp_maximum : static_cast<int>(scaled);
    }
    return {static_cast<long>(intent.bitrate_kbps) * 1000,
            peak_kbps * 1000 / 8,
            1.0,
            intent.gop_frames,
            fps > 0 ? static_cast<double>(intent.gop_frames) / fps : 0.0,
            min_qp,
            fps};
}
