// MG1 prototype only (throwaway): a stand-in for media-worker on macOS, just enough of the
// owner-side protocol (native-media.mjs) for tests/relay-check.mjs. It runs the real media-net
// (media-net.cpp, compiled unmodified through the shim in shim/) as `--network <fds>`, feeds it
// Opus from audiotestsrc, and passes answers and peer events through. No capture, no input
// broker, no sandbox.
#include <windows.h>
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <json-glib/json-glib.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>
#include <mach-o/dyld.h>
#include <atomic>
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

extern char **environ;

namespace {

GMainLoop *loop = nullptr;
GstElement *pipeline = nullptr;
bool started = false, playing = false, failed = false, net_ready = false;
int audio_channels = 0;
JsonObject *pending_ready = nullptr;
std::set<std::string> peers;
std::vector<std::pair<std::string, std::string>> waiting_peers;
std::mutex stdout_mutex, frame_mutex;
pid_t net_pid = 0;
net_pipes::Pipe control_to, control_from, frames_pipe, input_pipe;
std::unique_ptr<net_pipes::QueuedWriter> control_writer, frame_writer;
std::string sent_caps;

void write_object(JsonObject *object) {
    std::lock_guard<std::mutex> lock(stdout_mutex);
    std::cout << object_text(object) << std::endl;
    json_object_unref(object);
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
void fail_from_thread(const char *message) {
    g_main_context_invoke(
        nullptr,
        [](gpointer text) -> gboolean {
            fatal(static_cast<const char *>(text));
            return G_SOURCE_REMOVE;
        },
        const_cast<char *>(message));
}
void send_net(JsonObject *object) {
    const auto line = object_text(object) + "\n";
    json_object_unref(object);
    if (!control_writer || !control_writer->push(line))
        fatal("The network process stopped accepting commands.");
}

GstFlowReturn new_sample(GstAppSink *sink, gpointer) {
    auto sample = gst_app_sink_pull_sample(sink);
    if (!sample)
        return GST_FLOW_EOS;
    const auto buffer = gst_sample_get_buffer(sample);
    const auto caps = gst_sample_get_caps(sample);
    std::lock_guard<std::mutex> lock(frame_mutex);
    if (buffer && caps && frame_writer) {
        gchar *caps_text = gst_caps_to_string(caps);
        if (sent_caps != caps_text) {
            net_records::FrameHeader header{net_records::FrameKind::AudioCaps, 0,
                                            static_cast<std::uint32_t>(strlen(caps_text)), 0};
            if (frame_writer->push(net_records::encode_frame(header, caps_text)))
                sent_caps = caps_text;
        }
        g_free(caps_text);
        GstMapInfo map{};
        if (gst_buffer_map(buffer, &map, GST_MAP_READ)) {
            net_records::FrameHeader header{
                net_records::FrameKind::AudioBuffer, 0, static_cast<std::uint32_t>(map.size),
                GST_BUFFER_DURATION_IS_VALID(buffer) ? GST_BUFFER_DURATION(buffer) : 0};
            frame_writer->push(net_records::encode_frame(header, map.data));
            gst_buffer_unmap(buffer, &map);
        }
    }
    gst_sample_unref(sample);
    return GST_FLOW_OK;
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
        }
    } else if (type == "peer-failed" && peers.count(peer_id)) {
        peers.erase(peer_id);
        emit("peer-failed", {{"peerId", peer_id}, {"reason", string_member(object, "reason")}});
    } else if (type == "peer-closed") {
        peers.erase(peer_id);
        emit("peer-closed", {{"peerId", peer_id}});
    } else if (type == "log")
        std::cerr << "NET " << string_member(object, "text") << std::endl;
    else if (type == "fatal")
        fatal(std::string("Network process failed: ") + string_member(object, "reason"));
    else if (type != "peer-metrics" && type != "channel-closed" && type != "keyframe-request")
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
    // Input records are drained and dropped: the prototype has no input broker.
    const auto input = input_pipe.parent.get();
    std::thread([input] {
        char buffer[8192];
        DWORD received = 0;
        while (ReadFile(input, buffer, sizeof(buffer), &received, nullptr) && received) {
        }
    }).detach();
    return true;
}

void start_source(JsonObject *object) {
    if (started)
        return fatal("Source already started");
    started = true;
    if (boolean_member(object, "video"))
        return fatal("The MG1 prototype streams audio only");
    const std::string format = string_member(object, "audioFormat");
    audio_channels = format == "mono-32k" ? 1 : format == "stereo-96k" ? 2 : 0;
    if (!audio_channels)
        return fatal("Audio sources require an audio format");
    const std::string description =
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
    auto sink = gst_bin_get_by_name(GST_BIN(pipeline), "audio-sink");
    GstAppSinkCallbacks callbacks{};
    callbacks.new_sample = new_sample;
    gst_app_sink_set_callbacks(GST_APP_SINK(sink), &callbacks, nullptr, nullptr);
    gst_object_unref(sink);
    pending_ready = typed_object("ready");
    if (!start_network())
        return;
    auto configuration = typed_object("configure");
    json_object_set_boolean_member(configuration, "video", FALSE);
    json_object_set_int_member(configuration, "audioChannels", audio_channels);
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
    g_main_loop_run(loop);
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
    std::cerr << "Expected --session." << std::endl;
    return 2;
}
