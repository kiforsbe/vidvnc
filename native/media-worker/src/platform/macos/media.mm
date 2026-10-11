// Capture and encode on macOS (design D1): ScreenCaptureKit into VideoToolbox through the
// worker's own elements (elements.hpp), and ScreenCaptureKit system audio into the shared Opus
// branch. Every encoder is proven with real frames before it is offered, as on Windows.
#import <Foundation/Foundation.h>
#include <gst/gst.h>
#include <map>
#include <stdexcept>
#include "../../rate-control.hpp"
#include "../platform.hpp"
#include "elements.hpp"
#include "vt-rate-control.hpp"

namespace platform {

static const EncoderBackend &videotoolbox() {
    static const auto *backend = find_encoder_backend("videotoolbox");
    return *backend;
}

// gst_init may set the user's locale, where a decimal comma would not parse; GLib's ASCII
// formatting is locale-independent.
static std::string ascii(double value) {
    char text[G_ASCII_DTOSTR_BUF_SIZE];
    return g_ascii_dtostr(text, sizeof(text), value);
}

static std::string rate_properties(const VtRateSettings &rate) {
    return "average-bitrate=" + std::to_string(rate.average_bits_per_second) +
           " limit-bytes=" + std::to_string(rate.limit_bytes) +
           " limit-seconds=" + ascii(rate.limit_seconds) +
           " keyframe-interval=" + std::to_string(rate.max_keyframe_interval) +
           " keyframe-seconds=" + ascii(rate.max_keyframe_interval_seconds) +
           " min-qp=" + std::to_string(rate.min_qp) +
           " expected-fps=" + std::to_string(rate.expected_fps);
}

std::string video_pipeline(const VideoRequest &request) {
    macos::register_elements();
    const auto &profile = request.profile;
    const auto rate = vt_rate_settings(rate_control(request.codec.id, profile), profile.fps);
    return "vidvncscreensrc name=capture display=" +
           std::to_string(request.display ? request.display->handle : 0) +
           " show-cursor=true num-buffers=" + std::to_string(request.frames) +
           " width=" + std::to_string(profile.width) + " height=" + std::to_string(profile.height) +
           " fps=" + std::to_string(profile.fps) + " ! " +
           encoder_element(request.backend, request.codec.id) +
           " name=encoder codec=" + request.codec.id + " " + rate_properties(rate) + " ! " +
           request.codec.caps + " ! " + request.codec.parser;
}

std::string audio_pipeline(int audio_channels) {
    macos::register_elements();
    return "vidvncaudiosrc name=audio-capture ! audioconvert ! audioresample ! "
           "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=" +
           std::to_string(audio_channels) + " ! opusenc name=audio-encoder bitrate=" +
           std::string(audio_channels == 1 ? "32000" : "96000") +
           " bitrate-type=cbr frame-size=20 inband-fec=true ! "
           "appsink name=audio-sink sync=false async=false";
}

// Ten real frames through a real session, memoised per codec: what "available" means.
static bool encodes(const std::string &codec_id) {
    static std::map<std::string, bool> cache;
    const auto cached = cache.find(codec_id);
    if (cached != cache.end())
        return cached->second;
    bool ok = false;
    if (macos::hardware_encoder_listed(codec_id)) {
        StreamProfile trial{640, 480, 30, 2000, 1200};
        std::string error;
        ok = macos::encoder_self_test(codec_id, trial.width, trial.height,
                                      vt_rate_settings(rate_control(codec_id, trial), trial.fps),
                                      10, error);
        if (!ok)
            if (auto log = worker_log())
                *log << "BACKEND videotoolbox " << codec_id << " self-test failed: " << error
                     << std::endl;
    }
    cache.emplace(codec_id, ok);
    return ok;
}

std::vector<BackendAvailability> available_backends(const std::optional<CaptureDisplay> &) {
    // One GPU captures and encodes, so the encoder is always on the capture adapter.
    BackendAvailability entry{&videotoolbox(), {}, true};
    for (const auto &codec : video_codecs())
        if (!encoder_element(videotoolbox(), codec.id).empty() && encodes(codec.id))
            entry.codecs.push_back(codec.id);
    if (entry.codecs.empty())
        return {};
    return {entry};
}

Selection encoder_selection_for(const std::string &codec_id, const std::optional<CaptureDisplay> &,
                                const std::string &forced_backend) {
    std::vector<EncoderCandidate> candidates;
    // Listing encoders opens no session; the stream's own pipeline is the real test, as on
    // Windows.
    if (!encoder_element(videotoolbox(), codec_id).empty() &&
        macos::hardware_encoder_listed(codec_id))
        candidates.push_back(
            {videotoolbox().id, encoder_element(videotoolbox(), codec_id), false, 0});
    return select_encoder(candidates, false, 0, forced_backend);
}

void preflight() {
    // macOS 27 only (design Q6).
    if (![NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:{27, 0, 0}])
        throw std::runtime_error("macOS 27 or newer is required.");
    macos::register_elements();
    // Includes elements webrtcbin creates internally, so a packaged plugin set missing one
    // fails here rather than mid-negotiation.
    for (const char *name :
         {"h264parse", "h265parse",    "rtph264pay",    "rtph265pay",  "webrtcbin",
          "nicesrc",   "nicesink",     "dtlssrtpenc",   "dtlssrtpdec", "srtpenc",
          "srtpdec",   "sctpenc",      "sctpdec",       "appsrc",      "appsink",
          "rtpbin",    "rtpfunnel",    "rtprtxsend",    "rtpstorage",  "rtpulpfecenc",
          "rtpredenc", "audioconvert", "audioresample", "opusenc",     "rtpopuspay"}) {
        auto factory = gst_element_factory_find(name);
        if (!factory)
            throw std::runtime_error(std::string("Required hardware/media plugin unavailable: ") +
                                     name);
        gst_object_unref(factory);
    }
    // H.264 is the one codec a host cannot disable. Screen recording permission is not checked
    // here: it is the owner's to give when they first share, and capture says so if it is
    // missing.
    if (!macos::hardware_encoder_listed("h264"))
        throw std::runtime_error("No hardware H.264 encoder. VideoToolbox lists none on this Mac.");
}

const char *capture_name() { return "screencapturekit"; }

} // namespace platform
