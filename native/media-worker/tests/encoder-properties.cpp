#include <algorithm>
#include <cassert>
#include <set>
#include <sstream>
#include <string>
#include <vector>
#include <gst/gst.h>
#include "../src/encoder-properties.hpp"

static std::set<std::string> pairs(const std::string &text) {
    std::set<std::string> out;
    std::istringstream stream(text);
    for (std::string token; stream >> token;)
        out.insert(token);
    return out;
}

static bool has(const std::vector<std::string> &list, const std::string &name) {
    return std::find(list.begin(), list.end(), name) != list.end();
}

// A dialect over `identity`, which every GStreamer install has. The values are never applied to
// an element, so their types do not matter: only whether the class declares the property.
static EncoderBackend fake_backend(bool single_floor) {
    EncoderBackend backend;
    backend.id = "fake";
    backend.label = "Fake";
    backend.dialect = {"sync",
                       "cbr",
                       "vbr",
                       "datarate",
                       "no-such-max-bitrate",
                       "sleep-time",
                       "no-such-bframes",
                       "error-after",
                       single_floor ? "" : "eos-after",
                       "",
                       {{"silent", "true"}, {"no-such-low-latency", "1"}}};
    backend.codecs = {{"h264", "identity", {64, 64}}};
    return backend;
}

static StreamProfile vbr_profile() {
    StreamProfile profile;
    profile.fps = 30;
    profile.bitrate = 6000;
    profile.bitrate_mode = BitrateMode::Vbr;
    profile.quality = Quality::Balanced;
    return profile;
}

int main(int argc, char *argv[]) {
    gst_init(&argc, &argv);

    // Scaling a normalised floor onto whatever range the element declares.
    auto *avc = g_param_spec_int("i", "i", "i", 0, 51, 0, G_PARAM_READWRITE);
    auto *av1 = g_param_spec_int("i", "i", "i", 0, 255, 0, G_PARAM_READWRITE);
    assert(scale_qp_floor(24.0 / 51.0, avc) == 24);
    assert(scale_qp_floor(30.0 / 51.0, avc) == 30);
    assert(scale_qp_floor(120.0 / 255.0, av1) == 120);
    // The point of storing fractions: the same quality lands sensibly on a different scale.
    assert(scale_qp_floor(120.0 / 255.0, avc) == 24);
    assert(scale_qp_floor(24.0 / 51.0, av1) == 120);
    // Out of range values clamp into the declared range rather than being emitted.
    assert(scale_qp_floor(2.0, avc) == 51);
    auto *floored = g_param_spec_int("i", "i", "i", 10, 51, 10, G_PARAM_READWRITE);
    assert(scale_qp_floor(0.0, floored) == 10);
    // Unsigned ranges and a degenerate maximum must not misbehave.
    auto *unsigned_spec = g_param_spec_uint("u", "u", "u", 0, 51, 0, G_PARAM_READWRITE);
    assert(scale_qp_floor(24.0 / 51.0, unsigned_spec) == 24);
    auto *degenerate = g_param_spec_uint("u", "u", "u", 0, 0, 0, G_PARAM_READWRITE);
    assert(scale_qp_floor(0.5, degenerate) == 0);

    // A property the element does not declare is skipped and reported, never emitted.
    const auto backend = fake_backend(false);
    const auto built =
        encoder_properties(backend, "identity", "h264", rate_control("h264", vbr_profile()));
    const auto tokens = pairs(built.text);
    assert(tokens.count("silent=true"));
    assert(tokens.count("sync=vbr"));
    assert(tokens.count("datarate=6000"));
    assert(tokens.count("sleep-time=300"));
    assert(built.text.find("no-such") == std::string::npos);
    assert(has(built.skipped, "no-such-low-latency"));
    assert(has(built.skipped, "no-such-max-bitrate"));
    assert(has(built.skipped, "no-such-bframes"));
    // Both floors were wanted and both exist, so neither is skipped.
    assert(built.text.find("error-after=") != std::string::npos);
    assert(built.text.find("eos-after=") != std::string::npos);

    // Media Foundation's shape: one floor covers every frame type. The P floor was never
    // wanted, so it is neither emitted nor reported as skipped.
    const auto single = fake_backend(true);
    const auto single_built =
        encoder_properties(single, "identity", "h264", rate_control("h264", vbr_profile()));
    assert(single_built.text.find("error-after=") != std::string::npos);
    assert(single_built.text.find("eos-after=") == std::string::npos);
    assert(!has(single_built.skipped, "eos-after"));

    // NVENC regression. Property order does not affect gst_parse_launch, so the invariant is
    // the set of pairs: it must match exactly what the worker emitted before this refactor.
    auto *factory = gst_element_factory_find("nvd3d11h264enc");
    if (!factory) {
        g_print("nvd3d11h264enc absent; skipping the NVENC regression\n");
        return 0;
    }
    gst_object_unref(factory);

    const auto *nvenc = find_encoder_backend("nvenc");
    assert(nvenc);
    StreamProfile profile;
    profile.fps = 30;
    profile.bitrate = 6000;
    profile.bitrate_mode = BitrateMode::Cbr;
    const auto cbr =
        encoder_properties(*nvenc, "nvd3d11h264enc", "h264", rate_control("h264", profile));
    assert(cbr.skipped.empty());
    assert(pairs(cbr.text) ==
           pairs("preset=p3 tune=ultra-low-latency rc-mode=cbr bitrate=6000 gop-size=30 "
                 "bframes=0 zerolatency=true repeat-sequence-header=true"));

    profile.bitrate_mode = BitrateMode::Vbr;
    profile.quality = Quality::Balanced;
    const auto vbr =
        encoder_properties(*nvenc, "nvd3d11h264enc", "h264", rate_control("h264", profile));
    assert(vbr.skipped.empty());
    assert(pairs(vbr.text) ==
           pairs("preset=p3 tune=ultra-low-latency rc-mode=vbr bitrate=6000 max-bitrate=12000 "
                 "qp-min-i=24 qp-min-p=28 gop-size=300 bframes=0 zerolatency=true "
                 "repeat-sequence-header=true"));

    // H.265 differs only by repeating the sequence header through the parser instead.
    profile.bitrate_mode = BitrateMode::Cbr;
    const auto hevc =
        encoder_properties(*nvenc, "nvd3d11h265enc", "h265", rate_control("h265", profile));
    assert(pairs(hevc.text) ==
           pairs("preset=p3 tune=ultra-low-latency rc-mode=cbr bitrate=6000 gop-size=30 "
                 "bframes=0 zerolatency=true"));
}
