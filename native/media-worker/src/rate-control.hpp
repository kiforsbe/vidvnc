#pragma once
#include <array>
#include <stdexcept>
#include <string>
#include "stream-profile.hpp"
#include "video-codec.hpp"

// NVENC rate-control properties and GOP length for one stream. CBR is the fixed-rate mode the
// worker has always used. VBR treats `bitrate` as the sustained cap, allows peaks of twice that,
// and sets QP floors so quiet content is not padded up to the cap.
struct RateControl {
    std::string properties; // Encoder properties, no leading or trailing space.
    int gop_frames;         // Keyframe interval in frames (the gop-size value).
};

// Lowest QP the encoder may use for I and P frames. H.264, H.265 and AV1 use different QP scales.
// The values below were measured on an RTX 5060 Ti at 2560x1440, 30 fps, 6000 kbit/s (see
// docs/investigations/VARIABLE-RATE-INVESTIGATION.md, 2026-09-20 results). At those settings the
// bitrate was strictly ordered efficient < balanced < high on scroll and video content, static
// content stayed under 20% of CBR, and no codec exceeded the cap.
struct QpFloors {
    int i;
    int p;
};

inline QpFloors qp_floors(const std::string &codec_id, Quality quality) {
    static const std::array<QpFloors, 3> avc_hevc{{{30, 34}, {24, 28}, {20, 24}}};
    static const std::array<QpFloors, 3> av1{{{150, 170}, {120, 140}, {100, 120}}};
    const auto &table = codec_id == "av1" ? av1 : avc_hevc;
    return table[static_cast<size_t>(quality)];
}

inline RateControl rate_control(const std::string &codec_id, const StreamProfile &profile) {
    if (!find_video_codec(codec_id))
        throw std::invalid_argument("unknown video codec: " + codec_id);
    const std::string bitrate = std::to_string(profile.bitrate);
    if (profile.bitrate_mode == BitrateMode::Cbr)
        return {"rc-mode=cbr bitrate=" + bitrate + " gop-size=" + std::to_string(profile.fps),
                profile.fps};
    const auto floors = qp_floors(codec_id, profile.quality);
    const int gop_frames = profile.fps * 10;
    return {"rc-mode=vbr bitrate=" + bitrate + " max-bitrate=" +
                std::to_string(profile.bitrate * 2) + " qp-min-i=" + std::to_string(floors.i) +
                " qp-min-p=" + std::to_string(floors.p) + " gop-size=" + std::to_string(gop_frames),
            gop_frames};
}
