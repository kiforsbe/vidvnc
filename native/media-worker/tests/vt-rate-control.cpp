#include <cassert>
#include "../src/platform/macos/vt-rate-control.hpp"

// The intents encoder-properties.cpp checks NVENC against: 30 fps at 6000 kbit/s, CBR and
// balanced VBR, H.264 and H.265.
static StreamProfile profile(BitrateMode mode, Quality quality = Quality::Balanced) {
    StreamProfile result;
    result.fps = 30;
    result.bitrate = 6000;
    result.bitrate_mode = mode;
    result.quality = quality;
    return result;
}

int main() {
    // CBR: the target as both the average and the one-second limit, a key frame every second,
    // no quality floor.
    const auto cbr = vt_rate_settings(rate_control("h264", profile(BitrateMode::Cbr)), 30);
    assert(cbr.average_bits_per_second == 6000000);
    assert(cbr.limit_bytes == 750000 && cbr.limit_seconds == 1.0);
    assert(cbr.max_keyframe_interval == 30 && cbr.max_keyframe_interval_seconds == 1.0);
    assert(cbr.min_qp == -1);
    assert(cbr.expected_fps == 30);

    // VBR: the same average, peaks to twice it, a ten-second GOP, and the I-frame floor for
    // every frame (VideoToolbox has a single floor, like Media Foundation).
    const auto vbr = vt_rate_settings(rate_control("h264", profile(BitrateMode::Vbr)), 30);
    assert(vbr.average_bits_per_second == 6000000);
    assert(vbr.limit_bytes == 1500000 && vbr.limit_seconds == 1.0);
    assert(vbr.max_keyframe_interval == 300 && vbr.max_keyframe_interval_seconds == 10.0);
    assert(vbr.min_qp == 24);

    // The floors keep their order across the quality tiers, on the 0 to 51 scale.
    assert(vt_rate_settings(rate_control("h264", profile(BitrateMode::Vbr, Quality::Efficient)), 30)
               .min_qp == 30);
    assert(vt_rate_settings(rate_control("h264", profile(BitrateMode::Vbr, Quality::High)), 30)
               .min_qp == 20);

    // H.265 uses the same scale and the same settings.
    const auto hevc = vt_rate_settings(rate_control("h265", profile(BitrateMode::Vbr)), 30);
    assert(hevc.average_bits_per_second == vbr.average_bits_per_second);
    assert(hevc.limit_bytes == vbr.limit_bytes && hevc.min_qp == vbr.min_qp);

    // The GOP's duration follows the frame rate.
    auto slow = profile(BitrateMode::Cbr);
    slow.fps = 15;
    const auto fifteen = vt_rate_settings(rate_control("h264", slow), 15);
    assert(fifteen.max_keyframe_interval == 15 && fifteen.max_keyframe_interval_seconds == 1.0);
}
