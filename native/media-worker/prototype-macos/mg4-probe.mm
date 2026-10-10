// MG4 prototype only (throwaway): the macOS sandbox-probe. Run under the MG3 host app chain
// (app -> node -> this), whose app holds Screen Recording and Accessibility, so a candidate
// passes only if it stops a child from using grants the app really has.
//
//   mg4-probe --run-all                  parent: runs every candidate and prints the results
//   mg4-probe --child <port> <secret> <x> <y> [--self-sandbox <profile>] [--skip-documents]
//   mg4-probe --launch <profile> -- <program> [args...]   apply an SBPL profile, then exec
//
// Candidates (D3 in the macOS design): control (no sandbox), 1a an SBPL profile applied by a
// launcher before exec, 1b the same profile applied by the child after preloading GStreamer
// (as media-net drops privileges on Windows), 2 an App Sandbox helper executable (a copy of
// this binary signed with app-sandbox and network entitlements, no inherit). XPC (3) is not
// covered here.
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <libproc.h>
#include <mach-o/dyld.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <gst/gst.h>
#include <gst/sdp/sdp.h>
#include <gst/webrtc/webrtc.h>
#include <cerrno>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

extern char **environ;
extern "C" {
int sandbox_init(const char *profile, uint64_t flags, char **errorbuf);
void sandbox_free_error(char *errorbuf);
int sandbox_check(pid_t pid, const char *operation, int type, ...);
pid_t responsibility_get_pid_responsible_for_pid(pid_t);
}

namespace {

int failures = 0;
void line(const std::string &text) { std::cout << text << std::endl; }
void check(const std::string &name, bool ok, const std::string &detail = {}) {
    if (!ok)
        ++failures;
    line((ok ? "PASS: " : "FAIL: ") + name + (detail.empty() ? "" : " - " + detail));
}
void info(const std::string &text) { line("INFO: " + text); }
std::string err(int code = errno) { return std::string(strerror(code)) + " (" + std::to_string(code) + ")"; }

std::string self_path() {
    char path[PROC_PIDPATHINFO_MAXSIZE] = {};
    proc_pidpath(getpid(), path, sizeof(path));
    return path;
}
std::string pid_path(pid_t pid) {
    char path[PROC_PIDPATHINFO_MAXSIZE] = {};
    proc_pidpath(pid, path, sizeof(path));
    return path;
}

// ---- Child checks.

std::string capture_query() {
    __block std::string result = "timed out";
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,
                                                                   NSError *error) {
      result = error ? std::string("error: ") + error.localizedDescription.UTF8String
                     : "ok " + std::to_string(content.displays.count) + " displays";
      dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC));
    return result;
}

std::string capture_image() {
    __block std::string result = "timed out";
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,
                                                                   NSError *error) {
      if (error || content.displays.count == 0) {
          result = error ? std::string("no content: ") + error.localizedDescription.UTF8String
                         : "no display";
          dispatch_semaphore_signal(done);
          return;
      }
      SCContentFilter *filter =
          [[SCContentFilter alloc] initWithDisplay:content.displays.firstObject excludingWindows:@[]];
      SCStreamConfiguration *config = [SCStreamConfiguration new];
      config.width = 320;
      config.height = 200;
      [SCScreenshotManager captureImageWithFilter:filter
                                    configuration:config
                                completionHandler:^(CGImageRef image, NSError *shotError) {
                                  result = image ? "captured " + std::to_string(CGImageGetWidth(image)) +
                                                       "x" + std::to_string(CGImageGetHeight(image))
                                                 : std::string("error: ") +
                                                       (shotError ? shotError.localizedDescription.UTF8String
                                                                  : "no image");
                                  dispatch_semaphore_signal(done);
                                }];
    }];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC));
    return result;
}

bool udp_echo(unsigned short port, std::string &detail) {
    const int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0)
        return detail = "socket: " + err(), false;
    // Bound to 127.0.0.1 first, as libnice binds its host candidates.
    sockaddr_in self{};
    self.sin_family = AF_INET;
    self.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(s, reinterpret_cast<sockaddr *>(&self), sizeof(self)) != 0) {
        detail = "bind 127.0.0.1: " + err();
        close(s);
        return false;
    }
    sockaddr_in to{};
    to.sin_family = AF_INET;
    to.sin_port = htons(port);
    to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    const char ping[] = "mg4-ping";
    if (sendto(s, ping, sizeof(ping), 0, reinterpret_cast<sockaddr *>(&to), sizeof(to)) < 0) {
        detail = "sendto: " + err();
        close(s);
        return false;
    }
    pollfd p{s, POLLIN, 0};
    char reply[32] = {};
    const bool ok = poll(&p, 1, 2000) == 1 && recv(s, reply, sizeof(reply), 0) > 0 &&
                    std::string(reply) == "mg4-ping";
    detail = ok ? "echoed" : "no echo: " + err();
    close(s);
    return ok;
}

// Non-loopback UDP: a datagram to TEST-NET-1 (192.0.2.0/24), which goes nowhere.
std::string udp_outbound() {
    const int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0)
        return "socket denied: " + err();
    sockaddr_in to{};
    to.sin_family = AF_INET;
    to.sin_port = htons(9);
    inet_pton(AF_INET, "192.0.2.1", &to.sin_addr);
    const auto sent = sendto(s, "x", 1, 0, reinterpret_cast<sockaddr *>(&to), sizeof(to));
    const int code = errno;
    close(s);
    return sent >= 0 ? "sent" : "denied: " + err(code);
}
// Non-loopback TCP: a non-blocking connect to TEST-NET-1; EINPROGRESS means it was allowed.
std::string tcp_outbound() {
    const int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0)
        return "socket denied: " + err();
    fcntl(s, F_SETFL, O_NONBLOCK);
    sockaddr_in to{};
    to.sin_family = AF_INET;
    to.sin_port = htons(443);
    inet_pton(AF_INET, "192.0.2.1", &to.sin_addr);
    const int result = connect(s, reinterpret_cast<sockaddr *>(&to), sizeof(to));
    const int code = errno;
    close(s);
    return result == 0 || code == EINPROGRESS ? "allowed (connecting)" : "denied: " + err(code);
}
// This Mac's first non-loopback IPv4 address.
std::string lan_address() {
    ifaddrs *list = nullptr;
    std::string address;
    if (getifaddrs(&list) == 0) {
        for (auto row = list; row; row = row->ifa_next)
            if (row->ifa_addr && row->ifa_addr->sa_family == AF_INET &&
                !(row->ifa_flags & IFF_LOOPBACK) && (row->ifa_flags & IFF_UP)) {
                char text[INET_ADDRSTRLEN] = {};
                inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in *>(row->ifa_addr)->sin_addr, text,
                          sizeof(text));
                address = text;
                break;
            }
        freeifaddrs(list);
    }
    return address;
}
constexpr unsigned short lan_port = 47123, wildcard_port = 47124;
// A socket bound to 0.0.0.0 on a fixed port; the parent sends there through the LAN address.
std::string wildcard_inbound(bool &received) {
    received = false;
    const int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0)
        return "socket denied: " + err();
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = htons(wildcard_port);
    local.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(s, reinterpret_cast<sockaddr *>(&local), sizeof(local)) != 0) {
        const auto text = "bind 0.0.0.0 denied: " + err();
        close(s);
        return text;
    }
    pollfd p{s, POLLIN, 0};
    char buffer[64];
    const int ready = poll(&p, 1, 1500);
    const auto got = ready == 1 ? recv(s, buffer, sizeof(buffer), 0) : -1;
    const int code = errno;
    close(s);
    received = got > 0;
    return std::string("bound 0.0.0.0:") + std::to_string(wildcard_port) + ", " +
           (received ? "received the parent's LAN datagram"
                     : ready == 1 ? "receive denied: " + err(code) : "nothing received in 1.5 s");
}
// Bind to the LAN address on a fixed port and wait for the datagrams the parent keeps sending
// there. Returns "bound", "received" or the error.
std::string lan_inbound(bool &bound, bool &received) {
    bound = received = false;
    const auto address = lan_address();
    if (address.empty())
        return "no LAN address found";
    const int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0)
        return "socket denied: " + err();
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = htons(lan_port);
    inet_pton(AF_INET, address.c_str(), &local.sin_addr);
    if (bind(s, reinterpret_cast<sockaddr *>(&local), sizeof(local)) != 0) {
        const auto text = "bind " + address + " denied: " + err();
        close(s);
        return text;
    }
    bound = true;
    pollfd p{s, POLLIN, 0};
    char buffer[64];
    const int ready = poll(&p, 1, 1500);
    const auto got = ready == 1 ? recv(s, buffer, sizeof(buffer), 0) : -1;
    const int code = errno;
    close(s);
    received = got > 0;
    return "bound " + address + ":" + std::to_string(lan_port) + ", " +
           (received ? "received the parent's datagram"
                     : ready == 1 ? "receive denied: " + err(code) : "nothing received in 1.5 s");
}

bool gather(std::string &detail) {
    GstElement *pipeline = gst_pipeline_new("probe");
    GstElement *webrtc = gst_element_factory_make("webrtcbin", "webrtc");
    if (!webrtc) {
        detail = "webrtcbin could not be created";
        gst_object_unref(pipeline);
        return false;
    }
    gst_bin_add(GST_BIN(pipeline), webrtc);
    GstWebRTCICE *ice = nullptr;
    g_object_get(webrtc, "ice-agent", &ice, nullptr);
    gboolean added = FALSE;
    if (ice) {
        g_signal_emit_by_name(ice, "add-local-ip-address", "127.0.0.1", &added);
        gst_object_unref(ice);
    }
    GstCaps *caps = gst_caps_from_string(
        "application/x-rtp,media=audio,encoding-name=OPUS,payload=96,clock-rate=48000");
    GstWebRTCRTPTransceiver *transceiver = nullptr;
    g_signal_emit_by_name(webrtc, "add-transceiver", GST_WEBRTC_RTP_TRANSCEIVER_DIRECTION_SENDONLY,
                          caps, &transceiver);
    gst_caps_unref(caps);
    if (transceiver)
        gst_object_unref(transceiver);
    gst_element_set_state(pipeline, GST_STATE_PLAYING);
    GstPromise *promise = gst_promise_new();
    g_signal_emit_by_name(webrtc, "create-offer", nullptr, promise);
    gst_promise_wait(promise);
    GstWebRTCSessionDescription *offer = nullptr;
    if (const GstStructure *reply = gst_promise_get_reply(promise))
        gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr);
    gst_promise_unref(promise);
    bool ok = false;
    if (!added)
        detail = "the ICE agent refused 127.0.0.1";
    else if (!offer)
        detail = "no offer";
    else {
        GstPromise *set = gst_promise_new();
        g_signal_emit_by_name(webrtc, "set-local-description", offer, set);
        gst_promise_wait(set);
        gst_promise_unref(set);
        gst_webrtc_session_description_free(offer);
        GstWebRTCICEGatheringState state = GST_WEBRTC_ICE_GATHERING_STATE_NEW;
        for (int i = 0; i < 100 && state != GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE; i++) {
            g_usleep(100000);
            g_object_get(webrtc, "ice-gathering-state", &state, nullptr);
        }
        GstWebRTCSessionDescription *local = nullptr;
        g_object_get(webrtc, "local-description", &local, nullptr);
        gchar *text = local ? gst_sdp_message_as_text(local->sdp) : nullptr;
        const std::string sdp = text ? text : "";
        g_free(text);
        if (local)
            gst_webrtc_session_description_free(local);
        const bool candidate = sdp.find(" 127.0.0.1 ") != std::string::npos;
        const bool fingerprint = sdp.find("a=fingerprint:") != std::string::npos;
        ok = state == GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE && candidate && fingerprint;
        detail = std::string("gathering ") +
                 (state == GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE ? "complete" : "incomplete") +
                 ", loopback candidate " + (candidate ? "yes" : "no") + ", DTLS fingerprint " +
                 (fingerprint ? "yes" : "no");
    }
    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(pipeline);
    return ok;
}

std::string read_file(const std::string &path) {
    std::ifstream in(path);
    std::stringstream text;
    text << in.rdbuf();
    return text.str();
}

int child(unsigned short port, const std::string &secret, double x, double y,
          const std::string &self_profile, bool skip_documents) {
    const pid_t responsible = responsibility_get_pid_responsible_for_pid(getpid());
    info("pid " + std::to_string(getpid()) + ", responsible " + std::to_string(responsible) + " " +
         pid_path(responsible));
    GError *error = nullptr;
    const bool initialised = gst_init_check(nullptr, nullptr, &error);
    check("GStreamer initialised", initialised, error ? error->message : "");
    if (!initialised)
        return 1;
    for (const char *name :
         {"coreelements", "app", "rtp", "rtpmanager", "webrtc", "nice", "dtls", "srtp", "sctp"}) {
        GstPlugin *plugin = gst_plugin_load_by_name(name);
        check(std::string("preloaded plugin ") + name, plugin != nullptr);
        if (plugin)
            gst_object_unref(plugin);
    }
    if (!self_profile.empty()) {
        char *message = nullptr;
        const int result = sandbox_init(read_file(self_profile).c_str(), 0, &message);
        check("applied the SBPL profile to itself after preloading", result == 0,
              message ? message : "");
        if (message)
            sandbox_free_error(message);
    }
    info(std::string("sandboxed: ") + (sandbox_check(getpid(), nullptr, 0) ? "yes" : "no"));

    // What it must not be able to do.
    info(std::string("CGPreflightScreenCaptureAccess ") +
         (CGPreflightScreenCaptureAccess() ? "true" : "false"));
    const auto query = capture_query();
    const auto image = capture_image();
    check("cannot capture the screen", query.rfind("ok", 0) != 0 && image.rfind("captured", 0) != 0,
          "shareable content: " + query + "; screenshot: " + image);
    info(std::string("CGPreflightPostEventAccess ") +
         (CGPreflightPostEventAccess() ? "true" : "false") + ", AXIsProcessTrusted " +
         (AXIsProcessTrusted() ? "true" : "false"));
    auto move = CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, CGPointMake(x, y),
                                        kCGMouseButtonLeft);
    if (move) {
        CGEventPost(kCGHIDEventTap, move);
        CFRelease(move);
        info("posted a mouse move (the parent checks whether it landed)");
    } else
        info("could not create a mouse event");
    const int file = open(secret.c_str(), O_RDONLY);
    check("cannot read a file in the user's home", file < 0, file < 0 ? err() : "it was opened");
    if (file >= 0)
        close(file);
    if (skip_documents)
        info("~/Documents not tried (unsandboxed control: it would prompt for the host app)");
    else {
        const std::string documents = std::string(getenv("HOME") ? getenv("HOME") : "") + "/Documents";
        DIR *dir = opendir(documents.c_str());
        check("cannot list ~/Documents", !dir, dir ? "it was listed" : err());
        if (dir)
            closedir(dir);
    }
    const auto udp = udp_outbound();
    check("cannot send UDP to a non-loopback address", udp.rfind("sent", 0) != 0, udp);
    const auto tcp = tcp_outbound();
    check("cannot connect TCP to a non-loopback address", tcp.rfind("allowed", 0) != 0, tcp);
    bool lan_bound = false, lan_received = false;
    const auto lan = lan_inbound(lan_bound, lan_received);
    check("cannot receive on the LAN address", !lan_received, lan);
    if (lan_bound)
        info("binding to the LAN address itself was allowed");
    bool wildcard_received = false;
    const auto wildcard = wildcard_inbound(wildcard_received);
    check("cannot receive LAN datagrams on a 0.0.0.0 socket", !wildcard_received, wildcard);
    const pid_t forked = fork();
    if (forked == 0)
        _exit(0);
    if (forked > 0)
        waitpid(forked, nullptr, 0);
    check("cannot fork", forked < 0, forked < 0 ? err() : "forked");
    pid_t spawned = 0;
    char *const argv[] = {const_cast<char *>("/usr/bin/true"), nullptr};
    const int spawn_result = posix_spawn(&spawned, "/usr/bin/true", nullptr, nullptr, argv, environ);
    if (spawn_result == 0)
        waitpid(spawned, nullptr, 0);
    check("cannot exec /usr/bin/true", spawn_result != 0,
          spawn_result ? err(spawn_result) : "it ran");

    // What it must still be able to do.
    std::string detail;
    check("UDP on loopback works", udp_echo(port, detail), detail);
    check("webrtcbin gathers on loopback", gather(detail), detail);
    line(failures ? "RESULT: FAIL" : "RESULT: PASS");
    return failures ? 1 : 0;
}

// ---- Launcher: apply a profile to itself, then exec (sandbox-exec, as `media-worker --sandbox`).

int launch(const std::string &profile, char **argv) {
    char *message = nullptr;
    if (sandbox_init(read_file(profile).c_str(), 0, &message) != 0) {
        std::cout << "FAIL: launcher could not apply the profile - " << (message ? message : "")
                  << std::endl;
        return 3;
    }
    execv(argv[0], argv);
    std::cout << "FAIL: launcher could not exec " << argv[0] << " - " << err() << std::endl;
    return 3;
}

// ---- Parent.

std::string profile_text(const std::string &gstreamer, const std::string &executable,
                         bool for_exec) {
    // Deny by default. Reads: the system, GStreamer, this executable, and (for a profile applied
    // before exec) what dyld and GStreamer read while loading. Network: loopback only. No
    // mach-lookup at all, no fork, no exec (except the one exec of the launched program).
    std::ostringstream text;
    text << "(version 1)\n(deny default)\n"
         << "(allow file-read* (subpath \"/System\") (subpath \"/usr/lib\") (subpath \"/usr/share\")"
            " (subpath \"/private/var/db/timezone\") (literal \"/private/etc/localtime\")"
            " (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/dev/null\")"
            " (subpath \"/private/var/db/dyld\") (subpath \""
         << gstreamer << "\") (literal \"" << executable << "\"))\n"
         << "(allow file-read-metadata)\n"
         << "(allow file-write-data (literal \"/dev/null\"))\n"
         << "(allow sysctl-read)\n"
         << "(allow system-socket)\n"
         << (getenv("MG4_NET_RULES") ? std::string(getenv("MG4_NET_RULES")) + "\n"
                                     : "(allow network-bind (local ip \"localhost:*\"))\n"
                                       "(allow network-outbound (remote ip \"localhost:*\"))\n"
                                       "(allow network-inbound (local ip \"localhost:*\"))\n")
         << "(allow process-info* (target self))\n";
    if (for_exec)
        text << "(allow process-exec (literal \"" << executable << "\"))\n"
             << "(allow file-map-executable (subpath \"/System\") (subpath \"/usr/lib\")"
                " (subpath \"/private/preboot\") (subpath \""
             << gstreamer << "\") (literal \"" << executable << "\"))\n"
             << "(allow file-read* (literal \"/\") (subpath \"/private/preboot\"))\n"
             << "(allow file-read* (subpath \"" << getenv("HOME")
             << "/.cache/gstreamer-1.0\"))\n";
    return text.str();
}

// MG5: the relay's profile. As media-net's, minus GStreamer, but with the network open: the
// relay serves LAN clients on its public port and reaches the workers on loopback, and SBPL
// cannot narrow either. `extra` adds a read-only subpath (GStreamer, for the probe's own run).
std::string relay_profile_text(const std::string &executable, const std::string &extra) {
    std::ostringstream text;
    text << "(version 1)\n(deny default)\n"
         << "(allow file-read* (literal \"/\") (subpath \"/System\") (subpath \"/usr/lib\")"
            " (subpath \"/usr/share\") (subpath \"/private/preboot\") (subpath \"/private/var/db/dyld\")"
            " (subpath \"/private/var/db/timezone\") (literal \"/private/etc/localtime\")"
            " (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/dev/null\")"
            " (literal \""
         << executable << "\"))\n"
         << "(allow file-read-metadata)\n"
         << "(allow file-write-data (literal \"/dev/null\"))\n"
         << "(allow file-map-executable (subpath \"/System\") (subpath \"/usr/lib\")"
            " (subpath \"/private/preboot\") (literal \""
         << executable << "\"))\n"
         << "(allow process-exec (literal \"" << executable << "\"))\n"
         << "(allow sysctl-read)\n(allow system-socket)\n"
         << "(allow network-bind network-inbound (local udp \"*:*\"))\n"
         << "(allow network-outbound (remote udp \"*:*\"))\n"
         << "(allow process-info* (target self))\n";
    if (!extra.empty())
        text << "(allow file-read* file-map-executable (subpath \"" << extra << "\"))\n"
             << "(allow file-read* (subpath \"" << getenv("HOME") << "/.cache/gstreamer-1.0\"))\n";
    return text.str();
}

struct Run {
    std::string name;
    std::vector<std::string> argv;
};

int run_all() {
    const std::string self = self_path();
    const std::string home = getenv("HOME");
    const std::string work = home + "/Library/Caches/VidVNC-MG4";
    mkdir(work.c_str(), 0700);
    // A secret in the user's home, outside ~/Documents (which would prompt for the host app).
    const std::string secret = work + "/secret.txt";
    std::ofstream(secret) << "mg4 secret\n";
    // The GStreamer framework this binary loaded.
    std::string gstreamer;
    for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
        const std::string image = _dyld_get_image_name(i);
        const auto at = image.find("GStreamer.framework");
        if (at != std::string::npos) {
            gstreamer = image.substr(0, at + strlen("GStreamer.framework"));
            break;
        }
    }
    char real[PATH_MAX] = {};
    realpath(gstreamer.c_str(), real);
    gstreamer = real;
    const std::string exec_profile = work + "/launcher.sb";
    const std::string self_profile = work + "/self.sb";
    std::ofstream(exec_profile) << profile_text(gstreamer, self, true);
    std::ofstream(self_profile) << profile_text(gstreamer, self, false);
    const std::string relay_profile = work + "/relay-probe.sb";
    std::ofstream(relay_profile) << relay_profile_text(self, gstreamer);

    // UDP echo on loopback.
    const int echo = socket(AF_INET, SOCK_DGRAM, 0);
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bind(echo, reinterpret_cast<sockaddr *>(&local), sizeof(local));
    socklen_t length = sizeof(local);
    getsockname(echo, reinterpret_cast<sockaddr *>(&local), &length);
    const auto port = std::to_string(ntohs(local.sin_port));
    std::thread([echo] {
        char buffer[64];
        sockaddr_in from{};
        for (;;) {
            socklen_t size = sizeof(from);
            const auto n = recvfrom(echo, buffer, sizeof(buffer), 0,
                                    reinterpret_cast<sockaddr *>(&from), &size);
            if (n > 0)
                sendto(echo, buffer, n, 0, reinterpret_cast<sockaddr *>(&from), size);
        }
    }).detach();

    // Datagrams to the LAN address on the fixed port, for the children's inbound check.
    std::thread([] {
        const auto address = lan_address();
        const int s = socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in to{};
        to.sin_family = AF_INET;
        to.sin_port = htons(lan_port);
        inet_pton(AF_INET, address.c_str(), &to.sin_addr);
        sockaddr_in wild = to;
        wild.sin_port = htons(wildcard_port);
        for (;;) {
            sendto(s, "mg4-lan", 7, 0, reinterpret_cast<sockaddr *>(&to), sizeof(to));
            sendto(s, "mg4-lan", 7, 0, reinterpret_cast<sockaddr *>(&wild), sizeof(wild));
            usleep(100000);
        }
    }).detach();
    const std::string helper = std::string(self).substr(0, self.rfind('/')) + "/mg4-probe-appsandbox";
    std::cout << "INFO: parent pid " << getpid() << ", responsible "
              << responsibility_get_pid_responsible_for_pid(getpid()) << " "
              << pid_path(responsibility_get_pid_responsible_for_pid(getpid())) << std::endl;
    std::cout << "INFO: GStreamer " << gstreamer << std::endl;

    int failed_candidates = 0;
    for (const std::string candidate : {"control", "1a-launcher-profile", "1b-self-applied-profile",
                                        "2-app-sandbox-helper", "relay-profile"}) {
        auto start = CGEventGetLocation(CGEventCreate(nullptr));
        const double tx = start.x + 60, ty = start.y + 60;
        std::vector<std::string> args;
        const std::vector<std::string> child_args{"--child", port, secret, std::to_string(tx),
                                                  std::to_string(ty)};
        if (candidate == "control") {
            args = {self};
            args.insert(args.end(), child_args.begin(), child_args.end());
            args.push_back("--skip-documents");
        } else if (candidate == "1a-launcher-profile") {
            args = {self, "--launch", exec_profile, "--", self};
            args.insert(args.end(), child_args.begin(), child_args.end());
        } else if (candidate == "1b-self-applied-profile") {
            args = {self};
            args.insert(args.end(), child_args.begin(), child_args.end());
            args.insert(args.end(), {"--self-sandbox", self_profile});
        } else if (candidate == "relay-profile") {
            args = {self, "--launch", relay_profile, "--", self};
            args.insert(args.end(), child_args.begin(), child_args.end());
        } else {
            args = {helper};
            args.insert(args.end(), child_args.begin(), child_args.end());
        }
        std::cout << "\n=== " << candidate << std::endl;
        std::vector<char *> argv;
        for (auto &arg : args)
            argv.push_back(arg.data());
        argv.push_back(nullptr);
        int pipe_fds[2];
        pipe(pipe_fds);
        posix_spawn_file_actions_t actions;
        posix_spawn_file_actions_init(&actions);
        posix_spawn_file_actions_adddup2(&actions, pipe_fds[1], 1);
        posix_spawn_file_actions_adddup2(&actions, pipe_fds[1], 2);
        pid_t pid = 0;
        setenv("GST_REGISTRY_UPDATE", "no", 1);
        setenv("GST_REGISTRY_FORK", "no", 1);
        const int spawned = posix_spawn(&pid, argv[0], &actions, nullptr, argv.data(), environ);
        posix_spawn_file_actions_destroy(&actions);
        close(pipe_fds[1]);
        std::string output;
        char buffer[4096];
        ssize_t n;
        while ((n = read(pipe_fds[0], buffer, sizeof(buffer))) > 0)
            output.append(buffer, n);
        close(pipe_fds[0]);
        int status = 0;
        if (spawned == 0)
            waitpid(pid, &status, 0);
        // Keep the probe's own lines; GLib noise is dropped.
        std::istringstream rows(output);
        std::string row;
        while (std::getline(rows, row))
            if (row.rfind("PASS:", 0) == 0 || row.rfind("FAIL:", 0) == 0 ||
                row.rfind("INFO:", 0) == 0 || row.rfind("RESULT:", 0) == 0)
                std::cout << row << std::endl;
        if (spawned != 0)
            std::cout << "FAIL: could not start - " << err(spawned) << std::endl;
        else if (!WIFEXITED(status))
            std::cout << "INFO: ended by signal " << WTERMSIG(status) << std::endl;
        auto now = CGEventGetLocation(CGEventCreate(nullptr));
        const bool landed = std::abs(now.x - tx) < 2 && std::abs(now.y - ty) < 2;
        std::cout << (landed ? "FAIL" : "PASS") << ": the posted mouse move did not land - "
                  << (landed ? "it landed" : "cursor unchanged") << std::endl;
        auto back = CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, start, kCGMouseButtonLeft);
        CGEventPost(kCGHIDEventTap, back);
        CFRelease(back);
        usleep(200000);
        const bool child_failed = spawned != 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0;
        if (candidate != "control" && candidate != "relay-profile" && (child_failed || landed))
            ++failed_candidates;
    }
    std::cout << "\nRESULT: " << failed_candidates << " of 3 sandbox candidates failed" << std::endl;
    return 0;
}

} // namespace

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    if (argc >= 5 && std::string(argv[1]) == "--launch" && std::string(argv[3]) == "--")
        return launch(argv[2], argv + 4);
    if (argc >= 6 && std::string(argv[1]) == "--child") {
        std::string profile;
        bool skip_documents = false;
        for (int i = 6; i < argc; ++i) {
            if (std::string(argv[i]) == "--self-sandbox" && i + 1 < argc)
                profile = argv[++i];
            else if (std::string(argv[i]) == "--skip-documents")
                skip_documents = true;
        }
        return child(static_cast<unsigned short>(std::stoi(argv[2])), argv[3], std::stod(argv[4]),
                     std::stod(argv[5]), profile, skip_documents);
    }
    // MG6: UDP to <host>:9 and TCP to <host>:80 from a binary built with the macOS 27 SDK.
    if (argc == 3 && std::string(argv[1]) == "--lan-send") {
        sockaddr_in to{};
        to.sin_family = AF_INET;
        inet_pton(AF_INET, argv[2], &to.sin_addr);
        to.sin_port = htons(9);
        const int u = socket(AF_INET, SOCK_DGRAM, 0);
        const auto sent = sendto(u, "mg6", 3, 0, reinterpret_cast<sockaddr *>(&to), sizeof(to));
        const std::string udp = sent >= 0 ? "sent" : err();
        close(u);
        to.sin_port = htons(80);
        const int t = socket(AF_INET, SOCK_STREAM, 0);
        const int result = connect(t, reinterpret_cast<sockaddr *>(&to), sizeof(to));
        const std::string tcp = result == 0 ? "connected" : err();
        close(t);
        std::cout << "{\"test\":\"lan-native\",\"udp\":\"" << udp << "\",\"tcp\":\"" << tcp
                  << "\",\"responsible\":\"" << pid_path(responsibility_get_pid_responsible_for_pid(getpid()))
                  << "\"}" << std::endl;
        return 0;
    }
    if (argc == 3 && std::string(argv[1]) == "--is-sandboxed") {
        std::cout << (sandbox_check(std::stoi(argv[2]), nullptr, 0) ? "sandboxed" : "not sandboxed")
                  << std::endl;
        return 0;
    }
    if ((argc == 3 || argc == 4) && std::string(argv[1]) == "--print-relay-profile") {
        std::cout << relay_profile_text(argv[2], argc == 4 ? argv[3] : "");
        return 0;
    }
    // The launcher profile for another program (for media-net under the stand-in worker).
    if (argc == 4 && std::string(argv[1]) == "--print-profile") {
        std::cout << profile_text(argv[3], argv[2], true);
        return 0;
    }
    if (argc == 2 && std::string(argv[1]) == "--run-all")
        return run_all();
    std::cerr << "Expected --run-all." << std::endl;
    return 2;
}
