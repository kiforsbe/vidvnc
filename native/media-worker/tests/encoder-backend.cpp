#include <cassert>
#include <string>
#include "../src/encoder-backend.hpp"
int main() {
    const auto &table = encoder_backends();

    // Order is the fixed tie-break used when no candidate sits on the capture adapter.
    assert(table.size() == 4);
    assert(table[0].id == "nvenc");
    assert(table[1].id == "qsv");
    assert(table[2].id == "amf");
    assert(table[3].id == "mediafoundation");

    const auto *nvenc = find_encoder_backend("nvenc");
    const auto *qsv = find_encoder_backend("qsv");
    const auto *amf = find_encoder_backend("amf");
    const auto *mf = find_encoder_backend("mediafoundation");
    assert(nvenc && qsv && amf && mf);

    // `auto` is a policy value, not a backend, and must not resolve here.
    assert(!find_encoder_backend("auto"));
    assert(!find_encoder_backend(""));
    assert(!find_encoder_backend("nvidia"));

    assert(encoder_element(*nvenc, "h264") == "nvd3d11h264enc");
    assert(encoder_element(*nvenc, "h265") == "nvd3d11h265enc");
    assert(encoder_element(*nvenc, "av1") == "nvd3d11av1enc");
    assert(encoder_element(*qsv, "h264") == "qsvh264enc");
    assert(encoder_element(*qsv, "h265") == "qsvh265enc");
    assert(encoder_element(*qsv, "av1") == "qsvav1enc");
    assert(encoder_element(*amf, "h264") == "amfh264enc");
    assert(encoder_element(*amf, "h265") == "amfh265enc");
    assert(encoder_element(*amf, "av1") == "amfav1enc");

    // Media Foundation has no AV1 encoder. An absent pair is normal, not an error.
    assert(encoder_element(*mf, "h264") == "mfh264enc");
    assert(encoder_element(*mf, "h265") == "mfh265enc");
    assert(encoder_element(*mf, "av1").empty());
    for (const auto &backend : table)
        assert(encoder_element(backend, "vp9").empty());

    // A backend left half-declared must fail here rather than at pipeline parse.
    for (const auto &backend : table) {
        const auto &dialect = backend.dialect;
        assert(!backend.label.empty());
        assert(!dialect.rc_mode_property.empty());
        assert(!dialect.cbr_value.empty());
        assert(!dialect.vbr_value.empty());
        assert(!dialect.bitrate_property.empty());
        assert(!dialect.max_bitrate_property.empty());
        assert(!dialect.gop_property.empty());
        assert(!dialect.bframes_property.empty());
        assert(!dialect.qp_floor_i_properties.empty());
        // Only Media Foundation has a single floor covering every frame type on every codec.
        assert(dialect.qp_floor_p_properties.empty() == (backend.id == "mediafoundation"));
    }

    assert(nvenc->dialect.rc_mode_property == "rc-mode");
    assert(mf->dialect.rc_mode_property == "rc-mode");
    assert(qsv->dialect.rc_mode_property == "rate-control");
    assert(amf->dialect.rc_mode_property == "rate-control");

    assert(nvenc->dialect.bframes_property == "bframes");
    assert(mf->dialect.bframes_property == "bframes");
    assert(qsv->dialect.bframes_property == "b-frames");
    assert(amf->dialect.bframes_property == "b-frames");

    // Media Foundation's variable mode is peak-constrained VBR; there is no plain `vbr`.
    assert(nvenc->dialect.vbr_value == "vbr");
    assert(qsv->dialect.vbr_value == "vbr");
    assert(amf->dialect.vbr_value == "vbr");
    assert(mf->dialect.vbr_value == "pcvbr");
    for (const auto &backend : table)
        assert(backend.dialect.cbr_value == "cbr");

    assert(nvenc->dialect.qp_floor_i_properties == std::vector<std::string>{"qp-min-i"});
    assert(nvenc->dialect.qp_floor_p_properties == std::vector<std::string>{"qp-min-p"});
    assert(qsv->dialect.qp_floor_i_properties == std::vector<std::string>{"min-qp-i"});
    assert(mf->dialect.qp_floor_i_properties == std::vector<std::string>{"min-qp"});
    // AMF is the reason these are lists rather than names: amfh265enc declares `min-qp-i`, but
    // amfh264enc declares only a global `min-qp` and amfav1enc declares no floor at all. The
    // per-codec spelling cannot be known from the family, so both are offered in preference
    // order and the property builder keeps whichever the element has.
    assert((amf->dialect.qp_floor_i_properties == std::vector<std::string>{"min-qp-i", "min-qp"}));
    assert(amf->dialect.qp_floor_p_properties == std::vector<std::string>{"min-qp-p"});

    // Only NVENC repeats the sequence header through an encoder property.
    assert(nvenc->dialect.header_repeat_property == "repeat-sequence-header");
    assert(qsv->dialect.header_repeat_property.empty());
    assert(amf->dialect.header_repeat_property.empty());
    assert(mf->dialect.header_repeat_property.empty());

    // Quick Sync has no low-latency property; its latency comes from a single reference
    // frame plus CBR, no B-frames and a short GOP.
    bool qsv_has_ref_frames = false;
    for (const auto &pair : qsv->dialect.low_latency) {
        assert(pair.property != "preset" && pair.property != "usage");
        if (pair.property == "ref-frames") {
            assert(pair.value == "1");
            qsv_has_ref_frames = true;
        }
    }
    assert(qsv_has_ref_frames);
    assert(!nvenc->dialect.low_latency.empty());
    assert(!amf->dialect.low_latency.empty());
    assert(!mf->dialect.low_latency.empty());

    assert(encoder_minimum(*nvenc, "av1").width == 192);
    assert(encoder_minimum(*nvenc, "av1").height == 128);
    assert(encoder_minimum(*nvenc, "h265").width == 144);
    assert(encoder_minimum(*nvenc, "h265").height == 48);
    for (const char *codec : {"h264", "h265", "av1"}) {
        assert(encoder_minimum(*qsv, codec).width == 16 &&
               encoder_minimum(*qsv, codec).height == 16);
        assert(encoder_minimum(*amf, codec).width == 128 &&
               encoder_minimum(*amf, codec).height == 128);
    }
    for (const char *codec : {"h264", "h265"})
        assert(encoder_minimum(*mf, codec).width == 64 && encoder_minimum(*mf, codec).height == 64);
}
