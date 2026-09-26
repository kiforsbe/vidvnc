// media-net: the sandboxed network half of a media source (docs/superpowers/specs/2026-09-26-
// r4-media-relay-and-privilege-split-design.md, Part B). `media-worker.exe --network` runs it,
// started by the worker under the tier T1 sandbox (sandbox.hpp): restricted token, low
// integrity, job, alternate desktop. It holds everything that talks to viewers - webrtcbin,
// payloaders, data channels and the loopback ICE sockets - and nothing that can capture the
// screen or inject input. Encoded frames arrive from the worker on the frames pipe; data-channel
// input goes back on the input pipe, and the worker's broker decides what, if anything, to do
// with it.
//
// It starts impersonating a same-access token (set by the worker on its suspended main thread),
// loads every plugin and library it needs, then calls RevertToSelf before it opens a socket or
// reads anything from a peer. Nothing new is loaded after that.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winsock2.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <gst/webrtc/webrtc.h>
#include <gst/sdp/sdp.h>
#include <gst/video/video-event.h>
#include <json-glib/json-glib.h>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "json-util.hpp"
#include "net-pipes.hpp"
#include "net-records.hpp"
#include "sdp-payload.hpp"
#include "transport-telemetry.hpp"
#include "video-codec.hpp"
#include "media-net.hpp"

namespace {

HANDLE control_out = nullptr, input_out = nullptr;
// Diagnostics: frames pushed per kind, and the last push result that was not OK.
std::atomic<unsigned> pushed_video{0}, pushed_audio{0};
std::atomic<int> last_push_failure{GST_FLOW_OK};
// Diagnostics: what the main loop is doing, and since when (a watchdog reports a stall).
std::atomic<int> main_phase{0};
std::atomic<gint64> main_phase_since{0};
void enter(int phase) {
    main_phase = phase;
    main_phase_since = g_get_monotonic_time() / 1000;
}
std::mutex control_mutex, input_mutex;
std::atomic<bool> pipes_broken{false};
GMainLoop *loop = nullptr;
GstElement *pipeline = nullptr;
std::atomic<GstElement *> video_source{nullptr}, audio_source{nullptr};
bool configured = false, playing = false;
bool video_enabled = false;
int audio_channels = 0;
const VideoCodec *video_codec = nullptr;
unsigned mtu = 1200, fps = 30;

void stop_loop() {
    if (loop)
        g_main_loop_quit(loop);
}

// Control lines to the worker. Called from the main loop and from GStreamer threads.
void send_line(JsonObject *object) {
    const auto line = object_text(object) + "\n";
    std::lock_guard<std::mutex> lock(control_mutex);
    if (!pipes_broken && !net_pipes::write_all(control_out, line.data(), line.size()))
        pipes_broken = true;
}
void emit(const char *type,
          std::initializer_list<std::pair<const char *, std::string>> fields = {}) {
    send_line(typed_object(type, fields));
}
// media-net writes no files: diagnostics go to the worker, which logs them.
void log_line(const std::string &text) { emit("log", {{"text", text.substr(0, 2048)}}); }

// GStreamer payloaders only produce payload types 96-127 and silently replace a lower `pt`, but
// browsers also number codecs 35-63 (Safari offers H.265 as 35). This probe on the payloader's
// src pad relabels the payload type everywhere webrtcbin and the browser see it: the caps event
// and caps query results (webrtcbin pairs the offer's m-line with a pad by intersecting caps,
// so a mismatch answers the m-line inactive) and every RTP header. No-op when they already match.
GstCaps *with_payload_type(GstCaps *caps, guint8 pt) {
    auto result = gst_caps_copy(caps);
    for (guint i = 0; i < gst_caps_get_size(result); ++i)
        gst_structure_set(gst_caps_get_structure(result, i), "payload", G_TYPE_INT,
                          static_cast<gint>(pt), nullptr);
    return result;
}
bool payload_type_differs(GstBuffer *buffer, guint8 pt) {
    guint8 second = 0;
    return gst_buffer_extract(buffer, 1, &second, 1) == 1 && (second & 0x7f) != pt;
}
void set_payload_type(GstBuffer *buffer, guint8 pt) {
    guint8 second = 0;
    if (gst_buffer_extract(buffer, 1, &second, 1) != 1)
        return;
    second = static_cast<guint8>((second & 0x80) | pt);
    gst_buffer_fill(buffer, 1, &second, 1);
}
GstPadProbeReturn payload_type_probe(GstPad *, GstPadProbeInfo *info, gpointer data) {
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

// One viewer: leaky queue, payloader and webrtcbin inside a bin fed by the source tees.
struct Peer {
    std::string id;
    unsigned index = 0;
    GstElement *bin = nullptr;                                 // owned reference
    GstElement *webrtc = nullptr;                              // borrowed from bin
    GstPad *video_tee_pad = nullptr, *audio_tee_pad = nullptr; // owned request pads
    GstWebRTCDataChannel *input_channel = nullptr;             // owned reference
    bool answered = false, removing = false;
    int pending_unlinks = 0;
    TransportTelemetry transport;
};
// GStreamer threads never touch a Peer. Callbacks carry a copy of this reference and look the
// peer up on the main loop; the index rejects callbacks for a removed peer whose id was reused.
struct PeerRef {
    std::string id;
    unsigned index;
};
std::map<std::string, std::unique_ptr<Peer>> peers;
unsigned next_peer_index = 0;
Peer *find_peer(const PeerRef &ref) {
    const auto found = peers.find(ref.id);
    return found != peers.end() && found->second->index == ref.index ? found->second.get()
                                                                     : nullptr;
}
PeerRef *peer_ref(const Peer &peer) { return new PeerRef{peer.id, peer.index}; }
void delete_ref(gpointer data) { delete static_cast<PeerRef *>(data); }
void delete_closure_ref(gpointer data, GClosure *) { delete_ref(data); }
void remove_peer(const std::string &id);

void fail_peer(Peer &peer, const char *reason) {
    if (peer.removing)
        return;
    log_line("PEER FAILED id=" + peer.id + " reason=" + reason);
    emit("peer-failed", {{"peerId", peer.id}, {"reason", reason}});
    remove_peer(peer.id);
}

// Data-channel text goes to the worker's broker unchanged; nothing here interprets it.
void channel_message(GstWebRTCDataChannel *, gchar *text, gpointer data) {
    const auto &ref = *static_cast<PeerRef *>(data);
    const auto size = text ? strlen(text) : 0;
    if (!size || size > net_records::max_input_text)
        return;
    const auto record = net_records::encode_input(ref.id, std::string_view(text, size));
    std::lock_guard<std::mutex> lock(input_mutex);
    if (!pipes_broken && !net_pipes::write_all(input_out, record.data(), record.size()))
        pipes_broken = true;
}
void channel_closed(GstWebRTCDataChannel *, gpointer data) {
    log_line("PEER id=" + static_cast<PeerRef *>(data)->id + " input channel closed");
    emit("channel-closed", {{"peerId", static_cast<PeerRef *>(data)->id}});
}
struct ChannelAttach {
    PeerRef ref;
    GstWebRTCDataChannel *channel;
};
void channel_created(GstElement *, GstWebRTCDataChannel *channel, gpointer data) {
    gchar *label = nullptr;
    g_object_get(channel, "label", &label, nullptr);
    const bool input = video_enabled && g_strcmp0(label, "input") == 0;
    g_free(label);
    if (!input) {
        gst_webrtc_data_channel_close(channel);
        return;
    }
    const auto &ref = *static_cast<PeerRef *>(data);
    log_line("PEER id=" + ref.id + " input channel opened");
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

// Finds the viewer bin an element belongs to. `attached` is false for elements no longer inside
// the pipeline (a queued message from a peer that was already destroyed).
Peer *peer_of(GstObject *object, bool &attached) {
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
gboolean bus_message(GstBus *, GstMessage *message, gpointer) {
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_WARNING) {
        GError *warning = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_warning(message, &warning, &debug);
        log_line("GSTREAMER WARNING source=" + std::string(GST_OBJECT_NAME(message->src)) +
                 " message=" + (warning ? warning->message : "unknown") +
                 " debug=" + (debug ? debug : "none"));
        if (warning)
            g_error_free(warning);
        g_free(debug);
    }
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *error = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_error(message, &error, &debug);
        log_line("GSTREAMER ERROR source=" + std::string(GST_OBJECT_NAME(message->src)) +
                 " message=" + (error ? error->message : "unknown") +
                 " debug=" + (debug ? debug : "none"));
        // A viewer's transport failing must not end the source for everyone else.
        bool attached = false;
        if (const auto peer = peer_of(message->src, attached))
            fail_peer(*peer, error ? error->message : "WebRTC peer error.");
        else if (attached) {
            emit("fatal", {{"reason", error ? error->message : "GStreamer error"}});
            stop_loop();
        }
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
void on_main(const PeerRef &ref, void (*run)(Peer &)) {
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
void send_answer(Peer &peer) {
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
void gathering_changed(GObject *, GParamSpec *, gpointer data) {
    on_main(*static_cast<PeerRef *>(data), send_answer);
}
void connection_changed(GObject *, GParamSpec *, gpointer data) {
    on_main(*static_cast<PeerRef *>(data), [](Peer &peer) {
        GstWebRTCPeerConnectionState state;
        g_object_get(peer.webrtc, "connection-state", &state, nullptr);
        log_line("PEER id=" + peer.id + " connection-state=" + std::to_string(state));
        if (state == GST_WEBRTC_PEER_CONNECTION_STATE_FAILED)
            fail_peer(peer, "WebRTC connection failed.");
        // RTP sent before DTLS connects is dropped, so the join keyframe waits for connected.
        // The worker applies its keyframe limits.
        else if (state == GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTED && video_enabled)
            emit("keyframe-request", {{"kind", "join"}});
    });
}
struct AnswerResult {
    PeerRef ref;
    GstWebRTCSessionDescription *answer;
};
void answer_created(GstPromise *promise, gpointer data) {
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
void remote_set(GstPromise *promise, gpointer data) {
    const PeerRef ref = *static_cast<PeerRef *>(data); // copy: unref may free data
    gst_promise_unref(promise);
    on_main(ref, [](Peer &peer) {
        auto answer = gst_promise_new_with_change_func(answer_created, peer_ref(peer), delete_ref);
        g_signal_emit_by_name(peer.webrtc, "create-answer", nullptr, answer);
    });
}
void destroy_peer(const std::string &id) {
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
    emit("peer-closed", {{"peerId", peer.id}});
}
GstPadProbeReturn unlink_probe(GstPad *pad, GstPadProbeInfo *, gpointer data) {
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
// Every removal ends in exactly one peer-closed, which the worker waits for.
void remove_peer(const std::string &id) {
    const auto found = peers.find(id);
    if (found == peers.end()) {
        emit("peer-closed", {{"peerId", id}});
        return;
    }
    auto &peer = *found->second;
    if (peer.removing)
        return;
    peer.removing = true;
    const PeerRef ref{peer.id, peer.index};
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
void add_peer(const std::string &id, const std::string &text) {
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
    const auto payloads = select_payloads(sdp, video_enabled ? *video_codec : video_codecs()[0]);
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
    std::string video_branch;
    if (video_enabled) {
        const bool h264 = video_codec->id == "h264";
        video_branch =
            "queue leaky=downstream max-size-buffers=8 max-size-time=200000000 max-size-bytes=0 "
            "! " +
            video_codec->payloader + " name=video-payloader mtu=" + std::to_string(mtu) +
            " pt=" + payloads.video + " ssrc=" + video_ssrc +
            (video_codec->payloader_extra.empty() ? "" : " " + video_codec->payloader_extra) +
            (h264 ? " aggregate-mode=" + std::string(fps == 15 ? "none" : "zero-latency") : "") +
            " ! application/x-rtp,media=video,encoding-name=" + video_codec->encoding_name +
            ",ssrc=(uint)" + video_ssrc + " ! identity name=video-output";
    }
    const std::string audio_branch =
        "queue leaky=downstream max-size-time=100000000 max-size-buffers=5 ! rtpopuspay pt=" +
        payloads.audio + " mtu=1200 ssrc=" + audio_ssrc +
        " ! application/x-rtp,media=audio,encoding-name=OPUS,ssrc=(uint)" + audio_ssrc +
        " ! identity name=audio-output";
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
        // Loopback only, always: viewers reach this process only through the media relay.
        // Adding a local address stops automatic interface discovery; ICE-TCP stays off.
        GstWebRTCICE *ice = nullptr;
        g_object_get(peer.webrtc, "ice-agent", &ice, nullptr);
        if (ice) {
            gboolean added = FALSE;
            g_signal_emit_by_name(ice, "add-local-ip-address", "127.0.0.1", &added);
            if (g_object_class_find_property(G_OBJECT_GET_CLASS(ice), "ice-tcp"))
                g_object_set(ice, "ice-tcp", FALSE, nullptr);
            gst_object_unref(ice);
            if (!added)
                failure = "Unable to bind WebRTC to loopback: the ICE agent refused 127.0.0.1.";
        } else
            failure = "Unable to bind WebRTC to loopback: no ICE agent.";
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
        playing = true;
        gst_element_set_state(pipeline, GST_STATE_PLAYING);
    }
    auto offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);
    auto promise = gst_promise_new_with_change_func(remote_set, peer_ref(peer), delete_ref);
    g_signal_emit_by_name(peer.webrtc, "set-remote-description", offer, promise);
    gst_webrtc_session_description_free(offer);
}

// Viewers asking for a keyframe (PLI, FIR) send force-key-unit upstream; it stops at appsrc,
// so pass it on to the worker, whose limiter decides.
GstPadProbeReturn recovery_request(GstPad *, GstPadProbeInfo *info, gpointer) {
    if (gst_video_event_is_force_key_unit(GST_PAD_PROBE_INFO_EVENT(info)))
        emit("keyframe-request", {{"kind", "recovery"}});
    return GST_PAD_PROBE_OK;
}

GstElement *make_source(const char *name, const char *tee) {
    auto source = gst_element_factory_make("appsrc", name);
    auto fanout = gst_element_factory_make("tee", tee);
    if (!source || !fanout)
        return nullptr;
    // Live, timestamped on arrival in this process's clock; a stalled viewer never blocks the
    // pipe reader, because the internal queue drops the oldest data instead.
    g_object_set(source, "is-live", TRUE, "format", GST_FORMAT_TIME, "do-timestamp", TRUE,
                 "max-bytes", static_cast<guint64>(32u << 20), "block", FALSE, nullptr);
    if (g_object_class_find_property(G_OBJECT_GET_CLASS(source), "leaky-type"))
        g_object_set(source, "leaky-type", 2 /* downstream: drop the oldest */, nullptr);
    g_object_set(fanout, "allow-not-linked", TRUE, nullptr);
    gst_bin_add_many(GST_BIN(pipeline), source, fanout, nullptr);
    if (!gst_element_link(source, fanout))
        return nullptr;
    return source;
}

bool configure(JsonObject *object) {
    if (configured)
        return false;
    configured = true;
    video_enabled = boolean_member(object, "video");
    const auto channels = number_member(object, "audioChannels");
    const auto frame_rate = number_member(object, "fps");
    const auto packet = number_member(object, "mtu");
    if (!(channels == 0 || channels == 1 || channels == 2))
        return false;
    audio_channels = static_cast<int>(channels);
    if (video_enabled) {
        video_codec = find_video_codec(string_member(object, "codec"));
        if (!video_codec || !(frame_rate >= 1 && frame_rate <= 240) ||
            !(packet >= 576 && packet <= 1500))
            return false;
        fps = static_cast<unsigned>(frame_rate);
        mtu = static_cast<unsigned>(packet);
    }
    if (!video_enabled && !audio_channels)
        return false;
    pipeline = gst_pipeline_new("media-net");
    if (video_enabled) {
        auto source = make_source("video-source", "video-fanout");
        if (!source)
            return false;
        auto pad = gst_element_get_static_pad(source, "src");
        gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_EVENT_UPSTREAM, recovery_request, nullptr,
                          nullptr);
        gst_object_unref(pad);
        video_source = source;
    }
    if (audio_channels) {
        auto source = make_source("audio-source", "audio-fanout");
        if (!source)
            return false;
        audio_source = source;
    }
    auto bus = gst_element_get_bus(pipeline);
    gst_bus_add_watch(bus, bus_message, nullptr);
    gst_object_unref(bus);
    return true;
}

// Worker commands, on the main loop. The worker is trusted; still, a line that does not parse
// ends this process rather than being guessed at.
gboolean command(gpointer data) {
    enter(10);
    std::unique_ptr<std::string> text(static_cast<std::string *>(data));
    JsonParser *parser = nullptr;
    auto object = parse_object(*text, &parser);
    const std::string type = object ? string_member(object, "type") : "";
    const std::string peer_id = object ? string_member(object, "peerId") : "";
    if (type == "configure") {
        if (!configure(object)) {
            emit("fatal", {{"reason", "Invalid network configuration"}});
            stop_loop();
        }
    } else if (type == "add-peer" && net_records::valid_peer_id(peer_id))
        add_peer(peer_id, string_member(object, "sdp"));
    else if (type == "remove-peer" && net_records::valid_peer_id(peer_id))
        remove_peer(peer_id);
    else if (type == "control-state" && net_records::valid_peer_id(peer_id)) {
        const auto found = peers.find(peer_id);
        enter(11);
        if (found != peers.end() && !found->second->removing && found->second->input_channel)
            gst_webrtc_data_channel_send_string(
                found->second->input_channel,
                boolean_member(object, "control") ? "{\"control\":true}" : "{\"control\":false}");
    } else if (type == "stop")
        stop_loop();
    else {
        emit("fatal", {{"reason", "Invalid command"}});
        stop_loop();
    }
    if (parser)
        g_object_unref(parser);
    enter(0);
    return G_SOURCE_REMOVE;
}

// Frame records from the worker, pushed straight into the appsrc from this thread (appsrc is
// thread-safe). A malformed record ends the stream.
void read_frames(HANDLE frames) {
    unsigned char header_bytes[net_records::frame_header_size];
    std::vector<unsigned char> payload;
    while (net_pipes::read_exact(frames, header_bytes, sizeof(header_bytes))) {
        const auto header = net_records::decode_frame_header(header_bytes);
        if (!header)
            break;
        payload.resize(header->length);
        if (header->length && !net_pipes::read_exact(frames, payload.data(), header->length))
            break;
        const bool video = header->kind == net_records::FrameKind::VideoBuffer ||
                           header->kind == net_records::FrameKind::VideoCaps;
        auto source = (video ? video_source : audio_source).load();
        if (!source)
            continue;
        if (net_records::is_caps(header->kind)) {
            const std::string text(payload.begin(), payload.end());
            const bool expected =
                video ? video_codec &&
                            text.rfind(video_codec->caps.substr(0, video_codec->caps.find(',')),
                                       0) == 0
                      : text.rfind("audio/x-opus", 0) == 0;
            auto caps = expected ? gst_caps_from_string(text.c_str()) : nullptr;
            if (!caps)
                break;
            g_object_set(source, "caps", caps, nullptr);
            gst_caps_unref(caps);
            log_line(std::string("CAPS ") + text);
            continue;
        }
        auto buffer = gst_buffer_new_memdup(payload.data(), payload.size());
        if (header->flags & net_records::flag_delta)
            GST_BUFFER_FLAG_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
        if (header->duration)
            GST_BUFFER_DURATION(buffer) = header->duration;
        const auto flow = gst_app_src_push_buffer(GST_APP_SRC(source), buffer);
        if (flow != GST_FLOW_OK)
            last_push_failure = flow;
        ++(video ? pushed_video : pushed_audio);
    }
    g_main_context_invoke(
        nullptr,
        [](gpointer) -> gboolean {
            stop_loop();
            return G_SOURCE_REMOVE;
        },
        nullptr);
}

// Everything this process will ever need, loaded while it can still read the install folder.
bool preload() {
    for (const char *plugin :
         {"coreelements", "app", "rtp", "rtpmanager", "webrtc", "nice", "dtls", "srtp", "sctp"}) {
        auto loaded = gst_plugin_load_by_name(plugin);
        if (loaded)
            gst_object_unref(loaded);
    }
    std::vector<std::string> elements{
        "appsrc",       "tee",       "queue",     "identity",    "capsfilter",  "webrtcbin",
        "rtpbin",       "nicesrc",   "nicesink",  "dtlssrtpenc", "dtlssrtpdec", "srtpenc",
        "srtpdec",      "sctpenc",   "sctpdec",   "rtpfunnel",   "rtprtxsend",  "rtpstorage",
        "rtpulpfecenc", "rtpredenc", "rtpopuspay"};
    for (const auto &codec : video_codecs())
        elements.push_back(codec.payloader);
    bool complete = true;
    for (const auto &name : elements) {
        auto factory = gst_element_factory_find(name.c_str());
        auto feature = factory ? gst_plugin_feature_load(GST_PLUGIN_FEATURE(factory)) : nullptr;
        if (!feature && name != "rtpav1pay") // AV1 support depends on the GStreamer build
            complete = false;
        if (feature)
            gst_object_unref(feature);
        if (factory)
            gst_object_unref(factory);
    }
    return complete;
}

} // namespace

int network_main(HANDLE control_in, HANDLE control_out_handle, HANDLE frames, HANDLE input) {
    control_out = control_out_handle;
    input_out = input;
    // Nothing goes to stderr (it is the NUL device): GLib messages and GStreamer's own debug
    // output are sent to the worker's log instead.
    g_log_set_default_handler(
        [](const gchar *domain, GLogLevelFlags level, const gchar *message, gpointer) {
            if (level & (G_LOG_LEVEL_DEBUG | G_LOG_LEVEL_INFO))
                return;
            log_line(std::string("GLIB ") + (domain ? domain : "") + " " +
                     (message ? message : ""));
        },
        nullptr);
    g_set_print_handler([](const gchar *text) { log_line(std::string("PRINT ") + text); });
    g_set_printerr_handler([](const gchar *text) { log_line(std::string("PRINTERR ") + text); });
    gst_debug_remove_log_function(gst_debug_log_default);
    // Still impersonating the same-access token: start Winsock and load every plugin now.
    WSADATA winsock;
    const bool sockets = WSAStartup(MAKEWORD(2, 2), &winsock) == 0;
    const bool loaded = preload();
    // Drop to the restricted primary token before any socket or peer data. If that fails,
    // nothing else may run.
    if (!RevertToSelf())
        return 3;
    HANDLE thread_token = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread_token)) {
        CloseHandle(thread_token);
        return 3;
    }
    if (!sockets || !loaded) {
        emit("fatal", {{"reason", !sockets ? "Winsock did not start in the network process."
                                           : "A network plugin did not load."}});
        return 1;
    }
    // Gate P4: code generated at run time is refused from here on.
    PROCESS_MITIGATION_DYNAMIC_CODE_POLICY acg{};
    acg.ProhibitDynamicCode = 1;
    const bool code_guard =
        SetProcessMitigationPolicy(ProcessDynamicCodePolicy, &acg, sizeof(acg)) != FALSE;

    loop = g_main_loop_new(nullptr, FALSE);
    std::thread([control_in] {
        const bool ok = net_pipes::read_lines(control_in, [](std::string line) {
            g_main_context_invoke(nullptr, command, new std::string(std::move(line)));
        });
        (void)ok;
        g_main_context_invoke(
            nullptr,
            [](gpointer) -> gboolean {
                stop_loop();
                return G_SOURCE_REMOVE;
            },
            nullptr);
    }).detach();
    std::thread(read_frames, frames).detach();
    g_timeout_add(
        1000,
        [](gpointer) -> gboolean {
            if (pipes_broken) {
                stop_loop();
                return G_SOURCE_REMOVE;
            }
            enter(1);
            // Frames pushed, once a minute.
            static unsigned ticks = 0;
            if (++ticks % 60 == 0)
                log_line("FRAMES pushed video=" + std::to_string(pushed_video.load()) +
                         " audio=" + std::to_string(pushed_audio.load()) +
                         " last-failure=" + std::to_string(last_push_failure.load()) +
                         " peers=" + std::to_string(peers.size()));
            if (peers.empty())
                return G_SOURCE_CONTINUE;
            enter(2);
            auto rows = json_object_new();
            for (auto &entry : peers) {
                if (entry.second->removing)
                    continue;
                auto row = json_object_new();
                entry.second->transport.merge(entry.second->bin, row);
                json_object_set_object_member(rows, entry.first.c_str(), row);
            }
            auto message = typed_object("peer-metrics");
            json_object_set_object_member(message, "peers", rows);
            enter(3);
            send_line(message);
            enter(0);
            return G_SOURCE_CONTINUE;
        },
        nullptr);
    // Watchdog: if the main loop has been in one step for more than 3 seconds, say which
    // (1 timer, 2 transport stats, 3 sending metrics, 10 a command, 11 a data channel send).
    // It cannot report while the stuck step itself holds the control pipe.
    std::thread([] {
        for (;;) {
            Sleep(2000);
            const int phase = main_phase;
            const auto since = main_phase_since.load();
            const auto now = g_get_monotonic_time() / 1000;
            if (phase == 0 || now - since < 3000)
                continue;
            std::unique_lock<std::mutex> lock(control_mutex, std::try_to_lock);
            if (!lock.owns_lock() || pipes_broken)
                continue;
            const auto line =
                object_text(typed_object(
                    "log", {{"text", "STALL main loop in step " + std::to_string(phase) + " for " +
                                         std::to_string(now - since) + " ms"}})) +
                "\n";
            net_pipes::write_all(control_out, line.data(), line.size());
        }
    }).detach();
    emit("net-ready", {{"tier", "T1"}, {"codeGuard", code_guard ? "on" : "off"}});
    g_main_loop_run(loop);
    // No orderly teardown: setting webrtcbin to NULL can hang, and the worker, which owns this
    // process, has already given up on it. Exit at once; the job reclaims everything.
    log_line("LOOP EXIT");
    ExitProcess(pipes_broken ? 4 : 0);
}
