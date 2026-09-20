#include <cassert>
#include <stdexcept>
#include "../src/rate-control.hpp"
int main() {
    StreamProfile profile;
    profile.fps = 30;
    profile.bitrate = 6000;
    profile.bitrate_mode = BitrateMode::Cbr;
    // CBR is today's behaviour and ignores quality.
    auto cbr = rate_control("h264", profile);
    assert(cbr.properties == "rc-mode=cbr bitrate=6000 gop-size=30");
    assert(cbr.gop_frames == 30);
    profile.quality = Quality::High;
    assert(rate_control("h264", profile).properties == cbr.properties);
    profile.bitrate_mode = BitrateMode::Vbr;
    profile.quality = Quality::Balanced;
    auto vbr = rate_control("h264", profile);
    assert(vbr.properties ==
           "rc-mode=vbr bitrate=6000 max-bitrate=12000 qp-min-i=24 qp-min-p=28 gop-size=300");
    assert(vbr.gop_frames == 300);
    // AV1 uses a different QP scale.
    profile.quality = Quality::High;
    assert(rate_control("av1", profile).properties ==
           "rc-mode=vbr bitrate=6000 max-bitrate=12000 qp-min-i=100 qp-min-p=120 gop-size=300");
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
