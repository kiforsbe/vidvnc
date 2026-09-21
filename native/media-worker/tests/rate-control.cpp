#include <cassert>
#include <cmath>
#include <stdexcept>
#include <string>
#include "../src/rate-control.hpp"

// Rescale a normalised floor the way the property builder does, so this test proves the
// fractions still mean the values measured on the RTX 5060 Ti.
static int rescale(double normalised, int maximum) {
    return static_cast<int>(std::llround(normalised * maximum));
}

static void check_floors(const char *codec, Quality quality, int expected_i, int expected_p) {
    StreamProfile profile;
    profile.fps = 30;
    profile.bitrate = 6000;
    profile.bitrate_mode = BitrateMode::Vbr;
    profile.quality = quality;
    const auto intent = rate_control(codec, profile);
    const int maximum = qp_reference_maximum(codec);
    assert(rescale(intent.qp_floor_i, maximum) == expected_i);
    assert(rescale(intent.qp_floor_p, maximum) == expected_p);
}

int main() {
    // The reference scales the measured values were expressed on.
    assert(qp_reference_maximum("h264") == 51);
    assert(qp_reference_maximum("h265") == 51);
    assert(qp_reference_maximum("av1") == 255);

    // Round-trip: every measured floor must come back exactly. See
    // docs/investigations/VARIABLE-RATE-INVESTIGATION.md for where these came from.
    for (const char *codec : {"h264", "h265"}) {
        check_floors(codec, Quality::Efficient, 30, 34);
        check_floors(codec, Quality::Balanced, 24, 28);
        check_floors(codec, Quality::High, 20, 24);
    }
    check_floors("av1", Quality::Efficient, 150, 170);
    check_floors("av1", Quality::Balanced, 120, 140);
    check_floors("av1", Quality::High, 100, 120);

    StreamProfile profile;
    profile.fps = 30;
    profile.bitrate = 6000;
    profile.bitrate_mode = BitrateMode::Cbr;

    // CBR is today's behaviour and ignores quality. No peak, no floors.
    auto cbr = rate_control("h264", profile);
    assert(cbr.mode == RateMode::Cbr);
    assert(cbr.bitrate_kbps == 6000);
    assert(cbr.max_bitrate_kbps == 0);
    assert(cbr.gop_frames == 30);
    assert(cbr.qp_floor_i < 0 && cbr.qp_floor_p < 0);
    profile.quality = Quality::High;
    assert(rate_control("h264", profile).gop_frames == cbr.gop_frames);
    assert(rate_control("h264", profile).qp_floor_i < 0);

    // VBR caps the sustained rate and allows twice it as a peak, over a ten second GOP.
    profile.bitrate_mode = BitrateMode::Vbr;
    profile.quality = Quality::Balanced;
    auto vbr = rate_control("h264", profile);
    assert(vbr.mode == RateMode::Vbr);
    assert(vbr.bitrate_kbps == 6000);
    assert(vbr.max_bitrate_kbps == 12000);
    assert(vbr.gop_frames == 300);
    assert(vbr.qp_floor_i > 0.0 && vbr.qp_floor_i <= 1.0);
    assert(vbr.qp_floor_p > vbr.qp_floor_i);

    // The GOP follows the frame rate.
    profile.fps = 15;
    assert(rate_control("h264", profile).gop_frames == 150);

    bool threw = false;
    try {
        rate_control("vp9", profile);
    } catch (const std::invalid_argument &) {
        threw = true;
    }
    assert(threw);
}
