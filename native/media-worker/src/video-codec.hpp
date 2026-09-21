#pragma once
#include <array>
#include <string>

// A row of this table describes a bitstream and how it is carried: the caps after the encoder,
// the payloader branch of `add_peer`, and the SDP payload matched by `select_payloads`. It is
// identical whichever chip produced the bitstream, so the encoder element and its properties
// live in `encoder-backend.hpp` instead. Bitrate, resolution, frame rate and host budgets are
// unchanged by the codec.
struct VideoCodec {
    std::string id;              // Protocol/CLI identifier: "h264", "h265", "av1".
    std::string label;           // Display name: "H.264", "H.265", "AV1".
    std::string caps;            // Caps string placed after the encoder (no H.264 level suffix).
    std::string parser;          // Parser element, plus properties.
    std::string payloader;       // GStreamer payloader factory name.
    std::string payloader_extra; // Fixed payloader properties (H.264's aggregate-mode is added
                                 // by add_peer, since it depends on the stream profile).
    std::string encoding_name;   // RTP encoding-name: "H264", "H265", "AV1".
    std::string rtpmap;          // rtpmap value: "H264/90000", "H265/90000", "AV1/90000".
    std::string unsupported;     // peer-failed reason when the browser did not offer this codec.
};

inline const std::array<VideoCodec, 3> &video_codecs() {
    static const std::array<VideoCodec, 3> table{{
        {"h264", "H.264",
         "video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au",
         "h264parse", "rtph264pay", "config-interval=-1", "H264", "H264/90000",
         "Browser must offer constrained-baseline H.264 with packetization-mode=1."},
        {"h265", "H.265", "video/x-h265,profile=main,stream-format=byte-stream,alignment=au",
         "h265parse config-interval=-1", "rtph265pay",
         "config-interval=-1 aggregate-mode=zero-latency", "H265", "H265/90000",
         "Browser must offer H.265."},
        {"av1", "AV1", "video/x-av1,profile=main,stream-format=obu-stream,alignment=tu", "av1parse",
         "rtpav1pay", "", "AV1", "AV1/90000", "Browser must offer AV1."},
    }};
    return table;
}

inline const VideoCodec *find_video_codec(const std::string &id) {
    for (const auto &codec : video_codecs())
        if (codec.id == id)
            return &codec;
    return nullptr;
}
