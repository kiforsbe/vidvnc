#pragma once
#include <string>
#include <vector>

// One row of this table is a hardware encoder family: which GStreamer element encodes each
// codec, and how that family spells the properties the worker needs. The four families do not
// agree on those spellings, so nothing here may be assumed from another row. Element names and
// property names were taken from the GStreamer 1.28 documentation on 2026-09-21; see
// docs/superpowers/specs/2026-09-21-hardware-encoders-design.md for the comparison table.

struct PropertyValue {
    std::string property;
    std::string value;
};

struct Dimensions {
    int width;
    int height;
};

struct CodecSupport {
    std::string codec_id; // "h264", "h265", "av1".
    std::string element;  // GStreamer encoder factory name.
    Dimensions minimum;   // Smallest input the element accepts.
};

struct EncoderDialect {
    std::string rc_mode_property;     // "rc-mode" or "rate-control".
    std::string cbr_value;            // Enum spelling for constant bitrate.
    std::string vbr_value;            // Enum spelling for variable bitrate.
    std::string bitrate_property;     // Target bitrate, kbit/s on every backend.
    std::string max_bitrate_property; // Peak bitrate, kbit/s.
    std::string gop_property;         // Keyframe interval in frames.
    std::string bframes_property;     // "bframes" or "b-frames".
    // Candidate spellings for the quality floors, best first; the first name the element really
    // declares is the one used. Lists rather than names because AMF disagrees with itself:
    // amfh264enc has a global `min-qp`, amfh265enc has `min-qp-i` and `min-qp-p`, and amfav1enc
    // has no floor property at all. Checked against the installed elements on 2026-09-21.
    std::vector<std::string> qp_floor_i_properties;
    std::vector<std::string> qp_floor_p_properties; // Empty means one floor covers every frame.
    std::string header_repeat_property;             // Empty means the parser handles it.
    std::vector<PropertyValue> low_latency; // Whatever this family needs for lowest latency.
};

struct EncoderBackend {
    std::string id;    // Policy/protocol identifier: "nvenc", "qsv", "amf", "mediafoundation".
    std::string label; // Display name.
    EncoderDialect dialect;
    std::vector<CodecSupport> codecs;
};

inline const std::vector<EncoderBackend> &encoder_backends() {
    // Order is the fixed tie-break applied when no candidate sits on the capture adapter.
    // Media Foundation is last because it fronts whichever transform the system provides and
    // gives the least control over latency.
    static const std::vector<EncoderBackend> table{
        {"nvenc",
         "NVIDIA NVENC",
         {"rc-mode",
          "cbr",
          "vbr",
          "bitrate",
          "max-bitrate",
          "gop-size",
          "bframes",
          {"qp-min-i"},
          {"qp-min-p"},
          "repeat-sequence-header",
          {{"preset", "p3"}, {"tune", "ultra-low-latency"}, {"zerolatency", "true"}}},
         {{"h264", "nvd3d11h264enc", {64, 64}},
          {"h265", "nvd3d11h265enc", {144, 48}},
          {"av1", "nvd3d11av1enc", {192, 128}}}},
        // Quick Sync has no low-latency or target-usage property at all. Its latency comes from
        // a single reference frame, CBR, no B-frames and a short GOP.
        {"qsv",
         "Intel Quick Sync",
         {"rate-control",
          "cbr",
          "vbr",
          "bitrate",
          "max-bitrate",
          "gop-size",
          "b-frames",
          {"min-qp-i"},
          {"min-qp-p"},
          "",
          {{"ref-frames", "1"}}},
         {{"h264", "qsvh264enc", {16, 16}},
          {"h265", "qsvh265enc", {16, 16}},
          {"av1", "qsvav1enc", {16, 16}}}},
        // AMF spells its floors differently per codec, which is why the floor fields are lists:
        // amfh264enc takes a single `min-qp`, amfh265enc takes `min-qp-i`/`min-qp-p`, and
        // amfav1enc takes neither. Emitting a name the element lacks fails the whole pipeline,
        // so the property builder keeps the first name each element actually declares.
        {"amf",
         "AMD AMF",
         {"rate-control",
          "cbr",
          "vbr",
          "bitrate",
          "max-bitrate",
          "gop-size",
          "b-frames",
          {"min-qp-i", "min-qp"},
          {"min-qp-p"},
          "",
          {{"usage", "ultra-low-latency"}, {"preset", "speed"}}},
         {{"h264", "amfh264enc", {128, 128}},
          {"h265", "amfh265enc", {128, 128}},
          {"av1", "amfav1enc", {128, 128}}}},
        // Media Foundation has no plain `vbr`: the variable mode is peak-constrained and driven
        // by max-bitrate. It also has one QP floor rather than one per frame type, so the empty
        // P-floor list tells the property builder to apply the I floor alone.
        {"mediafoundation",
         "Media Foundation",
         {"rc-mode",
          "cbr",
          "pcvbr",
          "bitrate",
          "max-bitrate",
          "gop-size",
          "bframes",
          {"min-qp"},
          {},
          "",
          {{"low-latency", "true"}}},
         {{"h264", "mfh264enc", {64, 64}}, {"h265", "mfh265enc", {64, 64}}}}};
    return table;
}

inline const EncoderBackend *find_encoder_backend(const std::string &id) {
    for (const auto &backend : encoder_backends())
        if (backend.id == id)
            return &backend;
    return nullptr;
}

// Empty when this family has no encoder for the codec. Media Foundation and AV1 is the normal
// case, not an error.
inline std::string encoder_element(const EncoderBackend &backend, const std::string &codec_id) {
    for (const auto &codec : backend.codecs)
        if (codec.codec_id == codec_id)
            return codec.element;
    return {};
}

inline Dimensions encoder_minimum(const EncoderBackend &backend, const std::string &codec_id) {
    for (const auto &codec : backend.codecs)
        if (codec.codec_id == codec_id)
            return codec.minimum;
    return {0, 0};
}
