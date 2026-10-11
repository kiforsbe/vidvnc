// Capture and encode on Windows: desktop duplication (d3d11screencapturesrc) on the GPU that
// drives the monitor, into one of the hardware encoder families in encoder-backend.hpp, and
// WASAPI loopback for audio. Every encoder is proven with real frames before it is offered.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dxgi.h>
#include <gst/gst.h>
#include <algorithm>
#include <map>
#include <stdexcept>
#include "../../encoder-properties.hpp"
#include "../../rate-control.hpp"
#include "../platform.hpp"

namespace platform {

std::string video_pipeline(const VideoRequest &request) {
    const auto &capture_display = request.display;
    const auto &profile = request.profile;
    const auto *video_codec = &request.codec;
    const auto *encoder_backend = &request.backend;
    const auto target = capture_display
                            ? "monitor-handle=" + std::to_string(capture_display->handle)
                            : "monitor-index=-1";
    const bool h264 = video_codec->id == "h264";
    const auto element = encoder_element(*encoder_backend, video_codec->id);
    const auto encoder = encoder_properties(*encoder_backend, element, video_codec->id,
                                            rate_control(video_codec->id, profile));
    if (auto log = worker_log())
        for (const auto &name : encoder.skipped)
            *log << "ENCODER " << element << " has no property " << name << std::endl;
    return "d3d11screencapturesrc name=capture " + target +
           " show-cursor=true num-buffers=" + std::to_string(request.frames) +
           " ! d3d11convert ! "
           "video/x-raw(memory:D3D11Memory),format=NV12,width=" +
           std::to_string(profile.width) + ",height=" + std::to_string(profile.height) +
           ",framerate=" + std::to_string(profile.fps) + "/1 ! " + element + " name=encoder " +
           encoder.text + " ! " + video_codec->caps +
           std::string(h264 && profile.fps == 15 && profile.width <= 1280 && profile.height <= 720
                           ? ",level=(string)3.1"
                           : "") +
           " ! " + video_codec->parser;
}
std::string audio_pipeline(int audio_channels) {
    return "wasapisrc name=audio-capture loopback=true low-latency=true ! audioconvert ! "
           "audioresample ! audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=" +
           std::to_string(audio_channels) + " ! opusenc name=audio-encoder bitrate=" +
           std::string(audio_channels == 1 ? "32000" : "96000") +
           " bitrate-type=cbr frame-size=20 inband-fec=true ! "
           "appsink name=audio-sink sync=false async=false";
}

struct AdapterInfo {
    UINT index;
    std::int64_t luid;
};

// Packed the same way GStreamer packs its `adapter-luid` properties, so the two compare.
static std::int64_t luid_to_int64(const LUID &luid) {
    LARGE_INTEGER value;
    value.LowPart = luid.LowPart;
    value.HighPart = luid.HighPart;
    return value.QuadPart;
}

static std::vector<AdapterInfo> enumerate_adapters() {
    std::vector<AdapterInfo> adapters;
    IDXGIFactory1 *factory = nullptr;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(&factory))))
        return adapters;
    IDXGIAdapter1 *adapter = nullptr;
    for (UINT index = 0; factory->EnumAdapters1(index, &adapter) != DXGI_ERROR_NOT_FOUND; ++index) {
        DXGI_ADAPTER_DESC1 desc{};
        if (SUCCEEDED(adapter->GetDesc1(&desc)))
            adapters.push_back({index, luid_to_int64(desc.AdapterLuid)});
        adapter->Release();
        adapter = nullptr;
    }
    factory->Release();
    return adapters;
}

// Desktop duplication captures on the GPU that drives the monitor, and d3d11screencapturesrc
// does not report which that is: it exposes only an `adapter` index meant for Windows Graphics
// Capture. Match the monitor handle against DXGI's outputs instead. An unknown adapter is not a
// failure; ranking simply falls back to the fixed backend order.
static bool capture_adapter_luid(const std::optional<CaptureDisplay> &capture_display,
                                 std::int64_t &out) {
    HMONITOR monitor = capture_display ? reinterpret_cast<HMONITOR>(capture_display->handle)
                                       : MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
    if (!monitor)
        return false;
    IDXGIFactory1 *factory = nullptr;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(&factory))))
        return false;
    bool found = false;
    IDXGIAdapter1 *adapter = nullptr;
    for (UINT i = 0; !found && factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
        IDXGIOutput *output = nullptr;
        for (UINT j = 0; !found && adapter->EnumOutputs(j, &output) != DXGI_ERROR_NOT_FOUND; ++j) {
            DXGI_OUTPUT_DESC desc{};
            DXGI_ADAPTER_DESC1 adapter_desc{};
            if (SUCCEEDED(output->GetDesc(&desc)) && desc.Monitor == monitor &&
                SUCCEEDED(adapter->GetDesc1(&adapter_desc))) {
                out = luid_to_int64(adapter_desc.AdapterLuid);
                found = true;
            }
            output->Release();
            output = nullptr;
        }
        adapter->Release();
        adapter = nullptr;
    }
    factory->Release();
    return found;
}

static bool element_adapter_luid(const std::string &name, std::int64_t &out,
                                 bool probe_nvenc = false) {
    // Instantiating a D3D11-mode NVENC element creates D3D11/CUDA state even while it is in
    // NULL.  That was introduced for adapter affinity in the multi-backend work, but it means
    // the later real nvd3d11h265enc can fail to open its NVENC session once a WebRTC peer is
    // attached.  The NVIDIA-only worker never created this throwaway element.  Keep selection
    // side-effect free for that family; an explicit `nvenc` choice still selects it directly.
    if (!probe_nvenc && name.rfind("nvd3d11", 0) == 0)
        return false;
    auto *element = gst_element_factory_make(name.c_str(), nullptr);
    if (!element)
        return false;
    bool found = false;
    if (g_object_class_find_property(G_OBJECT_GET_CLASS(element), "adapter-luid")) {
        gint64 value = 0;
        g_object_get(element, "adapter-luid", &value, nullptr);
        out = value;
        found = true;
    }
    gst_object_unref(element);
    return found;
}

// A registered element factory is not evidence that the hardware, driver and element agree.
// Drive ten real frames of D3D11 memory through the encoder on its own adapter and see. This is
// what "available" means everywhere else in the worker.
static bool backend_encodes(const EncoderBackend &backend, const VideoCodec &codec,
                            const std::vector<AdapterInfo> &adapters) {
    const auto element = encoder_element(backend, codec.id);
    if (element.empty())
        return false;
    StreamProfile trial{640, 480, 30, 2000, 1200};
    trial.bitrate_mode = BitrateMode::Cbr;
    const auto properties =
        encoder_properties(backend, element, codec.id, rate_control(codec.id, trial));
    std::string source = "d3d11testsrc num-buffers=10";
    std::int64_t luid = 0;
    if (element_adapter_luid(element, luid))
        for (const auto &adapter : adapters)
            if (adapter.luid == luid)
                source += " adapter=" + std::to_string(adapter.index);
    const auto description = source +
                             " ! video/x-raw(memory:D3D11Memory),format=NV12,width=640,"
                             "height=480,framerate=30/1 ! " +
                             element + " " + properties.text + " ! " + codec.parser + " ! fakesink";
    GError *error = nullptr;
    auto *pipe = gst_parse_launch(description.c_str(), &error);
    if (error || !pipe) {
        if (auto log = worker_log())
            *log << "BACKEND " << backend.id << " " << codec.id
                 << " unavailable: " << (error ? error->message : "no pipeline") << std::endl;
        if (error)
            g_error_free(error);
        if (pipe)
            gst_object_unref(pipe);
        return false;
    }
    gst_element_set_state(pipe, GST_STATE_PLAYING);
    auto *bus = gst_element_get_bus(pipe);
    auto *message = gst_bus_timed_pop_filtered(
        bus, 10 * GST_SECOND, static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_EOS));
    const bool ok = message && GST_MESSAGE_TYPE(message) == GST_MESSAGE_EOS;
    if (message && !ok && worker_log()) {
        GError *failure = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_error(message, &failure, &debug);
        *worker_log() << "BACKEND " << backend.id << " " << codec.id
                      << " self-test failed: " << (failure ? failure->message : "unknown")
                      << std::endl;
        if (failure)
            g_error_free(failure);
        g_free(debug);
    }
    if (message)
        gst_message_unref(message);
    // NVENC frees the hardware session while the pipeline completes its NULL transition.  Do
    // not merely request that transition and immediately create the live encoder: on NVIDIA
    // drivers that can make the new H.265 session race the just-finished probe and fail with
    // "Failed to open session".  v0.5 did not run this probe before each worker, so it never
    // exposed that race.
    gst_element_set_state(pipe, GST_STATE_NULL);
    gst_element_get_state(pipe, nullptr, nullptr, 10 * GST_SECOND);
    gst_object_unref(bus);
    gst_object_unref(pipe);
    return ok;
}

static bool backend_elements_present(const EncoderBackend &backend, const VideoCodec &codec) {
    const auto element = encoder_element(backend, codec.id);
    if (element.empty())
        return false;
    const auto parser_name = codec.parser.substr(0, codec.parser.find(' '));
    auto *encoder_factory = gst_element_factory_find(element.c_str());
    auto *parser_factory = gst_element_factory_find(parser_name.c_str());
    auto *payloader_factory = gst_element_factory_find(codec.payloader.c_str());
    const bool present = encoder_factory && parser_factory && payloader_factory;
    if (encoder_factory)
        gst_object_unref(encoder_factory);
    if (parser_factory)
        gst_object_unref(parser_factory);
    if (payloader_factory)
        gst_object_unref(payloader_factory);
    return present;
}

// Memoised per backend and codec, because every self-test is a real encode. This is reserved for
// --probe: running a temporary NVENC session in every live worker regressed the 0.5 startup path
// and can make the immediately following live H.265 session fail to open on some drivers.
static bool backend_supports(const EncoderBackend &backend, const VideoCodec &codec) {
    static std::map<std::string, bool> cache;
    const auto key = backend.id + "/" + codec.id;
    const auto cached = cache.find(key);
    if (cached != cache.end())
        return cached->second;
    static const auto adapters = enumerate_adapters();
    bool supported = false;
    if (backend_elements_present(backend, codec))
        supported = backend_encodes(backend, codec, adapters);
    cache.emplace(key, supported);
    return supported;
}

// The whole matrix. Only --probe needs this; a stream asks about one codec.
std::vector<BackendAvailability> available_backends(const std::optional<CaptureDisplay> &display) {
    std::vector<BackendAvailability> result;
    std::int64_t capture_luid = 0;
    const bool capture_known = capture_adapter_luid(display, capture_luid);
    for (const auto &backend : encoder_backends()) {
        BackendAvailability entry{&backend, {}, false};
        for (const auto &codec : video_codecs()) {
            if (!backend_supports(backend, codec))
                continue;
            entry.codecs.push_back(codec.id);
            std::int64_t luid = 0;
            const auto element = encoder_element(backend, codec.id);
            if (capture_known && element_adapter_luid(element, luid, true) && luid == capture_luid)
                entry.on_capture_adapter = true;
        }
        if (!entry.codecs.empty())
            result.push_back(entry);
    }
    return result;
}

Selection encoder_selection_for(const std::string &codec_id,
                                const std::optional<CaptureDisplay> &display,
                                const std::string &forced_backend) {
    const auto *codec = find_video_codec(codec_id);
    if (!codec)
        return {false, {}, SelectionReason::FixedOrder};
    std::vector<EncoderCandidate> candidates;
    std::int64_t capture_luid = 0;
    const bool capture_known = capture_adapter_luid(display, capture_luid);
    for (const auto &backend : encoder_backends()) {
        // A stream must not open disposable NVENC sessions merely to select its encoder.  The
        // actual pipeline is the authoritative test and reports its own diagnostics on failure.
        if (!backend_elements_present(backend, *codec))
            continue;
        const auto element = encoder_element(backend, codec_id);
        std::int64_t luid = 0;
        const bool has_adapter = element_adapter_luid(element, luid);
        candidates.push_back({backend.id, element, has_adapter, luid});
    }
    return select_encoder(candidates, capture_known, capture_luid, forced_backend);
}

void preflight() {
    // RtlGetVersion is not affected by application compatibility manifests.
    struct Version {
        ULONG size, major, minor, build, platform;
        WCHAR service[128];
    } version{};
    version.size = sizeof(version);
    auto rtl = reinterpret_cast<LONG(WINAPI *)(Version *)>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
    if (!rtl || rtl(&version) != 0 || version.build < 26200)
        throw std::runtime_error("Windows 11 25H2 (build 26200) or newer is required.");
    // Includes elements webrtcbin creates internally, so a packaged plugin set missing one fails
    // here rather than mid-negotiation.
    for (const char *name : {"d3d11screencapturesrc",
                             "d3d11convert",
                             "d3d11testsrc",
                             "h264parse",
                             "rtph264pay",
                             "webrtcbin",
                             "nicesrc",
                             "nicesink",
                             "dtlssrtpenc",
                             "dtlssrtpdec",
                             "srtpenc",
                             "srtpdec",
                             "sctpenc",
                             "sctpdec",
                             "appsrc",
                             "appsink",
                             "rtpbin",
                             "rtpfunnel",
                             "rtprtxsend",
                             "rtpstorage",
                             "rtpulpfecenc",
                             "rtpredenc",
                             "wasapisrc",
                             "audioconvert",
                             "audioresample",
                             "opusenc",
                             "rtpopuspay"}) {
        auto factory = gst_element_factory_find(name);
        if (!factory)
            throw std::runtime_error(std::string("Required hardware/media plugin unavailable: ") +
                                     name);
        gst_object_unref(factory);
    }
    // H.264 is the universal fallback throughout the protocol and the one codec a host cannot
    // disable, so ensure a complete installed path exists.  A live worker must not spend a
    // temporary NVENC session here: it immediately opens the selected session below.
    const auto *h264 = find_video_codec("h264");
    for (const auto &backend : encoder_backends())
        if (h264 && backend_elements_present(backend, *h264))
            return;
    std::string tried;
    for (const auto &backend : encoder_backends())
        tried += (tried.empty() ? "" : ", ") + encoder_element(backend, "h264");
    throw std::runtime_error("No supported hardware H.264 encoder. Tried " + tried +
                             ". A GPU with a working NVIDIA, Intel or AMD hardware encoder and "
                             "a current driver is required.");
}

const char *capture_name() { return "dxgi"; }

} // namespace platform
