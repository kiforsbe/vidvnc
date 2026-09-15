#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <gst/gst.h>
#include <gst/webrtc/webrtc.h>
#include <gst/sdp/sdp.h>
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
#include <filesystem>
#include "input-policy.hpp"
#include "host-input-permission.hpp"
#include "display-inventory.hpp"
#include "stream-profile.hpp"
#include "telemetry.hpp"
#include "transport-telemetry.hpp"
static TransportTelemetry transport_telemetry;
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
static GstElement *peer = nullptr;
static bool failed = false;
static bool answered = false;
static bool audio_enabled = true;
static StreamProfile profile;
static bool control = false;
static bool video_enabled = true;
static bool host_control_required = false;
static HostInputPermission host_input_permission;
static std::set<WORD> held_keys;
static std::set<int> held_buttons;
static gint64 last_ping = 0;
static std::atomic<int> pending_input{0};
static GstWebRTCDataChannel *input_channel = nullptr;
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
static gint64 last_recovery = 0;
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
static void release_input() {
    auto keys = held_keys;
    auto buttons = held_buttons;
    for (auto key : keys)
        key_input(key, false);
    for (auto button : buttons)
        button_input(button, false);
    control = false;
}

static JsonObject *parse_object(const std::string &text, JsonParser **parser) {
    *parser = json_parser_new();
    if (!json_parser_load_from_data(*parser, text.c_str(), static_cast<gssize>(text.size()),
                                    nullptr))
        return nullptr;
    auto root = json_parser_get_root(*parser);
    return root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : nullptr;
}
static const char *string_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    return node && json_node_get_value_type(node) == G_TYPE_STRING ? json_node_get_string(node)
                                                                   : "";
}
static void output(const char *type, const char *field, const char *value) {
    auto object = json_object_new();
    json_object_set_string_member(object, "type", type);
    json_object_set_string_member(object, field, value);
    auto node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, object);
    auto text = json_to_string(node, false);
    std::cout << text << std::endl;
    g_free(text);
    json_node_free(node);
}
static void fatal(const char *message) {
    std::cerr << message << std::endl;
    if (error_log.is_open())
        error_log << "FATAL " << message << std::endl;
    failed = true;
    if (loop)
        g_main_loop_quit(loop);
}
static double number_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    if (!node || !JSON_NODE_HOLDS_VALUE(node))
        return NAN;
    auto type = json_node_get_value_type(node);
    return type == G_TYPE_DOUBLE || type == G_TYPE_INT64 ? json_node_get_double(node) : NAN;
}
static gboolean input_message(gpointer data) {
    --pending_input;
    auto text = static_cast<std::string *>(data);
    JsonParser *parser = nullptr;
    auto object = parse_object(*text, &parser);
    if (object && !capture_display_current()) {
        release_input();
        fatal("Capture display changed. Reconnect.");
        g_object_unref(parser);
        delete text;
        return G_SOURCE_REMOVE;
    }
    if (object) {
        if (host_control_required && !host_input_permission.allowed(g_get_monotonic_time() / 1000))
            release_input();
        std::string type = string_member(object, "type");
        if (type == "ping")
            last_ping = g_get_monotonic_time();
        else if (type == "release")
            release_input();
        else if (type == "control") {
            release_input();
            auto enabled = json_object_get_member(object, "enabled");
            control = (!host_control_required ||
                       host_input_permission.allowed(g_get_monotonic_time() / 1000)) &&
                      enabled && json_node_get_value_type(enabled) == G_TYPE_BOOLEAN &&
                      json_node_get_boolean(enabled);
            last_ping = g_get_monotonic_time();
        } else if (control) {
            static gint64 window = 0;
            static int count = 0;
            auto now = g_get_monotonic_time();
            if (now - window > G_USEC_PER_SEC) {
                window = now;
                count = 0;
            }
            if (++count > 1000)
                release_input();
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
                if (vk && down && json_node_get_value_type(down) == G_TYPE_BOOLEAN)
                    key_input(vk, json_node_get_boolean(down));
            } else if (type == "button") {
                double button = number_member(object, "button");
                auto down = json_object_get_member(object, "down");
                if (std::isfinite(button) && button == std::floor(button) && button >= 0 &&
                    button <= 2 && down && json_node_get_value_type(down) == G_TYPE_BOOLEAN)
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
    if (input_channel)
        gst_webrtc_data_channel_send_string(input_channel,
                                            control ? "{\"control\":true}" : "{\"control\":false}");
    g_object_unref(parser);
    delete text;
    return G_SOURCE_REMOVE;
}
static void channel_message(GstWebRTCDataChannel *, gchar *text, gpointer) {
    if (text && strlen(text) <= 1024) {
        if (++pending_input > 256) {
            --pending_input;
            return;
        }
        g_main_context_invoke(nullptr, input_message, new std::string(text));
    }
}
static void channel_closed(GstWebRTCDataChannel *, gpointer) {
    g_main_context_invoke(
        nullptr,
        [](gpointer) -> gboolean {
            release_input();
            return G_SOURCE_REMOVE;
        },
        nullptr);
}
static void channel_created(GstElement *, GstWebRTCDataChannel *channel, gpointer) {
    if (!video_enabled) {
        gst_webrtc_data_channel_close(channel);
        return;
    }
    gchar *label = nullptr;
    g_object_get(channel, "label", &label, nullptr);
    if (g_strcmp0(label, "input") == 0) {
        input_channel = GST_WEBRTC_DATA_CHANNEL(g_object_ref(channel));
        g_signal_connect(channel, "on-message-string", G_CALLBACK(channel_message), nullptr);
        g_signal_connect(channel, "on-close", G_CALLBACK(channel_closed), nullptr);
    } else
        gst_webrtc_data_channel_close(channel);
    g_free(label);
}

static std::string pipeline_description(int frames = -1) {
    const auto target =
        capture_display ? "monitor-handle=" +
                              std::to_string(reinterpret_cast<uintptr_t>(capture_display->handle))
                        : "monitor-index=-1";
    return "d3d11screencapturesrc name=capture " + target +
           " show-cursor=true num-buffers=" + std::to_string(frames) +
           " ! d3d11convert ! "
           "video/x-raw(memory:D3D11Memory),format=NV12,width=" +
           std::to_string(profile.width) + ",height=" + std::to_string(profile.height) +
           ",framerate=" + std::to_string(profile.fps) +
           "/1 ! "
           "nvd3d11h264enc name=encoder preset=p3 tune=ultra-low-latency "
           "rc-mode=cbr bitrate=" +
           std::to_string(profile.bitrate) + " gop-size=" + std::to_string(profile.fps) +
           " bframes=0 zerolatency=true "
           "repeat-sequence-header=true ! "
           "video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au" +
           std::string(profile.fps == 15 && profile.width <= 1280 && profile.height <= 720
                           ? ",level=(string)3.1"
                           : "") +
           " ! h264parse";
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
                             "nvd3d11h264enc",
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
    json_object_set_object_member(result, "metrics", telemetry.snapshot());
    auto node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, result);
    auto text = json_to_string(node, false);
    std::cout << text << std::endl;
    g_free(text);
    json_node_free(node);
    return frames == 60 ? 0 : 1;
}

static gboolean bus_message(GstBus *, GstMessage *message, gpointer) {
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_QOS)
        telemetry.qos(message);
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *error = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_error(message, &error, &debug);
        if (error_log.is_open())
            error_log << "GSTREAMER ERROR source=" << GST_OBJECT_NAME(message->src)
                      << " message=" << (error ? error->message : "unknown")
                      << " debug=" << (debug ? debug : "none") << std::endl;
        fatal(error->message);
        g_error_free(error);
        g_free(debug);
    }
    return G_SOURCE_CONTINUE;
}
static gboolean send_answer(gpointer) {
    if (answered || !peer)
        return G_SOURCE_REMOVE;
    GstWebRTCICEGatheringState state;
    g_object_get(peer, "ice-gathering-state", &state, nullptr);
    if (state != GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE)
        return G_SOURCE_REMOVE;
    GstWebRTCSessionDescription *description = nullptr;
    g_object_get(peer, "local-description", &description, nullptr);
    if (description) {
        auto text = gst_sdp_message_as_text(description->sdp);
        output("answer", "sdp", text);
        g_free(text);
        gst_webrtc_session_description_free(description);
        answered = true;
    }
    return G_SOURCE_REMOVE;
}
static void gathering_changed(GObject *, GParamSpec *, gpointer) {
    g_main_context_invoke(nullptr, send_answer, nullptr);
}
static void answer_created(GstPromise *promise, gpointer) {
    GstWebRTCSessionDescription *answer = nullptr;
    const auto reply = gst_promise_get_reply(promise);
    if (reply)
        gst_structure_get(reply, "answer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &answer, nullptr);
    gst_promise_unref(promise);
    if (!answer) {
        g_main_context_invoke(
            nullptr,
            [](gpointer) -> gboolean {
                fatal("Unable to create WebRTC answer.");
                return G_SOURCE_REMOVE;
            },
            nullptr);
        return;
    }
    auto set = gst_promise_new();
    g_signal_emit_by_name(peer, "set-local-description", answer, set);
    gst_promise_interrupt(set);
    gst_promise_unref(set);
    gst_webrtc_session_description_free(answer);
}
static void remote_set(GstPromise *promise, gpointer) {
    gst_promise_unref(promise);
    auto answer = gst_promise_new_with_change_func(answer_created, nullptr, nullptr);
    g_signal_emit_by_name(peer, "create-answer", nullptr, answer);
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
static void start_offer(const char *text, const char *audio_mode) {
    GstSDPMessage *sdp = nullptr;
    gst_sdp_message_new(&sdp);
    if (strlen(text) > 65536 ||
        gst_sdp_message_parse_buffer(reinterpret_cast<const guint8 *>(text),
                                     static_cast<guint>(strlen(text)), sdp) != GST_SDP_OK ||
        !gst_sdp_message_get_version(sdp) || gst_sdp_message_medias_len(sdp) < 1) {
        gst_sdp_message_free(sdp);
        fatal("Invalid SDP");
        return;
    }
    std::string payload, audio_payload;
    for (guint m = 0; m < gst_sdp_message_medias_len(sdp); ++m) {
        auto media = gst_sdp_message_get_media(sdp, m);
        if (g_strcmp0(gst_sdp_media_get_media(media), "video") == 0)
            for (guint a = 0; a < gst_sdp_media_attributes_len(media); ++a) {
                auto attribute = gst_sdp_media_get_attribute(media, a);
                if (g_strcmp0(attribute->key, "rtpmap") != 0 ||
                    !strstr(attribute->value, "H264/90000"))
                    continue;
                std::string candidate(attribute->value, strchr(attribute->value, ' '));
                for (guint f = 0; f < gst_sdp_media_attributes_len(media); ++f) {
                    auto fmtp = gst_sdp_media_get_attribute(media, f);
                    if (g_strcmp0(fmtp->key, "fmtp") == 0 &&
                        std::string(fmtp->value).rfind(candidate + " ", 0) == 0 &&
                        strstr(fmtp->value, "packetization-mode=1") &&
                        strstr(fmtp->value, "profile-level-id=42e0"))
                        payload = candidate;
                }
            }
        if (g_strcmp0(gst_sdp_media_get_media(media), "audio") == 0) {
            for (guint a = 0; a < gst_sdp_media_attributes_len(media); ++a) {
                auto attribute = gst_sdp_media_get_attribute(media, a);
                if (g_strcmp0(attribute->key, "rtpmap") == 0 &&
                    (strstr(attribute->value, " opus/48000/2") ||
                     strstr(attribute->value, " opus/48000"))) {
                    audio_payload = std::string(attribute->value, strchr(attribute->value, ' '));
                    break;
                }
            }
        }
    }
    if (video_enabled && payload.empty()) {
        gst_sdp_message_free(sdp);
        fatal("Browser must offer constrained-baseline H.264 with packetization-mode=1.");
        return;
    }
    GError *error = nullptr;
    audio_enabled = g_strcmp0(audio_mode, "off") != 0;
    if (audio_enabled && audio_payload.empty()) {
        gst_sdp_message_free(sdp);
        fatal("Browser must offer Opus audio or request audio off.");
        return;
    }
    std::string audio_branch =
        audio_enabled ? "wasapisrc name=audio-capture loopback=true low-latency=true ! "
                        "audioconvert ! audioresample ! "
                        "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=" +
                            std::to_string(profile.fps == 15 ? 1 : 2) +
                            " ! "
                            "opusenc name=audio-encoder bitrate=" +
                            std::to_string(profile.fps == 15 ? 32000 : 96000) +
                            " bitrate-type=cbr frame-size=20 inband-fec=true ! "
                            "rtpopuspay pt=" +
                            audio_payload + " mtu=" + std::to_string(profile.mtu) +
                            " ! queue max-size-time=100000000 max-size-buffers=5 leaky=downstream "
                            "! identity name=audio-output"
                      : "";
    // webrtcbin requires explicit SSRC on the payloader and in the outgoing RTP caps
    // during SDP answer creation. Without this, webrtcbin emits FID 0 <rtx-ssrc> and
    // attaches MSID only to the RTX repair stream, causing the browser to decode RTP
    // packets but fail to route frames to the MediaStreamTrack (video readyState remains 0).
    auto video_description =
        pipeline_description() + " ! rtph264pay mtu=" + std::to_string(profile.mtu) +
        " config-interval=-1 pt=" + payload +
        " aggregate-mode=" + (profile.fps == 15 ? "none" : "zero-latency") +
        " ssrc=10000001 ! "
        "application/x-rtp,media=video,encoding-name=H264,ssrc=(uint)10000001 ! "
        "identity name=video-output";
    if (error_log.is_open())
        error_log << "PIPELINE video=" << video_description
                  << " audio=" << (audio_enabled ? audio_branch : "off") << std::endl;
    auto video_bin = video_enabled
                         ? gst_parse_bin_from_description(video_description.c_str(), TRUE, &error)
                         : nullptr;
    if (error || (video_enabled && !video_bin)) {
        fatal(error ? error->message : "Unable to create video branch.");
        if (error)
            g_error_free(error);
        gst_sdp_message_free(sdp);
        return;
    }
    auto audio_bin = audio_enabled
                         ? gst_parse_bin_from_description(audio_branch.c_str(), TRUE, &error)
                         : nullptr;
    if (error || (audio_enabled && !audio_bin)) {
        fatal(error ? error->message : "Unable to create audio branch.");
        if (error)
            g_error_free(error);
        if (video_bin)
            gst_object_unref(video_bin);
        gst_sdp_message_free(sdp);
        return;
    }
    pipeline = gst_pipeline_new("vidvnc-pipeline");
    transport_telemetry.attach(pipeline);
    peer = gst_element_factory_make("webrtcbin", "peer");
    if (!pipeline || !peer) {
        fatal("Unable to create WebRTC pipeline.");
        if (video_bin)
            gst_object_unref(video_bin);
        if (audio_bin)
            gst_object_unref(audio_bin);
        gst_sdp_message_free(sdp);
        return;
    }
    g_object_set(peer, "bundle-policy", GST_WEBRTC_BUNDLE_POLICY_MAX_BUNDLE, "latency", 0, nullptr);
    g_signal_connect(peer, "on-new-transceiver",
                     G_CALLBACK(+[](GstElement *, GstWebRTCRTPTransceiver *transceiver, gpointer) {
                         g_object_set(transceiver, "do-nack", TRUE, nullptr);
                     }),
                     nullptr);
    if (video_bin)
        gst_bin_add(GST_BIN(pipeline), video_bin);
    gst_bin_add(GST_BIN(pipeline), peer);
    if (video_bin && !gst_element_link(video_bin, peer)) {
        fatal("Unable to link video to WebRTC.");
        gst_sdp_message_free(sdp);
        return;
    }
    if (audio_bin) {
        gst_bin_add(GST_BIN(pipeline), audio_bin);
        if (!gst_element_link(audio_bin, peer)) {
            fatal("Unable to link audio to WebRTC.");
            gst_sdp_message_free(sdp);
            return;
        }
    }
    if (video_enabled) {
        telemetry.attach(pipeline);
        attach_recovery(pipeline);
    }
    audio_telemetry.attach(pipeline);
    g_signal_connect(peer, "notify::ice-gathering-state", G_CALLBACK(gathering_changed), nullptr);
    g_signal_connect(peer, "on-data-channel", G_CALLBACK(channel_created), nullptr);
    auto bus = gst_element_get_bus(pipeline);
    gst_bus_add_watch(bus, bus_message, nullptr);
    gst_object_unref(bus);
    auto offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);
    gst_element_set_state(pipeline, GST_STATE_PLAYING);
    auto promise = gst_promise_new_with_change_func(remote_set, nullptr, nullptr);
    g_signal_emit_by_name(peer, "set-remote-description", offer, promise);
    gst_webrtc_session_description_free(offer);
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
static gboolean command(gpointer data) {
    auto text = static_cast<std::string *>(data);
    JsonParser *parser = nullptr;
    auto object = parse_object(*text, &parser);
    if (!object)
        fatal("Invalid command JSON");
    else {
        std::string type = string_member(object, "type");
        if (type == "offer" && !pipeline) {
            auto video = json_object_get_member(object, "video");
            video_enabled = !video || json_node_get_value_type(video) != G_TYPE_BOOLEAN ||
                            json_node_get_boolean(video);
            auto require_host = json_object_get_member(object, "hostControl");
            host_control_required = require_host &&
                                    json_node_get_value_type(require_host) == G_TYPE_BOOLEAN &&
                                    json_node_get_boolean(require_host);
            host_input_permission.revoke();
            if (!set_profile(object))
                fatal("Invalid stream profile");
            else if (video_enabled && !set_display(object))
                fatal("Selected display is unavailable or changed");
            else
                start_offer(string_member(object, "sdp"), string_member(object, "audio"));
        } else if (type == "control-permission") {
            auto allowed = json_object_get_member(object, "allowed");
            auto request = number_member(object, "requestId");
            auto duration = number_member(object, "leaseMs");
            if (!allowed || json_node_get_value_type(allowed) != G_TYPE_BOOLEAN ||
                !std::isfinite(request) || request < 1 || request > 9007199254740991.0 ||
                request != std::floor(request) || !std::isfinite(duration) || duration < 1 ||
                duration > 5000) {
                host_input_permission.revoke();
                release_input();
                fatal("Invalid control permission");
            } else {
                if (video_enabled && json_node_get_boolean(allowed))
                    host_input_permission.grant(g_get_monotonic_time() / 1000,
                                                static_cast<gint64>(duration));
                else {
                    host_input_permission.revoke();
                    release_input();
                    if (input_channel)
                        gst_webrtc_data_channel_send_string(input_channel, "{\"control\":false}");
                }
                std::cout << "{\"type\":\"control-result\",\"requestId\":"
                          << static_cast<gint64>(request) << ",\"allowed\":"
                          << (host_input_permission.allowed(g_get_monotonic_time() / 1000)
                                  ? "true"
                                  : "false")
                          << "}" << std::endl;
            }
        } else if (type == "stop")
            begin_shutdown();
        else if (type == "keyframe" && pipeline) {
            auto now = g_get_monotonic_time();
            if (now - last_recovery >= 2 * G_USEC_PER_SEC) {
                last_recovery = now;
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
            if (!capture_display_current()) {
                release_input();
                fatal("Capture display changed. Reconnect.");
                return G_SOURCE_REMOVE;
            }
            if (pipeline) {
                auto sample = telemetry.snapshot();
                audio_telemetry.merge(sample);
                json_object_set_string_member(sample, "type", "metrics");
                transport_telemetry.merge(pipeline, sample);
                json_object_set_int_member(sample, "forceKeyUnitEvents", force_events.load());
                json_object_set_int_member(sample, "encodedKeyframes", keyframes.load());
                json_object_set_int_member(sample, "spsProfile", sps_profile.load());
                json_object_set_int_member(sample, "spsLevel", sps_level.load());
                auto node = json_node_new(JSON_NODE_OBJECT);
                json_node_take_object(node, sample);
                auto text = json_to_string(node, false);
                std::cout << text << std::endl;
                g_free(text);
                json_node_free(node);
            }
            if (control && (g_get_monotonic_time() - last_ping > 5 * G_USEC_PER_SEC ||
                            (host_control_required &&
                             !host_input_permission.allowed(g_get_monotonic_time() / 1000))))
                release_input();
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
    g_main_loop_run(loop);
    release_input();
    if (pipeline)
        gst_element_set_state(pipeline, GST_STATE_NULL);
    if (input_channel)
        g_object_unref(input_channel);
    // peer is owned by pipeline; unref the parent once below.
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
    if (const char *log_path = g_getenv("VIDVNC_NATIVE_LOG"))
        error_log.open(std::filesystem::u8path(log_path), std::ios::app);
    if (error_log.is_open())
        error_log << "START native worker" << std::endl;
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
            json_object_set_string_member(object, "encoder", "nvd3d11h264enc");
            json_object_set_string_member(object, "capture", "dxgi");
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
        if (argc == 2 && std::string(argv[1]) == "--session")
            return session();
        throw std::runtime_error("Expected --probe or --self-test.");
    } catch (const std::exception &error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
