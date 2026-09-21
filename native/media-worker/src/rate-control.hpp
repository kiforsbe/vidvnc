#pragma once
#include <array>
#include <stdexcept>
#include <string>
#include "stream-profile.hpp"
#include "video-codec.hpp"

// Rate-control intent for one stream, independent of any encoder family. CBR is the fixed-rate
// mode the worker has always used. VBR treats `bitrate` as the sustained cap, allows peaks of
// twice that, and sets quality floors so quiet content is not padded up to the cap.
//
// This describes what to ask for, not how to spell it. Turning intent into properties for a
// particular element is `encoder-properties.hpp`, because the four encoder families disagree on
// every property name involved.
enum class RateMode { Cbr, Vbr };

struct RateControl {
    RateMode mode;
    int bitrate_kbps;
    int max_bitrate_kbps; // 0 under CBR.
    int gop_frames;       // Keyframe interval in frames.
    // Quality floors as a fraction of the target element's QP range, or -1 when not requested.
    // They are fractions rather than numbers because the families do not share a QP scale, and
    // the ranges for Quick Sync and AMF AV1 encoding are not documented. The real range is read
    // from the element at runtime.
    double qp_floor_i;
    double qp_floor_p;
};

// The scale each measured value below was expressed on. H.264 and H.265 use 0 to 51; AV1 uses
// the 0 to 255 quantiser index from the AV1 specification.
inline int qp_reference_maximum(const std::string &codec_id) {
    return codec_id == "av1" ? 255 : 51;
}

// Lowest QP the encoder may use for I and P frames. H.264, H.265 and AV1 use different QP
// scales. The values below were measured on an RTX 5060 Ti at 2560x1440, 30 fps, 6000 kbit/s
// (see docs/investigations/VARIABLE-RATE-INVESTIGATION.md, 2026-09-20 results). At those
// settings the bitrate was strictly ordered efficient < balanced < high on scroll and video
// content, static content stayed under 20% of CBR, and no codec exceeded the cap.
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
    if (profile.bitrate_mode == BitrateMode::Cbr)
        return {RateMode::Cbr, profile.bitrate, 0, profile.fps, -1.0, -1.0};
    const auto floors = qp_floors(codec_id, profile.quality);
    const auto maximum = static_cast<double>(qp_reference_maximum(codec_id));
    // Do not round here. Rounding once, onto the real element's range, is what keeps the
    // round-trip onto the reference range exact.
    return {RateMode::Vbr,    profile.bitrate,    profile.bitrate * 2,
            profile.fps * 10, floors.i / maximum, floors.p / maximum};
}
