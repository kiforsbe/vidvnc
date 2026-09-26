#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winsock2.h>
#include <iphlpapi.h>
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <gst/video/video-event.h>
#include <json-glib/json-glib.h>
#include <iostream>
#include <string>
#include <stdexcept>
#include <thread>
#include <set>
#include <map>
#include <cmath>
#include <atomic>
#include <fstream>
#include <algorithm>
#include <filesystem>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>
#include "input-policy.hpp"
#include "peer-permission.hpp"
#include "keyframe-limiter.hpp"
#include "video-codec.hpp"
#include "display-inventory.hpp"
#include "stream-profile.hpp"
#include "json-util.hpp"
#include "media-net.hpp"
#include "net-pipes.hpp"
#include "net-records.hpp"
#include "sandbox.hpp"
#include "rate-control.hpp"
#include "encoder-backend.hpp"
#include "encoder-properties.hpp"
#include "encoder-selection.hpp"
#include <dxgi.h>
#include "telemetry.hpp"
static MediaTelemetry telemetry;
static std::optional<CaptureDisplay> capture_display;
static DesktopRect virtual_desktop() {
    return {GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)};
}
static bool capture_display_current() {
    if (!capture_display)
        return true;
    try {
        for (const auto &display : enumerate_displays()) {
            const auto &expected = *capture_display;
            if (display.id == expected.id)
                return display.handle == expected.handle && display.rotation == expected.rotation &&
                       display.bounds.x == expected.bounds.x &&
                       display.bounds.y == expected.bounds.y &&
                       display.bounds.width == expected.bounds.width &&
                       display.bounds.height == expected.bounds.height;
        }
    } catch (...) {
    }
    return false;
}
struct AudioTelemetry {
    std::mutex mutex;
    guint64 captured = 0, encoded = 0, bytes = 0;
    void attach(GstElement *pipe) {
        std::lock_guard<std::mutex> lock(mutex);
        captured = encoded = bytes = 0;
        for (auto spec :
             {std::make_pair("audio-capture", "src"), std::make_pair("audio-encoder", "src")}) {
            auto element = gst_bin_get_by_name(GST_BIN(pipe), spec.first);
            if (!element)
                continue;
            auto pad = gst_element_get_static_pad(element, spec.second);
            if (pad)
                gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, probe, this, nullptr);
            if (pad)
                gst_object_unref(pad);
            gst_object_unref(element);
        }
    }
    static GstPadProbeReturn probe(GstPad *pad, GstPadProbeInfo *info, gpointer data) {
        auto &self = *static_cast<AudioTelemetry *>(data);
        auto parent = gst_pad_get_parent_element(pad);
        std::lock_guard<std::mutex> lock(self.mutex);
        if (g_strcmp0(GST_OBJECT_NAME(parent), "audio-capture") == 0)
            ++self.captured;
        else {
            ++self.encoded;
            auto buffer = GST_PAD_PROBE_INFO_BUFFER(info);
            if (buffer)
                self.bytes += gst_buffer_get_size(buffer);
        }
        gst_object_unref(parent);
        return GST_PAD_PROBE_OK;
    }
    void merge(JsonObject *result) {
        std::lock_guard<std::mutex> lock(mutex);
        json_object_set_double_member(result, "audioCaptureBuffers", static_cast<double>(captured));
        json_object_set_double_member(result, "audioEncodedPackets", static_cast<double>(encoded));
        json_object_set_double_member(result, "audioEncodedBytes", static_cast<double>(bytes));
    }
};
static AudioTelemetry audio_telemetry;

static GMainLoop *loop = nullptr;
static GstElement *pipeline = nullptr;
static bool failed = false;
static bool started = false;
static bool playing = false;
static StreamProfile profile;
static const char *bitrate_mode_name(BitrateMode mode) {
    return mode == BitrateMode::Vbr ? "vbr" : "cbr";
}
static const char *quality_name(Quality quality) {
    switch (quality) {
    case Quality::Efficient:
        return "efficient";
    case Quality::High:
        return "high";
    default:
        return "balanced";
    }
}
static bool video_enabled = true;
static int audio_channels = 0; // 0: no audio chain; 1: mono-32k; 2: stereo-96k
static const VideoCodec *video_codec = &video_codecs()[0];
// Set by `choose_encoder_backend` when a stream starts, and by --self-test-codec. Selection
// happens once per stream and never changes mid-session.
static const EncoderBackend *encoder_backend = find_encoder_backend("nvenc");
static std::string forced_backend = "auto";
static SelectionReason selection_reason = SelectionReason::FixedOrder;
// Reported to the server so the host app can say which GPU is encoding and why. The host is
// entitled to know that its chosen backend was substituted; the viewer never sees any of it.
static const char *selection_reason_name(SelectionReason reason) {
    switch (reason) {
    case SelectionReason::AdapterMatch:
        return "capture-adapter";
    case SelectionReason::Forced:
        return "forced";
    case SelectionReason::ForcedUnavailable:
        return "forced-unavailable";
    case SelectionReason::FixedOrder:
        break;
    }
    return "fixed-order";
}
static bool host_control_required = false;
static PeerPermission peer_permission;
static KeyframeLimiter keyframe_limiter;
static std::set<WORD> held_keys;
static std::set<int> held_buttons;

// One viewer, as the input broker sees it. Its WebRTC connection - webrtcbin, payloaders,
// the data channel - lives in the sandboxed media-net process (media-net.cpp); this side keeps
// only what decides whether its input reaches SendInput.
struct Peer {
    std::string id;
    bool answered = false, removing = false, notify_closed = false;
    bool control = false;
    gint64 last_ping = 0, rate_window = 0;
    int rate_count = 0;
    JsonObject *transport = nullptr; // latest transport row from media-net, owned
    ~Peer() {
        if (transport)
            json_object_unref(transport);
    }
};
static std::map<std::string, std::unique_ptr<Peer>> peers;
static gint64 now_ms() { return g_get_monotonic_time() / 1000; }
static void remove_peer(const std::string &id, bool notify);
static std::ofstream error_log;
static std::atomic<bool> shutdown_started{false};
// Losing the server's pipe must also stop a worker whose GStreamer thread is
// blocked. Attempt orderly cleanup first; the deadline kills only this process.
static void begin_shutdown() {
    if (shutdown_started.exchange(true))
        return;
    std::thread([] {
        Sleep(5000);
        TerminateProcess(GetCurrentProcess(), 2);
    }).detach();
    g_main_context_invoke(
        nullptr,
        [](gpointer) -> gboolean {
            if (loop)
                g_main_loop_quit(loop);
            return G_SOURCE_REMOVE;
        },
        nullptr);
}
static std::atomic<unsigned> force_events{0}, keyframes{0}, sps_profile{0}, sps_level{0};
static bool request_keyframe(GstElement *pipe) {
    auto encoder = gst_bin_get_by_name(GST_BIN(pipe), "encoder");
    if (!encoder)
        return false;
    auto pad = gst_element_get_static_pad(encoder, "src");
    bool accepted = gst_pad_send_event(
        pad, gst_video_event_new_upstream_force_key_unit(GST_CLOCK_TIME_NONE, TRUE, 0));
    gst_object_unref(pad);
    gst_object_unref(encoder);
    return accepted;
}
static GstPadProbeReturn recovery_probe(GstPad *, GstPadProbeInfo *info, gpointer) {
    if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_EVENT_UPSTREAM) {
        if (gst_video_event_is_force_key_unit(GST_PAD_PROBE_INFO_EVENT(info)))
            ++force_events;
    } else if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER) {
        auto buffer = GST_PAD_PROBE_INFO_BUFFER(info);
        if (!GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT))
            ++keyframes;
        if (video_codec->id != "h264")
            return GST_PAD_PROBE_OK;
        GstMapInfo map{};
        if (gst_buffer_map(buffer, &map, GST_MAP_READ)) {
            for (gsize i = 0; i + 6 < map.size; ++i) {
                if (map.data[i] == 0 && map.data[i + 1] == 0 && map.data[i + 2] == 1 &&
                    (map.data[i + 3] & 31) == 7) {
                    sps_profile = map.data[i + 4];
                    sps_level = map.data[i + 6];
                    break;
                }
            }
            gst_buffer_unmap(buffer, &map);
        }
    }
    return GST_PAD_PROBE_OK;
}
static void attach_recovery(GstElement *pipe) {
    auto encoder = gst_bin_get_by_name(GST_BIN(pipe), "encoder");
    auto pad = gst_element_get_static_pad(encoder, "src");
    gst_pad_add_probe(
        pad,
        static_cast<GstPadProbeType>(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_EVENT_UPSTREAM),
        recovery_probe, nullptr, nullptr);
    gst_object_unref(pad);
    gst_object_unref(encoder);
}
static bool inject(INPUT &input) { return SendInput(1, &input, sizeof(input)) == 1; }
static void key_input(WORD vk, bool down) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
    input.ki.wScan = static_cast<WORD>(scan & 0xFF);
    input.ki.dwFlags = KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP) |
                       ((scan & 0xFF00) ? KEYEVENTF_EXTENDEDKEY : 0);
    if (inject(input)) {
        if (down)
            held_keys.insert(vk);
        else
            held_keys.erase(vk);
    }
}
static void button_input(int button, bool down) {
    static const DWORD downs[] = {MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_MIDDLEDOWN,
                                  MOUSEEVENTF_RIGHTDOWN};
    static const DWORD ups[] = {MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP};
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = down ? downs[button] : ups[button];
    if (inject(input)) {
        if (down)
            held_buttons.insert(button);
        else
            held_buttons.erase(button);
    }
}
static void release_held() {
    auto keys = held_keys;
    auto buttons = held_buttons;
    for (auto key : keys)
        key_input(key, false);
    for (auto button : buttons)
        button_input(button, false);
}
static void fatal(const char *message);

// The sandboxed network process for this source, and the pipes to it (net-pipes.hpp). The
// worker trusts nothing it reads from them.
struct NetProcess {
    sandbox::Launched launched;
    net_pipes::Pipe control_to, control_from, frames, input;
    std::unique_ptr<net_pipes::QueuedWriter> control, frame_writer;
    bool ready = false;
};
static std::unique_ptr<NetProcess> net;
// Diagnostics for the watchdog below: when the main loop and media-net were last heard from,
// and what the frame path has done.
static std::atomic<gint64> main_loop_tick{0}, net_heard{0};
static std::atomic<unsigned> frames_sent{0}, frame_overflows{0};
static JsonObject *pending_ready = nullptr; // the `ready` reply, sent once media-net is up
// Posts to the main loop from a pipe thread, unless the worker is already shutting down.
static void fail_from_thread(const char *message) {
    if (shutdown_started)
        return;
    g_main_context_invoke(
        nullptr,
        [](gpointer text) -> gboolean {
            if (shutdown_started)
                return G_SOURCE_REMOVE;
            // Say how media-net ended: a crash code (for example 0xC0000005) points at the
            // cause, where "stopped" alone does not.
            if (net && net->launched.process && error_log.is_open()) {
                DWORD code = STILL_ACTIVE;
                WaitForSingleObject(net->launched.process.get(), 500);
                GetExitCodeProcess(net->launched.process.get(), &code);
                char hex[16];
                snprintf(hex, sizeof(hex), "0x%08lX", static_cast<unsigned long>(code));
                error_log << "NET " << static_cast<const char *>(text)
                          << " exit=" << (code == STILL_ACTIVE ? std::string("still running") : hex)
                          << std::endl;
            }
            fatal(static_cast<const char *>(text));
            return G_SOURCE_REMOVE;
        },
        const_cast<char *>(message));
}
// Commands to media-net. Small and rare, so a full queue means media-net stopped reading.
static void send_net(JsonObject *object) {
    if (!net || !net->control) {
        json_object_unref(object);
        return;
    }
    if (!net->control->push(object_text(object) + "\n"))
        fatal("The network process stopped accepting commands.");
}

// Held keys and buttons are OS state; only a peer that had control can have pressed them.
static void revoke_peer(Peer &peer, bool notify) {
    if (peer.control)
        release_held();
    peer.control = false;
    if (notify) {
        auto state = typed_object("control-state", {{"peerId", peer.id}});
        json_object_set_boolean_member(state, "control", FALSE);
        send_net(state);
    }
}
// Lost ping (5 s) or a missing/expired host lease ends a peer's control.
static void enforce_permission() {
    const auto now = g_get_monotonic_time();
    for (auto &entry : peers) {
        auto &peer = *entry.second;
        if (peer.control &&
            (now - peer.last_ping > 5 * G_USEC_PER_SEC ||
             (host_control_required && !peer_permission.allowed(peer.id, now / 1000))))
            revoke_peer(peer, true);
    }
}

static void write_object(JsonObject *object) {
    auto node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, object);
    auto text = json_to_string(node, false);
    std::cout << text << std::endl;
    g_free(text);
    json_node_free(node);
}
static void emit(const char *type,
                 std::initializer_list<std::pair<const char *, std::string>> fields = {}) {
    auto object = json_object_new();
    json_object_set_string_member(object, "type", type);
    for (const auto &field : fields)
        json_object_set_string_member(object, field.first, field.second.c_str());
    write_object(object);
}
static void fatal(const char *message) {
    std::cerr << message << std::endl;
    if (error_log.is_open())
        error_log << "FATAL " << message << std::endl;
    failed = true;
    if (loop)
        g_main_loop_quit(loop);
}
struct InputMessage {
    std::string peer, text;
};
// Data-channel input from media-net, exactly as a viewer sent it. This is the broker: the host
// lease, the peer's own control flag, the allow-lists and the rate limit all apply here, in the
// worker, whatever media-net claims.
static std::atomic<int> pending_input{0};
static gboolean input_message(gpointer data) {
    // Owned by the main-loop source: its destroy notify deletes it after this returns.
    const auto message = static_cast<InputMessage *>(data);
    --pending_input;
    const auto found = peers.find(message->peer);
    if (found == peers.end() || found->second->removing)
        return G_SOURCE_REMOVE;
    const auto peer = found->second.get();
    JsonParser *parser = nullptr;
    auto object = parse_object(message->text, &parser);
    if (object && !capture_display_current()) {
        release_held();
        fatal("Capture display changed. Reconnect.");
        g_object_unref(parser);
        return G_SOURCE_REMOVE;
    }
    if (object) {
        const auto allowed = [&] {
            return !host_control_required || peer_permission.allowed(peer->id, now_ms());
        };
        if (peer->control && !allowed())
            revoke_peer(*peer, false);
        std::string type = string_member(object, "type");
        if (type == "ping")
            peer->last_ping = g_get_monotonic_time();
        else if (type == "release")
            revoke_peer(*peer, false);
        else if (type == "control") {
            revoke_peer(*peer, false);
            peer->control = allowed() && boolean_member(object, "enabled");
            peer->last_ping = g_get_monotonic_time();
            if (peer->control)
                for (auto &entry : peers)
                    if (entry.second.get() != peer && entry.second->control)
                        revoke_peer(*entry.second, true);
        } else if (peer->control) {
            auto now = g_get_monotonic_time();
            if (now - peer->rate_window > G_USEC_PER_SEC) {
                peer->rate_window = now;
                peer->rate_count = 0;
            }
            if (++peer->rate_count > 1000)
                revoke_peer(*peer, false);
            else if (type == "move") {
                double x = number_member(object, "x"), y = number_member(object, "y");
                if (valid_point(x, y)) {
                    INPUT input{};
                    input.type = INPUT_MOUSE;
                    const auto bounds = capture_display
                                            ? capture_display->bounds
                                            : DesktopRect{0, 0, GetSystemMetrics(SM_CXSCREEN),
                                                          GetSystemMetrics(SM_CYSCREEN)};
                    if (auto point = desktop_point(x, y, bounds, virtual_desktop())) {
                        input.mi.dx = point->x;
                        input.mi.dy = point->y;
                        input.mi.dwFlags =
                            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
                        inject(input);
                    }
                }
            } else if (type == "key") {
                WORD vk = key_code(string_member(object, "code"));
                auto down = json_object_get_member(object, "down");
                if (vk && down && JSON_NODE_HOLDS_VALUE(down) &&
                    json_node_get_value_type(down) == G_TYPE_BOOLEAN)
                    key_input(vk, json_node_get_boolean(down));
            } else if (type == "button") {
                double button = number_member(object, "button");
                auto down = json_object_get_member(object, "down");
                if (std::isfinite(button) && button == std::floor(button) && button >= 0 &&
                    button <= 2 && down && JSON_NODE_HOLDS_VALUE(down) &&
                    json_node_get_value_type(down) == G_TYPE_BOOLEAN)
                    button_input(static_cast<int>(button), json_node_get_boolean(down));
            } else if (type == "wheel") {
                double delta = number_member(object, "delta");
                if (std::isfinite(delta) && std::abs(delta) <= 1200) {
                    INPUT input{};
                    input.type = INPUT_MOUSE;
                    input.mi.dwFlags = MOUSEEVENTF_WHEEL;
                    input.mi.mouseData = static_cast<DWORD>(static_cast<LONG>(delta));
                    inject(input);
                }
            }
        }
    }
    // The viewer learns its control state after every message, as before the split.
    auto state = typed_object("control-state", {{"peerId", peer->id}});
    json_object_set_boolean_member(state, "control", peer->control);
    send_net(state);
    if (parser)
        g_object_unref(parser);
    return G_SOURCE_REMOVE;
}
// Input records from media-net. A malformed record means media-net is broken or hostile: the
// source ends.
static void read_input(HANDLE handle) {
    unsigned char header[4];
    while (net_pipes::read_exact(handle, header, sizeof(header))) {
        const auto sizes = net_records::decode_input_header(header);
        if (!sizes)
            return fail_from_thread("The network process sent a malformed input record.");
        std::string peer(sizes->peer, '\0'), text(sizes->text, '\0');
        if (!net_pipes::read_exact(handle, peer.data(), peer.size()) ||
            !net_pipes::read_exact(handle, text.data(), text.size()))
            break;
        if (!net_records::valid_peer_id(peer))
            return fail_from_thread("The network process sent a malformed input record.");
        // The same bound the data channel had: at most 256 messages per viewer in flight,
        // counted here across this source's viewers.
        if (++pending_input > 256 * 8) {
            --pending_input;
            continue;
        }
        g_main_context_invoke_full(
            nullptr, G_PRIORITY_DEFAULT, input_message,
            new InputMessage{std::move(peer), std::move(text)},
            [](gpointer message) { delete static_cast<InputMessage *>(message); });
    }
    fail_from_thread("The network process stopped.");
}

static std::string pipeline_description(int frames = -1) {
    const auto target =
        capture_display ? "monitor-handle=" +
                              std::to_string(reinterpret_cast<uintptr_t>(capture_display->handle))
                        : "monitor-index=-1";
    const bool h264 = video_codec->id == "h264";
    const auto element = encoder_element(*encoder_backend, video_codec->id);
    const auto encoder = encoder_properties(*encoder_backend, element, video_codec->id,
                                            rate_control(video_codec->id, profile));
    if (error_log.is_open())
        for (const auto &name : encoder.skipped)
            error_log << "ENCODER " << element << " has no property " << name << std::endl;
    return "d3d11screencapturesrc name=capture " + target +
           " show-cursor=true num-buffers=" + std::to_string(frames) +
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
static std::string audio_source_description() {
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
static bool capture_adapter_luid(std::int64_t &out) {
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
        if (error_log.is_open())
            error_log << "BACKEND " << backend.id << " " << codec.id
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
    if (message && !ok && error_log.is_open()) {
        GError *failure = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_error(message, &failure, &debug);
        error_log << "BACKEND " << backend.id << " " << codec.id
                  << " self-test failed: " << (failure ? failure->message : "unknown") << std::endl;
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

struct BackendAvailability {
    const EncoderBackend *backend;
    std::vector<std::string> codecs;
    bool on_capture_adapter;
};

// The whole matrix. Only --probe needs this; a stream asks about one codec.
static std::vector<BackendAvailability> available_backends() {
    std::vector<BackendAvailability> result;
    std::int64_t capture_luid = 0;
    const bool capture_known = capture_adapter_luid(capture_luid);
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

static bool backend_offers(const BackendAvailability &entry, const std::string &codec_id) {
    return std::find(entry.codecs.begin(), entry.codecs.end(), codec_id) != entry.codecs.end();
}

static Selection encoder_selection_for(const std::string &codec_id) {
    const auto *codec = find_video_codec(codec_id);
    if (!codec)
        return {false, {}, SelectionReason::FixedOrder};
    std::vector<EncoderCandidate> candidates;
    std::int64_t capture_luid = 0;
    const bool capture_known = capture_adapter_luid(capture_luid);
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

static void preflight() {
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

static void count_frame(GstElement *sink, GstBuffer *, GstPad *, gpointer data) {
    ++*static_cast<int *>(data);
    if (profile.fps == 15 && *static_cast<int *>(data) == 5) {
        auto parent = GST_ELEMENT(gst_object_get_parent(GST_OBJECT(sink)));
        request_keyframe(parent);
        gst_object_unref(parent);
    }
}

static int self_test() {
    GError *error = nullptr;
    auto pipe = gst_parse_launch(
        (pipeline_description(60) + " ! fakesink name=counter signal-handoffs=true").c_str(),
        &error);
    if (error) {
        std::string message = error->message;
        g_error_free(error);
        if (pipe)
            gst_object_unref(pipe);
        throw std::runtime_error(message);
    }
    int frames = 0;
    telemetry.attach(pipe);
    attach_recovery(pipe);
    auto counter = gst_bin_get_by_name(GST_BIN(pipe), "counter");
    g_signal_connect(counter, "handoff", G_CALLBACK(count_frame), &frames);
    gst_object_unref(counter);
    auto bus = gst_element_get_bus(pipe);
    gst_element_set_state(pipe, GST_STATE_PLAYING);
    auto message = gst_bus_timed_pop_filtered(
        bus, 15 * GST_SECOND, static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_EOS));
    std::string failure;
    if (!message)
        failure = "Capture/encode timed out.";
    else if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        gchar *debug = nullptr;
        gst_message_parse_error(message, &error, &debug);
        failure = error->message;
        g_error_free(error);
        g_free(debug);
    }
    gst_element_set_state(pipe, GST_STATE_NULL);
    if (message)
        gst_message_unref(message);
    gst_object_unref(bus);
    gst_object_unref(pipe);
    if (!failure.empty())
        throw std::runtime_error(failure);
    auto result = json_object_new();
    json_object_set_int_member(result, "frames", frames);
    json_object_set_int_member(result, "keyframes", keyframes.load());
    json_object_set_int_member(result, "forceEvents", force_events.load());
    json_object_set_int_member(result, "spsProfile", sps_profile.load());
    json_object_set_int_member(result, "spsLevel", sps_level.load());
    json_object_set_string_member(result, "codec", video_codec->id.c_str());
    json_object_set_string_member(result, "bitrateMode", bitrate_mode_name(profile.bitrate_mode));
    json_object_set_string_member(result, "quality", quality_name(profile.quality));
    json_object_set_object_member(result, "metrics", telemetry.snapshot());
    auto node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, result);
    auto text = json_to_string(node, false);
    std::cout << text << std::endl;
    g_free(text);
    json_node_free(node);
    return frames == 60 ? 0 : 1;
}

// Every element in this pipeline is shared by the whole source, so any error ends it. Viewer
// transport errors happen in media-net and fail only that viewer there.
static gboolean bus_message(GstBus *, GstMessage *message, gpointer) {
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_QOS)
        telemetry.qos(message);
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *error = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_error(message, &error, &debug);
        const std::string detail =
            "GSTREAMER ERROR source=" + std::string(GST_OBJECT_NAME(message->src)) +
            " message=" + (error ? error->message : "unknown") +
            " debug=" + (debug ? debug : "none");
        // Keep the actionable GStreamer diagnostic on stderr as well as the native-worker log.
        // The server persists child stderr in server.log for the desktop host, so a transient
        // encoder/session failure is diagnosable without needing a second log file.
        std::cerr << detail << std::endl;
        if (error_log.is_open())
            error_log << detail << std::endl;
        fatal(error ? error->message : "GStreamer error");
        if (error)
            g_error_free(error);
        g_free(debug);
    }
    return G_SOURCE_CONTINUE;
}

// ---- Encoded frames to media-net.
//
// One queue for video and audio, bounded at 32 MiB. When media-net falls that far behind, the
// queue is emptied, video skips to the next keyframe (and asks for one), and caps are sent
// again, so a stall costs picture but never blocks capture or the owner pipe.
constexpr std::size_t frame_queue_bytes = 32u << 20;
struct FrameSink {
    net_records::FrameKind buffer_kind, caps_kind;
    std::string sent_caps;
    bool skipping = false; // video only: dropping until the next keyframe
};
static FrameSink video_sink_state{net_records::FrameKind::VideoBuffer,
                                  net_records::FrameKind::VideoCaps};
static FrameSink audio_sink_state{net_records::FrameKind::AudioBuffer,
                                  net_records::FrameKind::AudioCaps};
static std::mutex frame_mutex;
static gboolean recovery_keyframe(gpointer) {
    if (video_enabled && pipeline && keyframe_limiter.recovery(now_ms()))
        request_keyframe(pipeline);
    return G_SOURCE_REMOVE;
}
static void frames_overflowed() {
    ++frame_overflows;
    net->frame_writer->clear();
    video_sink_state.sent_caps.clear();
    audio_sink_state.sent_caps.clear();
    video_sink_state.skipping = video_enabled;
    if (error_log.is_open())
        error_log << "FRAMES the network process fell behind; skipping to a keyframe" << std::endl;
    g_main_context_invoke(nullptr, recovery_keyframe, nullptr);
}
static GstFlowReturn new_sample(GstAppSink *sink, gpointer data) {
    auto &state = *static_cast<FrameSink *>(data);
    auto sample = gst_app_sink_pull_sample(sink);
    if (!sample)
        return GST_FLOW_EOS;
    const auto buffer = gst_sample_get_buffer(sample);
    const auto caps = gst_sample_get_caps(sample);
    std::lock_guard<std::mutex> lock(frame_mutex);
    if (!buffer || !caps || !net || !net->frame_writer) {
        gst_sample_unref(sample);
        return GST_FLOW_OK;
    }
    const bool delta = GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
    if (state.skipping && delta) {
        gst_sample_unref(sample);
        return GST_FLOW_OK;
    }
    state.skipping = false;
    bool queued = true;
    gchar *caps_text = gst_caps_to_string(caps);
    if (state.sent_caps != caps_text) {
        net_records::FrameHeader header{state.caps_kind, 0,
                                        static_cast<std::uint32_t>(strlen(caps_text)), 0};
        queued = header.length <= net_records::max_caps_bytes &&
                 net->frame_writer->push(net_records::encode_frame(header, caps_text));
        if (queued)
            state.sent_caps = caps_text;
    }
    g_free(caps_text);
    GstMapInfo map{};
    if (queued && gst_buffer_map(buffer, &map, GST_MAP_READ)) {
        if (map.size <= net_records::max_frame_bytes) {
            net_records::FrameHeader header{
                state.buffer_kind, static_cast<std::uint8_t>(delta ? net_records::flag_delta : 0),
                static_cast<std::uint32_t>(map.size),
                GST_BUFFER_DURATION_IS_VALID(buffer) ? GST_BUFFER_DURATION(buffer) : 0};
            queued = net->frame_writer->push(net_records::encode_frame(header, map.data));
            if (queued)
                ++frames_sent;
        }
        gst_buffer_unmap(buffer, &map);
    }
    if (!queued)
        frames_overflowed();
    gst_sample_unref(sample);
    return GST_FLOW_OK;
}
static void attach_sink(const char *name, FrameSink &state) {
    auto sink = gst_bin_get_by_name(GST_BIN(pipeline), name);
    if (!sink)
        return;
    GstAppSinkCallbacks callbacks{};
    callbacks.new_sample = new_sample;
    gst_app_sink_set_callbacks(GST_APP_SINK(sink), &callbacks, &state, nullptr);
    gst_object_unref(sink);
}

// ---- Viewers. The worker keeps the broker's view of each one and forwards the rest.
//
// The server sends a viewer's add-peer right after start, without waiting for `ready`, so
// viewers that arrive while media-net is still starting wait here, in order.
static std::vector<std::pair<std::string, std::string>> waiting_peers;
static bool waiting(const std::string &id) {
    return std::any_of(waiting_peers.begin(), waiting_peers.end(),
                       [&](const auto &entry) { return entry.first == id; });
}
static void add_peer(const std::string &id, const std::string &sdp) {
    const auto refuse = [&](const char *reason) {
        emit("peer-failed", {{"peerId", id}, {"reason", reason}});
    };
    if (!pipeline || !net)
        return refuse("Source not started.");
    if (peers.count(id) || waiting(id))
        return refuse("Duplicate peer.");
    if (!net->ready) {
        if (waiting_peers.size() >= 64)
            return refuse("Too many viewers waiting.");
        waiting_peers.emplace_back(id, sdp);
        return;
    }
    if (!net_records::valid_peer_id(id))
        return refuse("Invalid peer id.");
    auto peer = std::make_unique<Peer>();
    peer->id = id;
    peers.emplace(id, std::move(peer));
    send_net(typed_object("add-peer", {{"peerId", id}, {"sdp", sdp}}));
}
static void remove_peer(const std::string &id, bool notify) {
    if (waiting(id)) {
        waiting_peers.erase(std::remove_if(waiting_peers.begin(), waiting_peers.end(),
                                           [&](const auto &entry) { return entry.first == id; }),
                            waiting_peers.end());
        if (notify)
            emit("peer-closed", {{"peerId", id}});
        return;
    }
    const auto found = peers.find(id);
    if (found == peers.end()) {
        if (notify)
            emit("peer-closed", {{"peerId", id}});
        return;
    }
    auto &peer = *found->second;
    peer.notify_closed = peer.notify_closed || notify;
    if (peer.removing)
        return;
    peer_permission.revoke(peer.id);
    revoke_peer(peer, true);
    peer.removing = true;
    send_net(typed_object("remove-peer", {{"peerId", id}}));
}

// A message from media-net, on the main loop. Everything is checked: known peer ids only, the
// expected types and sizes; anything else ends the source.
static gboolean net_message(gpointer data) {
    std::unique_ptr<std::string> text(static_cast<std::string *>(data));
    if (shutdown_started || !net)
        return G_SOURCE_REMOVE;
    JsonParser *parser = nullptr;
    const auto object = parse_object(*text, &parser);
    const std::string type = object ? string_member(object, "type") : "";
    const std::string peer_id = object ? string_member(object, "peerId") : "";
    const auto found = peers.find(peer_id);
    Peer *const peer = found != peers.end() ? found->second.get() : nullptr;
    const auto bounded = [&](const char *name, std::size_t limit) {
        const std::string value = string_member(object, name);
        return value.substr(0, limit);
    };
    if (type == "net-ready") {
        if (net->ready) {
            fatal("The network process reported ready twice.");
            if (parser)
                g_object_unref(parser);
            return G_SOURCE_REMOVE;
        }
        net->ready = true;
        if (error_log.is_open())
            error_log << "NET ready tier=" << bounded("tier", 8)
                      << " codeGuard=" << bounded("codeGuard", 8) << std::endl;
        if (pending_ready) {
            write_object(pending_ready);
            pending_ready = nullptr;
        }
        for (auto &[id, sdp] : std::exchange(waiting_peers, {}))
            add_peer(id, sdp);
    } else if (type == "answer") {
        const std::string sdp = string_member(object, "sdp");
        if (peer && !peer->removing && !peer->answered && !sdp.empty() && sdp.size() <= 65536) {
            peer->answered = true;
            // Passed to the server unparsed; the server validates it (sdp-candidates.mjs).
            emit("answer", {{"peerId", peer->id}, {"sdp", sdp}});
            if (!playing) {
                // Nothing is captured or encoded until the first viewer is accepted.
                playing = true;
                gst_element_set_state(pipeline, GST_STATE_PLAYING);
            }
        }
    } else if (type == "peer-failed") {
        if (peer && !peer->removing) {
            const auto reason = bounded("reason", 256);
            if (error_log.is_open())
                error_log << "PEER FAILED id=" << peer->id << " reason=" << reason << std::endl;
            peer_permission.revoke(peer->id);
            revoke_peer(*peer, false);
            emit("peer-failed", {{"peerId", peer->id}, {"reason", reason}});
            peers.erase(found);
        }
    } else if (type == "peer-closed") {
        if (peer) {
            if (peer->control)
                release_held();
            const bool notify = peer->notify_closed;
            const auto id = peer->id;
            peers.erase(found);
            if (notify)
                emit("peer-closed", {{"peerId", id}});
        }
    } else if (type == "channel-closed") {
        if (peer)
            revoke_peer(*peer, false);
    } else if (type == "keyframe-request") {
        const std::string kind = string_member(object, "kind");
        if (video_enabled && pipeline &&
            (kind == "join" ? keyframe_limiter.join(now_ms())
                            : kind == "recovery" && keyframe_limiter.recovery(now_ms())))
            request_keyframe(pipeline);
    } else if (type == "peer-metrics") {
        auto rows = json_object_get_member(object, "peers");
        if (rows && JSON_NODE_HOLDS_OBJECT(rows)) {
            auto members = json_object_get_members(json_node_get_object(rows));
            for (auto item = members; item; item = item->next) {
                const auto name = static_cast<const char *>(item->data);
                auto row = json_object_get_member(json_node_get_object(rows), name);
                const auto target = peers.find(name);
                if (target == peers.end() || !row || !JSON_NODE_HOLDS_OBJECT(row))
                    continue;
                if (target->second->transport)
                    json_object_unref(target->second->transport);
                target->second->transport = json_object_ref(json_node_get_object(row));
            }
            g_list_free(members);
        }
    } else if (type == "log") {
        if (error_log.is_open()) {
            auto line = bounded("text", 2048);
            std::replace(line.begin(), line.end(), '\n', ' ');
            std::replace(line.begin(), line.end(), '\r', ' ');
            error_log << "NET " << line << std::endl;
        }
    } else if (type == "fatal") {
        const auto reason = "Network process failed: " + bounded("reason", 256);
        if (error_log.is_open())
            error_log << reason << std::endl;
        fatal("The network process failed.");
    } else
        fatal("The network process sent an invalid message.");
    if (parser)
        g_object_unref(parser);
    return G_SOURCE_REMOVE;
}

// Starts media-net under the tier T1 sandbox with its four pipe ends, and the threads that
// serve them. Returns false after reporting why.
static bool start_network() {
    net = std::make_unique<NetProcess>();
    if (!net_pipes::make_pipe(net->control_to, true) ||
        !net_pipes::make_pipe(net->control_from, false) ||
        !net_pipes::make_pipe(net->frames, true, 4u << 20) ||
        !net_pipes::make_pipe(net->input, false)) {
        fatal("Unable to create the pipes to the network process.");
        return false;
    }
    wchar_t executable[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) {
        fatal("Unable to find the media worker executable.");
        return false;
    }
    const auto handle_text = [](const sandbox::Handle &handle) {
        return std::to_wstring(reinterpret_cast<ULONG_PTR>(handle.get()));
    };
    const std::wstring command_line =
        L"\"" + std::wstring(executable) + L"\" --network " + handle_text(net->control_to.child) +
        L" " + handle_text(net->control_from.child) + L" " + handle_text(net->frames.child) + L" " +
        handle_text(net->input.child);
    // media-net must never rebuild the plugin registry: that would start gst-plugin-scanner,
    // which its job forbids.
    SetEnvironmentVariableW(L"GST_REGISTRY_UPDATE", L"no");
    SetEnvironmentVariableW(L"GST_REGISTRY_FORK", L"no");
    // Standard handles: without them, Windows copies the worker's handle values into media-net,
    // where they are invalid, and strict handle checks turn the first write to stderr (a GLib
    // warning, say) into a crash. The NUL device gives it real ones that go nowhere.
    SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
    sandbox::Handle null_device(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
                                            FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable,
                                            OPEN_EXISTING, 0, nullptr));
    if (!null_device) {
        fatal("Unable to open the null device for the network process.");
        return false;
    }
    sandbox::Options options;
    options.std_input = options.std_output = options.std_error = null_device.get();
    const auto launched =
        sandbox::launch(executable, command_line,
                        {net->control_to.child.get(), net->control_from.child.get(),
                         net->frames.child.get(), net->input.child.get(), null_device.get()},
                        net->launched, options);
    null_device.reset();
    // media-net has its ends now (or never will); the worker keeps only its own.
    net->control_to.child.reset();
    net->control_from.child.reset();
    net->frames.child.reset();
    net->input.child.reset();
    if (!launched.ok) {
        if (error_log.is_open())
            error_log << "NET launch failed: " << launched.error << std::endl;
        const auto message = "Unable to start the sandboxed network process: " + launched.error;
        fatal(message.c_str());
        return false;
    }
    net->control =
        std::make_unique<net_pipes::QueuedWriter>(net->control_to.parent.get(), 4u << 20, [] {
            fail_from_thread("The network process stopped.");
        });
    net->frame_writer =
        std::make_unique<net_pipes::QueuedWriter>(net->frames.parent.get(), frame_queue_bytes, [] {
            fail_from_thread("The network process stopped.");
        });
    const auto from = net->control_from.parent.get();
    std::thread([from] {
        const bool within_limits = net_pipes::read_lines(from, [](std::string line) {
            net_heard = now_ms();
            g_main_context_invoke(nullptr, net_message, new std::string(std::move(line)));
        });
        fail_from_thread(within_limits ? "The network process stopped."
                                       : "The network process sent an oversized message.");
    }).detach();
    std::thread(read_input, net->input.parent.get()).detach();
    // media-net loads GStreamer before it reports; it gets 20 seconds.
    g_timeout_add_seconds(
        20,
        [](gpointer) -> gboolean {
            if (net && !net->ready && !shutdown_started)
                fatal("The network process did not start.");
            return G_SOURCE_REMOVE;
        },
        nullptr);
    return true;
}
// Answer attestation (design, "Signaling changes", step 2): the loopback port in an answer
// from media-net must belong to this source's own media-net, per Windows' UDP table, so a
// compromised media-net cannot point the relay at another process's socket.
static bool port_owned(unsigned port) {
    if (!net || !net->launched.pid)
        return false;
    ULONG size = 0;
    GetExtendedUdpTable(nullptr, &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0);
    std::vector<unsigned char> buffer(size);
    if (!size || GetExtendedUdpTable(buffer.data(), &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID,
                                     0) != NO_ERROR)
        return false;
    const auto table = reinterpret_cast<const MIB_UDPTABLE_OWNER_PID *>(buffer.data());
    for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        const auto &row = table->table[i];
        if (row.dwLocalAddr == htonl(INADDR_LOOPBACK) &&
            ntohs(static_cast<u_short>(row.dwLocalPort)) == port)
            return row.dwOwningPid == net->launched.pid;
    }
    return false;
}
static void stop_network() {
    if (!net)
        return;
    // End media-net first, so a writer blocked on a full pipe returns, then join the writers.
    if (net->launched.process)
        TerminateProcess(net->launched.process.get(), 0);
    {
        std::lock_guard<std::mutex> lock(frame_mutex);
        if (net->frame_writer)
            net->frame_writer->close();
    }
    if (net->control)
        net->control->close();
}

static bool set_profile(JsonObject *object) {
    if (json_object_has_member(object, "streamPlan")) {
        auto node = json_object_get_member(object, "streamPlan");
        return node && JSON_NODE_HOLDS_OBJECT(node) &&
               parse_stream_profile(json_node_get_object(node), profile);
    }
    const char *name = string_member(object, "profile");
    if (g_strcmp0(name, "iphone-720p-test") == 0) {
        profile = {1280, 720, 15, 1000, 1200};
        return true;
    }
    if (g_strcmp0(name, "mobile") == 0)
        profile = {1280, 720, 15, 2000, 1200};
    else if (g_strcmp0(name, "balanced") == 0)
        profile = {1920, 1080, 30, 4000, 1200};
    else if (g_strcmp0(name, "low-bandwidth") == 0)
        profile = {960, 540, 15, 1000, 1200};
    else if (g_strcmp0(name, "desktop") == 0 || g_strcmp0(name, "") == 0)
        profile = {2560, 1440, 30, 6000, 1200};
    else
        return false;
    return true;
}
static bool set_display(JsonObject *object) {
    auto node = json_object_get_member(object, "display");
    // Standalone worker smoke tests retain primary capture. Server sessions always
    // supply an explicit authorized identity and expected physical bounds.
    if (!node)
        return true;
    if (!JSON_NODE_HOLDS_OBJECT(node))
        return false;
    auto requested = json_node_get_object(node);
    try {
        for (const auto &display : enumerate_displays()) {
            if (display.id != string_member(requested, "id"))
                continue;
            if (number_member(requested, "x") != display.bounds.x ||
                number_member(requested, "y") != display.bounds.y ||
                number_member(requested, "width") != display.bounds.width ||
                number_member(requested, "height") != display.bounds.height ||
                number_member(requested, "rotation") != display.rotation)
                return false;
            capture_display = display;
            return true;
        }
    } catch (...) {
    }
    return false;
}
static void start_source(JsonObject *object) {
    if (started)
        return fatal("Source already started");
    started = true;
    video_enabled = boolean_member(object, "video");
    // Input comes from the sandboxed media-net, so the owner's lease is not optional: without
    // it nothing would stop media-net from taking control on its own.
    host_control_required = boolean_member(object, "hostControl");
    if (!host_control_required)
        return fatal("hostControl is required");
    const std::string format = string_member(object, "audioFormat");
    audio_channels = format == "mono-32k" ? 1 : format == "stereo-96k" ? 2 : 0;
    if (!format.empty() && !audio_channels)
        return fatal("Invalid audio format");
    if (!video_enabled && !audio_channels)
        return fatal("Audio sources require an audio format");
    if (video_enabled && !set_profile(object))
        return fatal("Invalid stream profile");
    if (video_enabled && !set_display(object))
        return fatal("Selected display is unavailable or changed");
    if (video_enabled) {
        const std::string codec_id = string_member(object, "codec");
        video_codec = codec_id.empty() ? &video_codecs()[0] : find_video_codec(codec_id);
        if (!video_codec)
            return fatal("Invalid video codec");
        // The display is already resolved above, so the capture adapter is known here and
        // affinity can be applied. Selection happens once and holds for the whole session.
        const std::string requested = string_member(object, "encoderBackend");
        forced_backend = requested.empty() ? "auto" : requested;
        const auto chosen = encoder_selection_for(video_codec->id);
        if (!chosen.found) {
            const std::string message = "No hardware encoder available for " + video_codec->id;
            return fatal(message.c_str());
        }
        encoder_backend = find_encoder_backend(chosen.candidate.backend_id);
        selection_reason = chosen.reason;
        if (error_log.is_open())
            error_log << "ENCODER " << chosen.candidate.element_name << " backend "
                      << chosen.candidate.backend_id << " reason "
                      << static_cast<int>(chosen.reason) << std::endl;
    }
    std::string description;
    if (video_enabled)
        description = pipeline_description() + " ! appsink name=video-sink sync=false async=false";
    if (audio_channels)
        description += (description.empty() ? "" : "  ") + audio_source_description();
    if (error_log.is_open())
        error_log << "SOURCE " << description << std::endl;
    GError *error = nullptr;
    pipeline = gst_parse_launch(description.c_str(), &error);
    if (error || !pipeline) {
        fatal(error ? error->message : "Unable to create the shared source.");
        if (error)
            g_error_free(error);
        return;
    }
    if (video_enabled) {
        telemetry.attach(pipeline);
        attach_recovery(pipeline);
    }
    audio_telemetry.attach(pipeline);
    attach_sink("video-sink", video_sink_state);
    attach_sink("audio-sink", audio_sink_state);
    auto bus = gst_element_get_bus(pipeline);
    gst_bus_add_watch(bus, bus_message, nullptr);
    gst_object_unref(bus);
    // `ready` waits for media-net: until it is up, no viewer can be served.
    pending_ready =
        video_enabled
            ? typed_object("ready",
                           {{"encoderBackend", encoder_backend->id},
                            {"encoderLabel", encoder_backend->label},
                            {"encoder", encoder_element(*encoder_backend, video_codec->id)},
                            {"encoderReason", selection_reason_name(selection_reason)}})
            : typed_object("ready");
    if (!start_network())
        return;
    auto configuration = typed_object("configure");
    json_object_set_boolean_member(configuration, "video", video_enabled);
    json_object_set_int_member(configuration, "audioChannels", audio_channels);
    if (video_enabled) {
        json_object_set_string_member(configuration, "codec", video_codec->id.c_str());
        json_object_set_int_member(configuration, "fps", profile.fps);
        json_object_set_int_member(configuration, "mtu", profile.mtu);
    }
    send_net(configuration);
}
static gboolean command(gpointer data) {
    auto text = static_cast<std::string *>(data);
    JsonParser *parser = nullptr;
    auto object = parse_object(*text, &parser);
    if (!object)
        fatal("Invalid command JSON");
    else {
        std::string type = string_member(object, "type");
        const std::string peer_id = string_member(object, "peerId");
        const bool valid_peer = !peer_id.empty() && peer_id.size() <= 64;
        if (type == "start")
            start_source(object);
        else if (type == "add-peer" && valid_peer)
            add_peer(peer_id, string_member(object, "sdp"));
        else if (type == "remove-peer" && valid_peer)
            remove_peer(peer_id, true);
        else if (type == "control-permission") {
            auto allowed = json_object_get_member(object, "allowed");
            auto request = number_member(object, "requestId");
            auto duration = number_member(object, "leaseMs");
            if (!valid_peer || !allowed || !JSON_NODE_HOLDS_VALUE(allowed) ||
                json_node_get_value_type(allowed) != G_TYPE_BOOLEAN || !std::isfinite(request) ||
                request < 1 || request > 9007199254740991.0 || request != std::floor(request) ||
                !std::isfinite(duration) || duration < 1 || duration > 5000) {
                release_held();
                fatal("Invalid control permission");
            } else {
                const auto now = now_ms();
                const auto found = peers.find(peer_id);
                const bool known =
                    video_enabled && found != peers.end() && !found->second->removing;
                if (json_node_get_boolean(allowed))
                    peer_permission.grant(peer_id, known, now, static_cast<gint64>(duration));
                else {
                    peer_permission.revoke(peer_id);
                    if (found != peers.end())
                        revoke_peer(*found->second, true);
                }
                // Granting one peer ends control for every other peer of this source.
                enforce_permission();
                std::cout << "{\"type\":\"control-result\",\"requestId\":"
                          << static_cast<gint64>(request) << ",\"allowed\":"
                          << (peer_permission.allowed(peer_id, now) ? "true" : "false") << "}"
                          << std::endl;
            }
        } else if (type == "check-port") {
            const auto port = number_member(object, "port");
            const auto found = peers.find(peer_id);
            if (!valid_peer || !std::isfinite(port) || port != std::floor(port) || port < 1024 ||
                port > 65535)
                fatal("Invalid port check");
            else {
                const bool owned = found != peers.end() && !found->second->removing &&
                                   found->second->answered &&
                                   port_owned(static_cast<unsigned>(port));
                auto reply = typed_object("port-owned", {{"peerId", peer_id}});
                json_object_set_int_member(reply, "port", static_cast<gint64>(port));
                json_object_set_boolean_member(reply, "owned", owned);
                write_object(reply);
            }
        } else if (type == "stop")
            begin_shutdown();
        else if (type == "keyframe") {
            if (video_enabled && pipeline && keyframe_limiter.recovery(now_ms())) {
                bool accepted = request_keyframe(pipeline);
                if (error_log.is_open())
                    error_log << "RECOVERY force-key-unit accepted=" << accepted << std::endl;
            }
        } else
            fatal("Invalid command");
    }
    g_object_unref(parser);
    delete text;
    return G_SOURCE_REMOVE;
}
static int session() {
    loop = g_main_loop_new(nullptr, false);
    g_timeout_add(
        1000,
        [](gpointer) -> gboolean {
            main_loop_tick = now_ms();
            if (!capture_display_current()) {
                release_held();
                fatal("Capture display changed. Reconnect.");
                return G_SOURCE_REMOVE;
            }
            if (pipeline && !peers.empty()) {
                auto sample = telemetry.snapshot();
                audio_telemetry.merge(sample);
                json_object_set_string_member(sample, "type", "metrics");
                json_object_set_int_member(sample, "forceKeyUnitEvents", force_events.load());
                json_object_set_int_member(sample, "encodedKeyframes", keyframes.load());
                json_object_set_int_member(sample, "spsProfile", sps_profile.load());
                json_object_set_int_member(sample, "spsLevel", sps_level.load());
                json_object_set_string_member(sample, "codec", video_codec->id.c_str());
                json_object_set_string_member(sample, "bitrateMode",
                                              bitrate_mode_name(profile.bitrate_mode));
                json_object_set_string_member(sample, "quality", quality_name(profile.quality));
                // Transport rows come from media-net once a second; the contract to the server
                // is unchanged.
                auto rows = json_object_new();
                for (auto &entry : peers) {
                    if (entry.second->removing)
                        continue;
                    json_object_set_object_member(rows, entry.first.c_str(),
                                                  entry.second->transport
                                                      ? json_object_ref(entry.second->transport)
                                                      : json_object_new());
                }
                json_object_set_object_member(sample, "peers", rows);
                write_object(sample);
            }
            enforce_permission();
            return G_SOURCE_CONTINUE;
        },
        nullptr);
    // Pipe ownership is the authorization boundary. The web server creates this
    // worker only after authentication; losing the owner always ends capture.
    std::thread([] {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.size() > 131072)
                break;
            g_main_context_invoke(nullptr, command, new std::string(line));
        }
        begin_shutdown();
    }).detach();
    // Watchdog, on its own thread and writing to stderr (the server copies it into its log),
    // so it reports even when the main loop is stuck.
    std::thread([] {
        for (;;) {
            Sleep(10000);
            if (shutdown_started)
                return;
            if (!net)
                continue;
            const auto now = now_ms();
            std::cerr << "media-worker status: main loop " << (now - main_loop_tick) / 1000.0
                      << " s ago; media-net heard " << (now - net_heard) / 1000.0
                      << " s ago; frames sent " << frames_sent << ", overflows " << frame_overflows
                      << ", queued " << (net->frame_writer ? net->frame_writer->queued() : 0)
                      << " bytes" << std::endl;
        }
    }).detach();
    g_main_loop_run(loop);
    shutdown_started = true;
    release_held();
    stop_network();
    if (pipeline)
        gst_element_set_state(pipeline, GST_STATE_NULL);
    peers.clear();
    if (pipeline)
        gst_object_unref(pipeline);
    // Process exit reclaims the stdin reader; it never owns capture resources.
    return failed ? 1 : 0;
}

int main(int argc, char **argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    g_set_print_handler([](const gchar *text) {
        std::cerr << text;
        if (error_log.is_open())
            error_log << text;
    });
    g_set_printerr_handler([](const gchar *text) {
        std::cerr << text;
        if (error_log.is_open())
            error_log << text;
    });
    gst_init(&argc, &argv);
    // The sandboxed network process (media-net.cpp). It writes no files, so it never opens the
    // log, and it takes nothing from the environment but GStreamer's own settings.
    if (argc == 6 && std::string(argv[1]) == "--network") {
        HANDLE handles[4] = {};
        for (int i = 0; i < 4; ++i) {
            char *end = nullptr;
            const auto value = std::strtoull(argv[2 + i], &end, 10);
            if (!end || *end || !value)
                return 2;
            handles[i] = reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(value));
        }
        return network_main(handles[0], handles[1], handles[2], handles[3]);
    }
    if (const char *log_path = g_getenv("VIDVNC_NATIVE_LOG"))
        error_log.open(std::filesystem::u8path(log_path), std::ios::app);
    if (error_log.is_open())
        error_log << "START native worker" << std::endl;
    // media-net always gathers on 127.0.0.1 alone; the server still says so explicitly, and
    // anything else is refused rather than guessed at.
    if (const char *bind = g_getenv("VIDVNC_ICE_BIND"); bind && std::string(bind) != "loopback") {
        std::cerr << "Invalid VIDVNC_ICE_BIND" << std::endl;
        return 2;
    }
    try {
        if (argc == 2 && std::string(argv[1]) == "--list-displays") {
            auto root = json_node_new(JSON_NODE_ARRAY);
            json_node_take_array(root, display_inventory_json(enumerate_displays()));
            auto text = json_to_string(root, false);
            std::cout << text << std::endl;
            g_free(text);
            json_node_free(root);
            return 0;
        }
        preflight();
        if (argc == 2 && std::string(argv[1]) == "--probe") {
            auto object = json_object_new();
            json_object_set_int_member(object, "width", GetSystemMetrics(SM_CXSCREEN));
            json_object_set_int_member(object, "height", GetSystemMetrics(SM_CYSCREEN));
            json_object_set_string_member(object, "capture", "dxgi");
            // `codecs` keeps its meaning and shape: what this machine can encode with any
            // backend. `backends` is the detail the server needs to pick one.
            auto codecs = json_array_new();
            auto backends = json_array_new();
            for (const auto &codec : video_codecs()) {
                for (const auto &entry : available_backends())
                    if (backend_offers(entry, codec.id)) {
                        json_array_add_string_element(codecs, codec.id.c_str());
                        break;
                    }
            }
            for (const auto &entry : available_backends()) {
                auto backend_object = json_object_new();
                json_object_set_string_member(backend_object, "id", entry.backend->id.c_str());
                json_object_set_string_member(backend_object, "label",
                                              entry.backend->label.c_str());
                json_object_set_boolean_member(backend_object, "onCaptureAdapter",
                                               entry.on_capture_adapter);
                auto backend_codecs = json_array_new();
                auto minimums = json_object_new();
                for (const auto &codec_id : entry.codecs) {
                    json_array_add_string_element(backend_codecs, codec_id.c_str());
                    const auto minimum = encoder_minimum(*entry.backend, codec_id);
                    auto size = json_object_new();
                    json_object_set_int_member(size, "width", minimum.width);
                    json_object_set_int_member(size, "height", minimum.height);
                    json_object_set_object_member(minimums, codec_id.c_str(), size);
                }
                json_object_set_array_member(backend_object, "codecs", backend_codecs);
                json_object_set_object_member(backend_object, "minimums", minimums);
                json_array_add_object_element(backends, backend_object);
            }
            json_object_set_array_member(object, "codecs", codecs);
            json_object_set_array_member(object, "backends", backends);
            // The element selection would choose right now, for diagnostics only.
            const auto chosen = encoder_selection_for(video_codecs()[0].id);
            json_object_set_string_member(
                object, "encoder", chosen.found ? chosen.candidate.element_name.c_str() : "");
            json_object_set_array_member(object, "displays",
                                         display_inventory_json(enumerate_displays()));
            auto root = json_node_new(JSON_NODE_OBJECT);
            json_node_take_object(root, object);
            auto text = json_to_string(root, false);
            std::cout << text << std::endl;
            g_free(text);
            json_node_free(root);
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--self-test")
            return self_test();
        if (argc == 2 && std::string(argv[1]) == "--self-test-mobile") {
            profile = {1280, 720, 15, 2000, 1200};
            return self_test();
        }
        // Two arguments: a backend is named explicitly so every family can be exercised on a
        // machine that has more than one. There is no one-argument form.
        if (argc == 4 && std::string(argv[1]) == "--self-test-codec") {
            encoder_backend = find_encoder_backend(argv[2]);
            if (!encoder_backend)
                throw std::runtime_error("Invalid encoder backend");
            video_codec = find_video_codec(argv[3]);
            if (!video_codec)
                throw std::runtime_error("Invalid video codec");
            if (encoder_element(*encoder_backend, video_codec->id).empty())
                throw std::runtime_error("Backend " + encoder_backend->id + " has no encoder for " +
                                         video_codec->id);
            forced_backend = encoder_backend->id;
            profile = {1280, 720, 30, 4000, 1200};
            return self_test();
        }
        if (argc == 3 && std::string(argv[1]) == "--self-test-vbr") {
            video_codec = find_video_codec(argv[2]);
            if (!video_codec)
                throw std::runtime_error("Invalid video codec");
            profile = {2560, 1440, 30, 6000, 1200, BitrateMode::Vbr, Quality::Balanced};
            return self_test();
        }
        if (argc == 2 && std::string(argv[1]) == "--session")
            return session();
        throw std::runtime_error("Expected --probe, --self-test, --self-test-mobile, "
                                 "--self-test-codec <backend> <codec> or --self-test-vbr <codec>.");
    } catch (const std::exception &error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
