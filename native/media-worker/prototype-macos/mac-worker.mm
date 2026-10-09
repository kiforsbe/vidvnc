// MG1/MG2 prototype only (throwaway): a stand-in for media-worker on macOS, just enough of the
// owner-side protocol (native-media.mjs) for relay-check-mac.mjs. It runs the real media-net
// (media-net.cpp, compiled unmodified through the shim in shim/) as `--network <fds>`, and feeds
// it Opus from audiotestsrc (MG1) or ScreenCaptureKit + VideoToolbox access units (MG2, see
// screen-encoder.mm). Answers and peer events pass through. Every input message is answered
// with control-state false; there is no input broker, injection or sandbox.
//
// VIDVNC_MG2_STATS=<file>: every 2 seconds, append the encoder's counters as a JSON line.
#include <windows.h>
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <json-glib/json-glib.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>
#include <mach-o/dyld.h>
#include <CoreGraphics/CoreGraphics.h>
#include <atomic>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#include "json-util.hpp"
#include "media-net.hpp"
#include "net-pipes.hpp"
#include "net-records.hpp"
#include "rate-control.hpp"
#include "screen-encoder.hpp"
#include "stream-profile.hpp"
#include "video-codec.hpp"

extern char **environ;

namespace {

GMainLoop *loop = nullptr;
GstElement *pipeline = nullptr;
GstElement *video_in = nullptr;
bool started = false, playing = false, failed = false, net_ready = false;
bool video_enabled = false;
int audio_channels = 0;
StreamProfile profile;
const VideoCodec *video_codec = nullptr;
std::unique_ptr<ScreenEncoder> encoder;
JsonObject *pending_ready = nullptr;
std::set<std::string> peers;
std::vector<std::pair<std::string, std::string>> waiting_peers;
std::mutex stdout_mutex, frame_mutex;
pid_t net_pid = 0;
net_pipes::Pipe control_to, control_from, frames_pipe, input_pipe;
std::unique_ptr<net_pipes::QueuedWriter> control_writer, frame_writer;
std::atomic<unsigned> overflows{0};

struct FrameSink {
    net_records::FrameKind buffer_kind, caps_kind;
    std::string sent_caps;
};
FrameSink video_sink{net_records::FrameKind::VideoBuffer, net_records::FrameKind::VideoCaps};
FrameSink audio_sink{net_records::FrameKind::AudioBuffer, net_records::FrameKind::AudioCaps};

void write_object(JsonObject *object) {
    std::lock_guard<std::mutex> lock(stdout_mutex);
    std::cout << object_text(object) << std::endl; // object_text takes ownership
}
void emit(const char *type, std::initializer_list<std::pair<const char *, std::string>> fields = {}) {
    write_object(typed_object(type, fields));
}
void fatal(const std::string &message) {
    std::cerr << "FATAL " << message << std::endl;
    failed = true;
    if (loop)
        g_main_loop_quit(loop);
}
void fail_from_thread(const std::string &message) {
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer text) -> gboolean {
            fatal(*static_cast<std::string *>(text));
            return G_SOURCE_REMOVE;
        },
        new std::string(message), [](gpointer text) { delete static_cast<std::string *>(text); });
}
void send_net(JsonObject *object) {
    const auto line = object_text(object) + "\n"; // object_text takes ownership
    if (!control_writer || !control_writer->push(line))
        fatal("The network process stopped accepting commands.");
}

GstFlowReturn new_sample(GstAppSink *sink, gpointer data) {
    auto &state = *static_cast<FrameSink *>(data);
    auto sample = gst_app_sink_pull_sample(sink);
    if (!sample)
        return GST_FLOW_EOS;
    const auto buffer = gst_sample_get_buffer(sample);
    const auto caps = gst_sample_get_caps(sample);
    std::lock_guard<std::mutex> lock(frame_mutex);
    if (buffer && caps && frame_writer) {
        bool queued = true;
        gchar *caps_text = gst_caps_to_string(caps);
        if (state.sent_caps != caps_text) {
            net_records::FrameHeader header{state.caps_kind, 0,
                                            static_cast<std::uint32_t>(strlen(caps_text)), 0};
            queued = frame_writer->push(net_records::encode_frame(header, caps_text));
            if (queued)
                state.sent_caps = caps_text;
        }
        g_free(caps_text);
        GstMapInfo map{};
        if (queued && gst_buffer_map(buffer, &map, GST_MAP_READ)) {
            const bool delta = GST_BUFFER_FLAG_IS_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
            net_records::FrameHeader header{
                state.buffer_kind, static_cast<std::uint8_t>(delta ? net_records::flag_delta : 0),
                static_cast<std::uint32_t>(map.size),
                GST_BUFFER_DURATION_IS_VALID(buffer) ? GST_BUFFER_DURATION(buffer) : 0};
            queued = frame_writer->push(net_records::encode_frame(header, map.data));
            gst_buffer_unmap(buffer, &map);
        }
        if (!queued) {
            // The real worker skips to a keyframe here; the prototype just counts and asks.
            ++overflows;
            frame_writer->clear();
            video_sink.sent_caps.clear();
            audio_sink.sent_caps.clear();
            if (encoder)
                encoder->request_keyframe();
        }
    }
    gst_sample_unref(sample);
    return GST_FLOW_OK;
}
void attach_sink(const char *name, FrameSink &state) {
    auto sink = gst_bin_get_by_name(GST_BIN(pipeline), name);
    if (!sink)
        return;
    GstAppSinkCallbacks callbacks{};
    callbacks.new_sample = new_sample;
    gst_app_sink_set_callbacks(GST_APP_SINK(sink), &callbacks, &state, nullptr);
    gst_object_unref(sink);
}

void start_capture() {
    if (!video_enabled || encoder)
        return;
    const auto rate = rate_control(video_codec->id, profile);
    ScreenEncoderSettings settings;
    settings.width = profile.width;
    settings.height = profile.height;
    settings.fps = profile.fps;
    settings.bitrate_kbps = rate.bitrate_kbps;
    settings.max_bitrate_kbps = rate.max_bitrate_kbps;
    settings.gop_frames = rate.gop_frames;
    settings.hevc = video_codec->id == "h265";
    encoder = ScreenEncoder::create();
    encoder->start(
        settings,
        [](const std::uint8_t *data, std::size_t size, bool keyframe) {
            auto buffer = gst_buffer_new_memdup(data, size);
            if (!keyframe)
                GST_BUFFER_FLAG_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
            gst_app_src_push_buffer(GST_APP_SRC(video_in), buffer);
        },
        [](const std::string &message) { fail_from_thread(message); });
}

void add_peer(const std::string &id, const std::string &sdp) {
    if (!pipeline)
        return emit("peer-failed", {{"peerId", id}, {"reason", "Source not started."}});
    if (!net_ready) {
        waiting_peers.emplace_back(id, sdp);
        return;
    }
    if (!net_records::valid_peer_id(id) || peers.count(id))
        return emit("peer-failed", {{"peerId", id}, {"reason", "Invalid peer."}});
    peers.insert(id);
    send_net(typed_object("add-peer", {{"peerId", id}, {"sdp", sdp}}));
}

gboolean net_message(gpointer data) {
    std::unique_ptr<std::string> text(static_cast<std::string *>(data));
    JsonParser *parser = nullptr;
    const auto object = parse_object(*text, &parser);
    const std::string type = object ? string_member(object, "type") : "";
    const std::string peer_id = object ? string_member(object, "peerId") : "";
    if (type == "net-ready") {
        net_ready = true;
        std::cerr << "NET ready tier=" << string_member(object, "tier")
                  << " codeGuard=" << string_member(object, "codeGuard") << std::endl;
        if (pending_ready)
            write_object(std::exchange(pending_ready, nullptr));
        for (auto &[id, sdp] : std::exchange(waiting_peers, {}))
            add_peer(id, sdp);
    } else if (type == "answer" && peers.count(peer_id)) {
        emit("answer", {{"peerId", peer_id}, {"sdp", string_member(object, "sdp")}});
        if (!playing) {
            playing = true;
            gst_element_set_state(pipeline, GST_STATE_PLAYING);
            start_capture();
        }
    } else if (type == "peer-failed" && peers.count(peer_id)) {
        peers.erase(peer_id);
        emit("peer-failed", {{"peerId", peer_id}, {"reason", string_member(object, "reason")}});
    } else if (type == "peer-closed") {
        peers.erase(peer_id);
        emit("peer-closed", {{"peerId", peer_id}});
    } else if (type == "keyframe-request") {
        if (encoder)
            encoder->request_keyframe();
    } else if (type == "log")
        std::cerr << "NET " << string_member(object, "text") << std::endl;
    else if (type == "fatal")
        fatal(std::string("Network process failed: ") + string_member(object, "reason"));
    else if (type != "peer-metrics" && type != "channel-closed")
        fatal("The network process sent an invalid message: " + text->substr(0, 200));
    if (parser)
        g_object_unref(parser);
    return G_SOURCE_REMOVE;
}

std::string executable_path() {
    char path[4096];
    uint32_t size = sizeof(path);
    return _NSGetExecutablePath(path, &size) == 0 ? path : "";
}

// Every input message is answered with the peer's control state, which is always false here.
void read_input(HANDLE handle) {
    unsigned char header[4];
    while (net_pipes::read_exact(handle, header, sizeof(header))) {
        const auto sizes = net_records::decode_input_header(header);
        if (!sizes)
            return fail_from_thread("The network process sent a malformed input record.");
        std::string peer(sizes->peer, '\0'), text(sizes->text, '\0');
        if (!net_pipes::read_exact(handle, peer.data(), peer.size()) ||
            !net_pipes::read_exact(handle, text.data(), text.size()))
            break;
        g_main_context_invoke_full(
            nullptr, G_PRIORITY_DEFAULT,
            [](gpointer data) -> gboolean {
                const auto &id = *static_cast<std::string *>(data);
                if (peers.count(id)) {
                    auto state = typed_object("control-state", {{"peerId", id}});
                    json_object_set_boolean_member(state, "control", FALSE);
                    send_net(state);
                }
                return G_SOURCE_REMOVE;
            },
            new std::string(peer), [](gpointer data) { delete static_cast<std::string *>(data); });
    }
    fail_from_thread("The network process stopped.");
}

bool start_network() {
    if (!net_pipes::make_pipe(control_to, true) || !net_pipes::make_pipe(control_from, false) ||
        !net_pipes::make_pipe(frames_pipe, true) || !net_pipes::make_pipe(input_pipe, false))
        return fatal("Unable to create the pipes to the network process."), false;
    const auto fd_text = [](const sandbox::Handle &handle) {
        return std::to_string(shim_fd(handle.get()));
    };
    const auto self = executable_path();
    std::vector<std::string> args{self,
                                  "--network",
                                  fd_text(control_to.child),
                                  fd_text(control_from.child),
                                  fd_text(frames_pipe.child),
                                  fd_text(input_pipe.child)};
    std::vector<char *> argv;
    for (auto &arg : args)
        argv.push_back(arg.data());
    argv.push_back(nullptr);
    setenv("GST_REGISTRY_UPDATE", "no", 1);
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    for (int fd = 0; fd <= 2; ++fd)
        posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", O_RDWR, 0);
    const int spawned = posix_spawn(&net_pid, self.c_str(), &actions, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&actions);
    control_to.child.reset();
    control_from.child.reset();
    frames_pipe.child.reset();
    input_pipe.child.reset();
    if (spawned != 0)
        return fatal("Unable to start the network process."), false;
    control_writer = std::make_unique<net_pipes::QueuedWriter>(
        control_to.parent.get(), 4u << 20, [] { fail_from_thread("The network process stopped."); });
    frame_writer = std::make_unique<net_pipes::QueuedWriter>(
        frames_pipe.parent.get(), 32u << 20, [] { fail_from_thread("The network process stopped."); });
    const auto from = control_from.parent.get();
    std::thread([from] {
        net_pipes::read_lines(from, [](std::string line) {
            g_main_context_invoke(nullptr, net_message, new std::string(std::move(line)));
        });
        fail_from_thread("The network process stopped.");
    }).detach();
    std::thread(read_input, input_pipe.parent.get()).detach();
    return true;
}

bool set_profile(JsonObject *object) {
    if (json_object_has_member(object, "streamPlan")) {
        auto node = json_object_get_member(object, "streamPlan");
        return node && JSON_NODE_HOLDS_OBJECT(node) &&
               parse_stream_profile(json_node_get_object(node), profile);
    }
    const std::string name = string_member(object, "profile");
    if (name == "mobile")
        profile = {1280, 720, 15, 2000, 1200};
    else if (name == "balanced")
        profile = {1920, 1080, 30, 4000, 1200};
    else if (name == "desktop" || name.empty())
        profile = {2560, 1440, 30, 6000, 1200};
    else
        return false;
    return true;
}

void start_source(JsonObject *object) {
    if (started)
        return fatal("Source already started");
    started = true;
    video_enabled = boolean_member(object, "video");
    const std::string format = string_member(object, "audioFormat");
    audio_channels = format == "mono-32k" ? 1 : format == "stereo-96k" ? 2 : 0;
    if (!video_enabled && !audio_channels)
        return fatal("Audio sources require an audio format");
    std::string description;
    if (video_enabled) {
        if (!set_profile(object))
            return fatal("Invalid stream profile");
        const std::string codec_id = string_member(object, "codec");
        video_codec = codec_id.empty() ? &video_codecs()[0] : find_video_codec(codec_id);
        if (!video_codec || video_codec->id == "av1")
            return fatal("The MG2 prototype encodes H.264 and H.265 only");
        description = "appsrc name=video-in is-live=true format=time do-timestamp=true caps=\"" +
                      video_codec->caps + "\" ! " + video_codec->parser +
                      " ! appsink name=video-sink sync=false async=false";
    }
    if (audio_channels)
        description +=
            std::string(description.empty() ? "" : "  ") +
            "audiotestsrc is-live=true wave=sine ! audioconvert ! audioresample ! "
            "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=" +
            std::to_string(audio_channels) + " ! opusenc bitrate=" +
            (audio_channels == 1 ? "32000" : "96000") +
            " bitrate-type=cbr frame-size=20 inband-fec=true ! "
            "appsink name=audio-sink sync=false async=false";
    GError *error = nullptr;
    pipeline = gst_parse_launch(description.c_str(), &error);
    if (error || !pipeline)
        return fatal(error ? error->message : "Unable to create the source.");
    video_in = gst_bin_get_by_name(GST_BIN(pipeline), "video-in");
    attach_sink("video-sink", video_sink);
    attach_sink("audio-sink", audio_sink);
    pending_ready = video_enabled ? typed_object("ready", {{"encoderBackend", "videotoolbox"},
                                                           {"encoderLabel", "VideoToolbox"},
                                                           {"encoder", "VTCompressionSession"},
                                                           {"encoderReason", "prototype"}})
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

gboolean command(gpointer data) {
    std::unique_ptr<std::string> text(static_cast<std::string *>(data));
    JsonParser *parser = nullptr;
    auto object = parse_object(*text, &parser);
    if (!object) {
        fatal("Invalid command JSON");
        return G_SOURCE_REMOVE;
    }
    const std::string type = string_member(object, "type");
    const std::string peer_id = string_member(object, "peerId");
    if (type == "start")
        start_source(object);
    else if (type == "add-peer")
        add_peer(peer_id, string_member(object, "sdp"));
    else if (type == "remove-peer") {
        if (peers.count(peer_id))
            send_net(typed_object("remove-peer", {{"peerId", peer_id}}));
        else
            emit("peer-closed", {{"peerId", peer_id}});
    } else if (type == "keyframe") {
        if (encoder)
            encoder->request_keyframe();
    } else if (type == "check-port") {
        auto reply = typed_object("port-owned", {{"peerId", peer_id}});
        json_object_set_boolean_member(reply, "owned", FALSE);
        write_object(reply);
    } else if (type == "stop")
        g_main_loop_quit(loop);
    if (parser)
        g_object_unref(parser);
    return G_SOURCE_REMOVE;
}

int session() {
    loop = g_main_loop_new(nullptr, FALSE);
    std::thread([] {
        std::string line;
        while (std::getline(std::cin, line))
            g_main_context_invoke(nullptr, command, new std::string(line));
        g_main_context_invoke(
            nullptr,
            [](gpointer) -> gboolean {
                g_main_loop_quit(loop);
                return G_SOURCE_REMOVE;
            },
            nullptr);
    }).detach();
    if (const char *path = g_getenv("VIDVNC_MG2_STATS"))
        g_timeout_add_seconds(
            2,
            [](gpointer path) -> gboolean {
                if (encoder) {
                    std::ofstream out(static_cast<const char *>(path), std::ios::app);
                    out << "{\"pid\":" << getpid() << ",\"t\":" << g_get_real_time() / 1000
                        << ",\"overflows\":" << overflows.exchange(0)
                        << ",\"encoder\":" << encoder->take_stats() << "}" << std::endl;
                }
                return G_SOURCE_CONTINUE;
            },
            const_cast<char *>(path));
    g_main_loop_run(loop);
    if (encoder)
        encoder->stop();
    if (net_pid)
        kill(net_pid, SIGKILL);
    if (pipeline)
        gst_element_set_state(pipeline, GST_STATE_NULL);
    return failed ? 1 : 0;
}

} // namespace

int main(int argc, char **argv) {
    // A closed pipe is reported by write(), as on Windows, rather than killing the process.
    signal(SIGPIPE, SIG_IGN);
    gst_init(&argc, &argv);
    if (argc == 6 && std::string(argv[1]) == "--network") {
        HANDLE handles[4] = {};
        for (int i = 0; i < 4; ++i) {
            char *end = nullptr;
            const auto value = std::strtol(argv[2 + i], &end, 10);
            if (!end || *end || value < 3)
                return 2;
            handles[i] = shim_handle(static_cast<int>(value));
        }
        return network_main(handles[0], handles[1], handles[2], handles[3]);
    }
    if (argc == 2 && std::string(argv[1]) == "--session")
        return session();
    // Screen Recording: report the current state, asking (once) if it is not granted.
    if (argc == 2 && std::string(argv[1]) == "--request-capture") {
        const bool before = CGPreflightScreenCaptureAccess();
        const bool after = before || CGRequestScreenCaptureAccess();
        std::cout << "{\"preflight\":" << (before ? "true" : "false")
                  << ",\"request\":" << (after ? "true" : "false") << "}" << std::endl;
        return after ? 0 : 1;
    }
    std::cerr << "Expected --session." << std::endl;
    return 2;
}
