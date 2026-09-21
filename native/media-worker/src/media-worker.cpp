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
#include <algorithm>
#include <filesystem>
#include <memory>
#include <vector>
#include "input-policy.hpp"
#include "peer-permission.hpp"
#include "keyframe-limiter.hpp"
#include "video-codec.hpp"
#include "sdp-payload.hpp"
#include "display-inventory.hpp"
#include "stream-profile.hpp"
#include "rate-control.hpp"
#include "encoder-backend.hpp"
#include "encoder-properties.hpp"
#include "encoder-selection.hpp"
#include <dxgi.h>
#include "telemetry.hpp"
#include "transport-telemetry.hpp"
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
static bool host_control_required = false;
static PeerPermission peer_permission;
static KeyframeLimiter keyframe_limiter;
static std::set<WORD> held_keys;
static std::set<int> held_buttons;

// One viewer: leaky queue, payloader and webrtcbin inside a bin fed by the source tees.
struct Peer {
    std::string id;
    unsigned index = 0;
    GstElement *bin = nullptr;                                 // owned reference
    GstElement *webrtc = nullptr;                              // borrowed from bin
    GstPad *video_tee_pad = nullptr, *audio_tee_pad = nullptr; // owned request pads
    GstWebRTCDataChannel *input_channel = nullptr;             // owned reference
    bool answered = false, removing = false, notify_closed = false;
    int pending_unlinks = 0;
    bool control = false;
    gint64 last_ping = 0, rate_window = 0;
    int rate_count = 0;
    std::shared_ptr<std::atomic<int>> pending_input = std::make_shared<std::atomic<int>>(0);
    TransportTelemetry transport;
};
// GStreamer threads never touch a Peer. Callbacks carry a copy of this reference and look the
// peer up on the main loop; the index rejects callbacks for a removed peer whose id was reused.
struct PeerRef {
    std::string id;
    unsigned index;
    std::shared_ptr<std::atomic<int>> pending_input;
};
static std::map<std::string, std::unique_ptr<Peer>> peers;
static unsigned next_peer_index = 0;
static Peer *find_peer(const PeerRef &ref) {
    const auto found = peers.find(ref.id);
    return found != peers.end() && found->second->index == ref.index ? found->second.get()
                                                                     : nullptr;
}
static PeerRef *peer_ref(const Peer &peer) {
    return new PeerRef{peer.id, peer.index, peer.pending_input};
}
static void delete_ref(gpointer data) { delete static_cast<PeerRef *>(data); }
static void delete_closure_ref(gpointer data, GClosure *) { delete_ref(data); }
static gint64 now_ms() { return g_get_monotonic_time() / 1000; }
static void fail_peer(Peer &peer, const char *reason);
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
// GStreamer payloaders only produce payload types 96-127 and silently replace a lower `pt`, but
// browsers also number codecs 35-63 (Safari offers H.265 as 35). This probe on the payloader's
// src pad relabels the payload type everywhere webrtcbin and the browser see it: the caps event
// and caps query results (webrtcbin pairs the offer's m-line with a pad by intersecting caps,
// so a mismatch answers the m-line inactive) and every RTP header. No-op when they already match.
static GstCaps *with_payload_type(GstCaps *caps, guint8 pt) {
    auto result = gst_caps_copy(caps);
    for (guint i = 0; i < gst_caps_get_size(result); ++i)
        gst_structure_set(gst_caps_get_structure(result, i), "payload", G_TYPE_INT,
                          static_cast<gint>(pt), nullptr);
    return result;
}
static bool payload_type_differs(GstBuffer *buffer, guint8 pt) {
    guint8 second = 0;
    return gst_buffer_extract(buffer, 1, &second, 1) == 1 && (second & 0x7f) != pt;
}
static void set_payload_type(GstBuffer *buffer, guint8 pt) {
    guint8 second = 0;
    if (gst_buffer_extract(buffer, 1, &second, 1) != 1)
        return;
    second = static_cast<guint8>((second & 0x80) | pt);
    gst_buffer_fill(buffer, 1, &second, 1);
}
static GstPadProbeReturn payload_type_probe(GstPad *, GstPadProbeInfo *info, gpointer data) {
    const auto pt = static_cast<guint8>(GPOINTER_TO_UINT(data));
    if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
        auto buffer = GST_PAD_PROBE_INFO_BUFFER(info);
        if (payload_type_differs(buffer, pt)) {
            buffer = gst_buffer_make_writable(buffer);
            set_payload_type(buffer, pt);
            GST_PAD_PROBE_INFO_DATA(info) = buffer;
        }
    } else if (info->type & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        auto list = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        bool differs = false;
        for (guint i = 0; i < gst_buffer_list_length(list) && !differs; ++i)
            differs = payload_type_differs(gst_buffer_list_get(list, i), pt);
        if (differs) {
            list = gst_buffer_list_make_writable(list);
            for (guint i = 0; i < gst_buffer_list_length(list); ++i)
                set_payload_type(gst_buffer_list_get_writable(list, i), pt);
            GST_PAD_PROBE_INFO_DATA(info) = list;
        }
    } else if (info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) {
        const auto event = GST_PAD_PROBE_INFO_EVENT(info);
        if (GST_EVENT_TYPE(event) == GST_EVENT_CAPS) {
            GstCaps *caps = nullptr;
            gst_event_parse_caps(event, &caps);
            const auto relabelled = with_payload_type(caps, pt);
            GST_PAD_PROBE_INFO_DATA(info) = gst_event_new_caps(relabelled);
            gst_caps_unref(relabelled);
            gst_event_unref(event);
        }
    } else if ((info->type & GST_PAD_PROBE_TYPE_QUERY_UPSTREAM) &&
               (info->type & GST_PAD_PROBE_TYPE_PULL)) {
        // Answered caps queries from downstream (webrtcbin) only; the payloader's own queries
        // go downstream and keep its 96-127 view.
        const auto query = GST_PAD_PROBE_INFO_QUERY(info);
        if (GST_QUERY_TYPE(query) == GST_QUERY_CAPS) {
            GstCaps *result = nullptr;
            gst_query_parse_caps_result(query, &result);
            if (result && !gst_caps_is_any(result) && !gst_caps_is_empty(result)) {
                const auto relabelled = with_payload_type(result, pt);
                gst_query_set_caps_result(query, relabelled);
                gst_caps_unref(relabelled);
            }
        }
    }
    return GST_PAD_PROBE_OK;
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
// Held keys and buttons are OS state; only a peer that had control can have pressed them.
static void revoke_peer(Peer &peer, bool notify) {
    if (peer.control)
        release_held();
    peer.control = false;
    if (notify && peer.input_channel)
        gst_webrtc_data_channel_send_string(peer.input_channel, "{\"control\":false}");
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
static double number_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    if (!node || !JSON_NODE_HOLDS_VALUE(node))
        return NAN;
    auto type = json_node_get_value_type(node);
    return type == G_TYPE_DOUBLE || type == G_TYPE_INT64 ? json_node_get_double(node) : NAN;
}
static bool boolean_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    return node && JSON_NODE_HOLDS_VALUE(node) &&
           json_node_get_value_type(node) == G_TYPE_BOOLEAN && json_node_get_boolean(node);
}
struct InputMessage {
    PeerRef ref;
    std::string text;
};
static gboolean input_message(gpointer data) {
    auto &message = *static_cast<InputMessage *>(data);
    --*message.ref.pending_input;
    const auto peer = find_peer(message.ref);
    if (!peer || peer->removing)
        return G_SOURCE_REMOVE;
    JsonParser *parser = nullptr;
    auto object = parse_object(message.text, &parser);
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
    if (peer->input_channel)
        gst_webrtc_data_channel_send_string(
            peer->input_channel, peer->control ? "{\"control\":true}" : "{\"control\":false}");
    g_object_unref(parser);
    return G_SOURCE_REMOVE;
}
static void channel_message(GstWebRTCDataChannel *, gchar *text, gpointer data) {
    const auto &ref = *static_cast<PeerRef *>(data);
    if (!text || strlen(text) > 1024)
        return;
    if (++*ref.pending_input > 256) {
        --*ref.pending_input;
        return;
    }
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT, input_message, new InputMessage{ref, text},
        [](gpointer message) { delete static_cast<InputMessage *>(message); });
}
static void channel_closed(GstWebRTCDataChannel *, gpointer data) {
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer ref) -> gboolean {
            if (const auto peer = find_peer(*static_cast<PeerRef *>(ref)))
                revoke_peer(*peer, false);
            return G_SOURCE_REMOVE;
        },
        new PeerRef(*static_cast<PeerRef *>(data)), delete_ref);
}
struct ChannelAttach {
    PeerRef ref;
    GstWebRTCDataChannel *channel;
};
static void channel_created(GstElement *, GstWebRTCDataChannel *channel, gpointer data) {
    gchar *label = nullptr;
    g_object_get(channel, "label", &label, nullptr);
    const bool input = video_enabled && g_strcmp0(label, "input") == 0;
    g_free(label);
    if (!input) {
        gst_webrtc_data_channel_close(channel);
        return;
    }
    const auto &ref = *static_cast<PeerRef *>(data);
    // Queue the attach before connecting message handlers so replies always find the channel.
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer value) -> gboolean {
            auto &attach = *static_cast<ChannelAttach *>(value);
            const auto peer = find_peer(attach.ref);
            if (peer && !peer->removing && !peer->input_channel)
                std::swap(peer->input_channel, attach.channel);
            return G_SOURCE_REMOVE;
        },
        new ChannelAttach{ref, GST_WEBRTC_DATA_CHANNEL(g_object_ref(channel))},
        [](gpointer value) {
            auto attach = static_cast<ChannelAttach *>(value);
            if (attach->channel)
                g_object_unref(attach->channel);
            delete attach;
        });
    g_signal_connect_data(channel, "on-message-string", G_CALLBACK(channel_message),
                          new PeerRef(ref), delete_closure_ref, GConnectFlags(0));
    g_signal_connect_data(channel, "on-close", G_CALLBACK(channel_closed), new PeerRef(ref),
                          delete_closure_ref, GConnectFlags(0));
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
           "tee name=audio-fanout allow-not-linked=true";
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

static bool element_adapter_luid(const std::string &name, std::int64_t &out) {
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
    gst_element_set_state(pipe, GST_STATE_NULL);
    gst_object_unref(bus);
    gst_object_unref(pipe);
    return ok;
}

// Memoised per backend and codec, because every self-test is a real encode. Starting a stream
// then pays only for the codec it is about to use, and usually only until the first backend
// passes, rather than for the whole matrix.
static bool backend_supports(const EncoderBackend &backend, const VideoCodec &codec) {
    static std::map<std::string, bool> cache;
    const auto key = backend.id + "/" + codec.id;
    const auto cached = cache.find(key);
    if (cached != cache.end())
        return cached->second;
    static const auto adapters = enumerate_adapters();
    const auto element = encoder_element(backend, codec.id);
    bool supported = false;
    if (!element.empty()) {
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
        supported = present && backend_encodes(backend, codec, adapters);
    }
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
            if (capture_known && element_adapter_luid(element, luid) && luid == capture_luid)
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
        if (!backend_supports(backend, *codec))
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
    // disable, so at least one encoder family must deliver it. Which family does not matter.
    // This stops at the first family that works, so the common case costs one short encode.
    const auto *h264 = find_video_codec("h264");
    for (const auto &backend : encoder_backends())
        if (h264 && backend_supports(backend, *h264))
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

// Finds the viewer bin an element belongs to. `attached` is false for elements no longer inside
// the pipeline (a queued message from a peer that was already destroyed).
static Peer *peer_of(GstObject *object, bool &attached) {
    attached = false;
    for (auto current = object; current; current = GST_OBJECT_PARENT(current)) {
        for (auto &entry : peers)
            if (GST_OBJECT(entry.second->bin) == current) {
                attached = true;
                return entry.second.get();
            }
        if (current == GST_OBJECT(pipeline))
            attached = true;
    }
    return nullptr;
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
        // A viewer's transport failing must not end the shared capture for everyone else.
        bool attached = false;
        if (const auto peer = peer_of(message->src, attached))
            fail_peer(*peer, error ? error->message : "WebRTC peer error.");
        else if (attached)
            fatal(error ? error->message : "GStreamer error");
        if (error)
            g_error_free(error);
        g_free(debug);
    }
    return G_SOURCE_CONTINUE;
}
struct PeerTask {
    PeerRef ref;
    void (*run)(Peer &);
};
// Runs on the main loop; references to removed or removing peers are ignored.
static void on_main(const PeerRef &ref, void (*run)(Peer &)) {
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer data) -> gboolean {
            auto &task = *static_cast<PeerTask *>(data);
            if (const auto peer = find_peer(task.ref); peer && !peer->removing)
                task.run(*peer);
            return G_SOURCE_REMOVE;
        },
        new PeerTask{ref, run}, [](gpointer data) { delete static_cast<PeerTask *>(data); });
}
static void send_answer(Peer &peer) {
    if (peer.answered || peer.removing)
        return;
    GstWebRTCICEGatheringState state;
    g_object_get(peer.webrtc, "ice-gathering-state", &state, nullptr);
    if (state != GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE)
        return;
    GstWebRTCSessionDescription *description = nullptr;
    g_object_get(peer.webrtc, "local-description", &description, nullptr);
    if (!description)
        return;
    auto text = gst_sdp_message_as_text(description->sdp);
    emit("answer", {{"peerId", peer.id}, {"sdp", text}});
    g_free(text);
    gst_webrtc_session_description_free(description);
    peer.answered = true;
}
static void gathering_changed(GObject *, GParamSpec *, gpointer data) {
    on_main(*static_cast<PeerRef *>(data), send_answer);
}
static void connection_changed(GObject *, GParamSpec *, gpointer data) {
    on_main(*static_cast<PeerRef *>(data), [](Peer &peer) {
        GstWebRTCPeerConnectionState state;
        g_object_get(peer.webrtc, "connection-state", &state, nullptr);
        if (state == GST_WEBRTC_PEER_CONNECTION_STATE_FAILED)
            fail_peer(peer, "WebRTC connection failed.");
        // RTP sent before DTLS connects is dropped, so the join keyframe waits for connected.
        else if (state == GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTED && video_enabled &&
                 keyframe_limiter.join(now_ms()))
            request_keyframe(pipeline);
    });
}
struct AnswerResult {
    PeerRef ref;
    GstWebRTCSessionDescription *answer;
};
static void answer_created(GstPromise *promise, gpointer data) {
    auto result = new AnswerResult{*static_cast<PeerRef *>(data), nullptr};
    if (const auto reply = gst_promise_get_reply(promise))
        gst_structure_get(reply, "answer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &result->answer,
                          nullptr);
    gst_promise_unref(promise);
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer value) -> gboolean {
            auto &result = *static_cast<AnswerResult *>(value);
            const auto peer = find_peer(result.ref);
            if (!peer || peer->removing)
                return G_SOURCE_REMOVE;
            if (!result.answer) {
                fail_peer(*peer, "Unable to create WebRTC answer.");
                return G_SOURCE_REMOVE;
            }
            auto set = gst_promise_new();
            g_signal_emit_by_name(peer->webrtc, "set-local-description", result.answer, set);
            gst_promise_interrupt(set);
            gst_promise_unref(set);
            send_answer(*peer);
            return G_SOURCE_REMOVE;
        },
        result,
        [](gpointer value) {
            auto result = static_cast<AnswerResult *>(value);
            if (result->answer)
                gst_webrtc_session_description_free(result->answer);
            delete result;
        });
}
static void remote_set(GstPromise *promise, gpointer data) {
    const PeerRef ref = *static_cast<PeerRef *>(data); // copy: unref may free data
    gst_promise_unref(promise);
    on_main(ref, [](Peer &peer) {
        auto answer = gst_promise_new_with_change_func(answer_created, peer_ref(peer), delete_ref);
        g_signal_emit_by_name(peer.webrtc, "create-answer", nullptr, answer);
    });
}
static void destroy_peer(const std::string &id) {
    auto node = peers.extract(id);
    if (node.empty())
        return;
    auto &peer = *node.mapped();
    for (const auto &[name, pad] : std::initializer_list<std::pair<const char *, GstPad *>>{
             {"video-fanout", peer.video_tee_pad}, {"audio-fanout", peer.audio_tee_pad}}) {
        if (!pad)
            continue;
        auto tee = gst_bin_get_by_name(GST_BIN(pipeline), name);
        gst_element_release_request_pad(tee, pad);
        gst_object_unref(tee);
        gst_object_unref(pad);
    }
    if (peer.input_channel)
        g_object_unref(peer.input_channel);
    gst_element_set_state(peer.bin, GST_STATE_NULL);
    gst_bin_remove(GST_BIN(pipeline), peer.bin);
    gst_object_unref(peer.bin);
    if (peer.notify_closed)
        emit("peer-closed", {{"peerId", peer.id}});
}
static GstPadProbeReturn unlink_probe(GstPad *pad, GstPadProbeInfo *, gpointer data) {
    if (const auto target = gst_pad_get_peer(pad)) {
        gst_pad_unlink(pad, target);
        gst_object_unref(target);
    }
    // Never change element state from a streaming thread; g_idle_add also defers when the
    // probe fired synchronously inside remove_peer.
    g_idle_add_full(
        G_PRIORITY_DEFAULT,
        [](gpointer value) -> gboolean {
            const auto &ref = *static_cast<PeerRef *>(value);
            const auto peer = find_peer(ref);
            if (peer && --peer->pending_unlinks == 0)
                destroy_peer(ref.id);
            return G_SOURCE_REMOVE;
        },
        new PeerRef(*static_cast<PeerRef *>(data)), delete_ref);
    return GST_PAD_PROBE_REMOVE;
}
static void remove_peer(const std::string &id, bool notify) {
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
    const PeerRef ref{peer.id, peer.index, peer.pending_input};
    std::vector<GstPad *> pads;
    for (auto pad : {peer.video_tee_pad, peer.audio_tee_pad})
        if (pad)
            pads.push_back(pad);
    peer.pending_unlinks = static_cast<int>(pads.size());
    if (pads.empty()) {
        destroy_peer(id);
        return;
    }
    for (auto pad : pads)
        gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_IDLE, unlink_probe, new PeerRef(ref), delete_ref);
}
static void fail_peer(Peer &peer, const char *reason) {
    if (peer.removing)
        return;
    if (error_log.is_open())
        error_log << "PEER FAILED id=" << peer.id << " reason=" << reason << std::endl;
    emit("peer-failed", {{"peerId", peer.id}, {"reason", reason}});
    remove_peer(peer.id, false);
}
static void add_peer(const std::string &id, const std::string &text) {
    const auto refuse = [&](const std::string &reason) {
        emit("peer-failed", {{"peerId", id}, {"reason", reason}});
    };
    if (!pipeline)
        return refuse("Source not started.");
    if (peers.count(id))
        return refuse("Duplicate peer.");
    const auto sdp = parse_offer(text);
    if (!sdp)
        return refuse("Invalid SDP");
    const auto payloads = select_payloads(sdp, *video_codec);
    const char *unsupported =
        video_enabled && payloads.video.empty()    ? video_codec->unsupported.c_str()
        : audio_channels && payloads.audio.empty() ? "Browser must offer Opus audio."
                                                   : nullptr;
    if (unsupported) {
        gst_sdp_message_free(sdp);
        return refuse(unsupported);
    }
    auto owned = std::make_unique<Peer>();
    auto &peer = *owned;
    peer.id = id;
    peer.index = next_peer_index++;
    const auto video_ssrc = std::to_string(10000001u + 2u * peer.index);
    const auto audio_ssrc = std::to_string(20000001u + 2u * peer.index);
    // webrtcbin requires explicit SSRC on the payloader and in the outgoing RTP caps
    // during SDP answer creation. Without this, webrtcbin emits FID 0 <rtx-ssrc> and
    // attaches MSID only to the RTX repair stream, causing the browser to decode RTP
    // packets but fail to route frames to the MediaStreamTrack (video readyState remains 0).
    const bool h264 = video_codec->id == "h264";
    const std::string video_branch =
        "queue leaky=downstream max-size-buffers=8 max-size-time=200000000 max-size-bytes=0 ! " +
        video_codec->payloader + " name=video-payloader mtu=" + std::to_string(profile.mtu) +
        " pt=" + payloads.video + " ssrc=" + video_ssrc +
        (video_codec->payloader_extra.empty() ? "" : " " + video_codec->payloader_extra) +
        (h264 ? " aggregate-mode=" + std::string(profile.fps == 15 ? "none" : "zero-latency")
              : "") +
        " ! application/x-rtp,media=video,encoding-name=" + video_codec->encoding_name +
        ",ssrc=(uint)" + video_ssrc + " ! identity name=video-output";
    const std::string audio_branch =
        "queue leaky=downstream max-size-time=100000000 max-size-buffers=5 ! rtpopuspay pt=" +
        payloads.audio + " mtu=1200 ssrc=" + audio_ssrc +
        " ! application/x-rtp,media=audio,encoding-name=OPUS,ssrc=(uint)" + audio_ssrc +
        " ! identity name=audio-output";
    if (error_log.is_open())
        error_log << "PEER id=" << id
                  << " video=" << (video_enabled ? video_branch : std::string("off"))
                  << " audio=" << (audio_channels ? audio_branch : std::string("off")) << std::endl;
    peer.bin = GST_ELEMENT(
        gst_object_ref_sink(gst_bin_new(("peer-" + std::to_string(peer.index)).c_str())));
    peer.transport.attach(peer.bin);
    std::string failure;
    peer.webrtc = gst_element_factory_make("webrtcbin", "webrtc");
    if (!peer.webrtc)
        failure = "Unable to create WebRTC peer.";
    else {
        g_object_set(peer.webrtc, "bundle-policy", GST_WEBRTC_BUNDLE_POLICY_MAX_BUNDLE, "latency",
                     0, nullptr);
        g_signal_connect(
            peer.webrtc, "on-new-transceiver",
            G_CALLBACK(+[](GstElement *, GstWebRTCRTPTransceiver *transceiver, gpointer) {
                g_object_set(transceiver, "do-nack", TRUE, nullptr);
            }),
            nullptr);
        gst_bin_add(GST_BIN(peer.bin), peer.webrtc);
    }
    const auto add_branch = [&](const std::string &description, const char *ghost) {
        if (!failure.empty())
            return;
        GError *error = nullptr;
        auto branch = gst_parse_bin_from_description(description.c_str(), TRUE, &error);
        if (error || !branch) {
            failure = error ? error->message : "Unable to create peer branch.";
            if (error)
                g_error_free(error);
            if (branch)
                gst_object_unref(branch);
            return;
        }
        gst_bin_add(GST_BIN(peer.bin), GST_ELEMENT(branch));
        auto sink = gst_element_get_static_pad(GST_ELEMENT(branch), "sink");
        if (!sink || !gst_element_link(GST_ELEMENT(branch), peer.webrtc) ||
            !gst_element_add_pad(peer.bin, gst_ghost_pad_new(ghost, sink)))
            failure = "Unable to link peer branch to WebRTC.";
        if (sink)
            gst_object_unref(sink);
    };
    // Link order matches the previous single-peer pipeline: video first, then audio.
    if (video_enabled)
        add_branch(video_branch, "video_sink");
    if (video_enabled && failure.empty()) {
        auto payloader = gst_bin_get_by_name(GST_BIN(peer.bin), "video-payloader");
        auto pad = gst_element_get_static_pad(payloader, "src");
        gst_pad_add_probe(pad,
                          static_cast<GstPadProbeType>(GST_PAD_PROBE_TYPE_BUFFER |
                                                       GST_PAD_PROBE_TYPE_BUFFER_LIST |
                                                       GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM |
                                                       GST_PAD_PROBE_TYPE_QUERY_UPSTREAM),
                          payload_type_probe,
                          GUINT_TO_POINTER(static_cast<guint>(std::stoi(payloads.video))), nullptr);
        gst_object_unref(pad);
        gst_object_unref(payloader);
    }
    if (audio_channels)
        add_branch(audio_branch, "audio_sink");
    if (!failure.empty()) {
        gst_sdp_message_free(sdp);
        gst_object_unref(peer.bin);
        return refuse(failure);
    }
    g_signal_connect_data(peer.webrtc, "notify::ice-gathering-state", G_CALLBACK(gathering_changed),
                          peer_ref(peer), delete_closure_ref, GConnectFlags(0));
    g_signal_connect_data(peer.webrtc, "notify::connection-state", G_CALLBACK(connection_changed),
                          peer_ref(peer), delete_closure_ref, GConnectFlags(0));
    g_signal_connect_data(peer.webrtc, "on-data-channel", G_CALLBACK(channel_created),
                          peer_ref(peer), delete_closure_ref, GConnectFlags(0));
    peers.emplace(id, std::move(owned));
    gst_bin_add(GST_BIN(pipeline), peer.bin);
    // Bring the branch up before linking so the tee never pushes into a flushing pad.
    if (playing)
        gst_element_sync_state_with_parent(peer.bin);
    const auto link = [&](const char *tee_name, const char *ghost, GstPad *&tee_pad) {
        auto tee = gst_bin_get_by_name(GST_BIN(pipeline), tee_name);
        tee_pad = gst_element_request_pad_simple(tee, "src_%u");
        gst_object_unref(tee);
        auto sink = gst_element_get_static_pad(peer.bin, ghost);
        const bool linked = tee_pad && sink && gst_pad_link(tee_pad, sink) == GST_PAD_LINK_OK;
        if (sink)
            gst_object_unref(sink);
        return linked;
    };
    if (!((!video_enabled || link("video-fanout", "video_sink", peer.video_tee_pad)) &&
          (!audio_channels || link("audio-fanout", "audio_sink", peer.audio_tee_pad)))) {
        gst_sdp_message_free(sdp);
        return fail_peer(peer, "Unable to link peer to the shared source.");
    }
    if (!playing) {
        // Nothing is captured or encoded until the first viewer is linked.
        playing = true;
        gst_element_set_state(pipeline, GST_STATE_PLAYING);
    }
    auto offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);
    auto promise = gst_promise_new_with_change_func(remote_set, peer_ref(peer), delete_ref);
    g_signal_emit_by_name(peer.webrtc, "set-remote-description", offer, promise);
    gst_webrtc_session_description_free(offer);
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
    host_control_required = boolean_member(object, "hostControl");
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
        description = pipeline_description() + " ! tee name=video-fanout allow-not-linked=true";
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
    auto bus = gst_element_get_bus(pipeline);
    gst_bus_add_watch(bus, bus_message, nullptr);
    gst_object_unref(bus);
    emit("ready");
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
                auto rows = json_object_new();
                for (auto &entry : peers) {
                    if (entry.second->removing)
                        continue;
                    auto row = json_object_new();
                    entry.second->transport.merge(entry.second->bin, row);
                    json_object_set_object_member(rows, entry.first.c_str(), row);
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
    g_main_loop_run(loop);
    release_held();
    if (pipeline)
        gst_element_set_state(pipeline, GST_STATE_NULL);
    for (auto &entry : peers) {
        for (auto pad : {entry.second->video_tee_pad, entry.second->audio_tee_pad})
            if (pad)
                gst_object_unref(pad);
        if (entry.second->input_channel)
            g_object_unref(entry.second->input_channel);
        gst_object_unref(entry.second->bin);
    }
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
