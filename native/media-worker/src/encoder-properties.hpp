#pragma once
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>
#include <glib-object.h>
#include <gst/gst.h>
#include "encoder-backend.hpp"
#include "rate-control.hpp"

// Turns rate-control intent into a property string for one encoder element, by asking the
// element class which properties it actually declares.
//
// Concatenating literals would be shorter, but three of the four encoder families are developed
// without hardware to run them on, and a property name that is wrong or absent becomes a
// gst_parse_launch failure on a user's machine rather than a compile error here. Introspection
// turns that into a skipped property and a log line. It also supplies the QP range, which the
// GStreamer documentation does not publish for Quick Sync or AMF AV1 encoding.

struct EncoderProperties {
    std::string text;                 // Encoder properties, no leading or trailing space.
    std::vector<std::string> skipped; // Wanted but not declared by this element.
};

// Map a fraction of the QP range onto the range this element declares, rounding half away from
// zero and clamping into the declared bounds.
inline int scale_qp_floor(double normalised, GParamSpec *spec) {
    double minimum = 0.0, maximum = 0.0;
    if (G_IS_PARAM_SPEC_INT(spec)) {
        minimum = G_PARAM_SPEC_INT(spec)->minimum;
        maximum = G_PARAM_SPEC_INT(spec)->maximum;
    } else if (G_IS_PARAM_SPEC_UINT(spec)) {
        minimum = G_PARAM_SPEC_UINT(spec)->minimum;
        maximum = G_PARAM_SPEC_UINT(spec)->maximum;
    } else {
        return 0;
    }
    const double scaled = std::round(normalised * maximum);
    return static_cast<int>(std::min(std::max(scaled, minimum), maximum));
}

namespace encoder_properties_detail {

struct Builder {
    GObjectClass *klass;
    EncoderProperties result;

    GParamSpec *find(const std::string &name) const {
        return name.empty() ? nullptr : g_object_class_find_property(klass, name.c_str());
    }
    // An empty name means the backend does not want this property at all, which is not a skip.
    void add(const std::string &name, const std::string &value) {
        if (name.empty())
            return;
        if (!find(name)) {
            result.skipped.push_back(name);
            return;
        }
        if (!result.text.empty())
            result.text += ' ';
        result.text += name + '=' + value;
    }
    // Takes the family's candidate spellings, best first, and uses the first one this element
    // declares. Nothing is emitted when the element declares none of them: an absent floor costs
    // quality at the VBR tiers, while an unknown property name fails the pipeline outright.
    void add_floor(const std::vector<std::string> &names, double normalised) {
        if (names.empty() || normalised < 0.0)
            return;
        for (const auto &name : names)
            if (auto *spec = find(name)) {
                add(name, std::to_string(scale_qp_floor(normalised, spec)));
                return;
            }
        result.skipped.push_back(names.front());
    }
};

} // namespace encoder_properties_detail

inline EncoderProperties encoder_properties(const EncoderBackend &backend,
                                            const std::string &element_name,
                                            const std::string &codec_id,
                                            const RateControl &intent) {
    EncoderProperties empty;
    auto *found = gst_element_factory_find(element_name.c_str());
    if (!found)
        return empty;
    // A found factory carries no element type until its plugin is loaded, so the class would
    // declare no properties at all and every one of them would look absent.
    auto *factory = GST_ELEMENT_FACTORY(gst_plugin_feature_load(GST_PLUGIN_FEATURE(found)));
    gst_object_unref(found);
    if (!factory)
        return empty;
    auto type = gst_element_factory_get_element_type(factory);
    gst_object_unref(factory);
    if (type == G_TYPE_INVALID)
        return empty;
    auto *klass = static_cast<GObjectClass *>(g_type_class_ref(type));
    if (!klass)
        return empty;

    encoder_properties_detail::Builder builder{klass, {}};
    const auto &dialect = backend.dialect;
    const bool vbr = intent.mode == RateMode::Vbr;
    for (const auto &pair : dialect.low_latency)
        builder.add(pair.property, pair.value);
    builder.add(dialect.rc_mode_property, vbr ? dialect.vbr_value : dialect.cbr_value);
    builder.add(dialect.bitrate_property, std::to_string(intent.bitrate_kbps));
    if (vbr)
        builder.add(dialect.max_bitrate_property, std::to_string(intent.max_bitrate_kbps));
    builder.add_floor(dialect.qp_floor_i_properties, intent.qp_floor_i);
    builder.add_floor(dialect.qp_floor_p_properties, intent.qp_floor_p);
    builder.add(dialect.gop_property, std::to_string(intent.gop_frames));
    builder.add(dialect.bframes_property, "0");
    // Only H.264 repeated the sequence header through the encoder; H.265 and AV1 rely on the
    // parser's config-interval, exactly as before this table existed.
    if (codec_id == "h264")
        builder.add(dialect.header_repeat_property, "true");

    g_type_class_unref(klass);
    return builder.result;
}
