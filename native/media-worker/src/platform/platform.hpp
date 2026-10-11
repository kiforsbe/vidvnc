#pragma once
// What the media worker needs from the operating system, behind one small interface per
// area: the process, display inventory, the video and audio sources, the input sink, the
// sandboxed launch of media-net, its port attestation and its own sandbox steps. The worker
// (media-worker.cpp) and media-net (media-net.cpp) are platform-neutral and call only this.
//
// Windows: platform/windows/ (DXGI and D3D11 capture, the hardware encoder families,
// SendInput, the tier T1 sandbox in sandbox.hpp, GetExtendedUdpTable).
// macOS: platform/macos/ (docs/superpowers/specs/2026-10-09-macos-support-design.md):
// ScreenCaptureKit and VideoToolbox through the worker's own elements (elements.hpp),
// CGEventPost, and the sandbox profile the launcher applies before `exec`.
#include <cstdint>
#include <optional>
#include <ostream>
#include <string>
#include <vector>
#include "../display-inventory.hpp"
#include "../encoder-backend.hpp"
#include "../encoder-selection.hpp"
#include "../net-pipes.hpp"
#include "../stream-profile.hpp"
#include "../video-codec.hpp"
#ifdef _WIN32
#include "../sandbox.hpp"
#else
#include <sys/types.h>
#endif

// The worker's diagnostic log (VIDVNC_NATIVE_LOG), or null when it is not open. Owned by
// media-worker.cpp; platform code writes lines to it the way the worker does.
std::ostream *worker_log();

namespace platform {

// ---- The process.

// Once, first thing in main: DPI awareness on Windows; on macOS, SIGPIPE ignored, so a closed
// pipe is an error to handle rather than a signal that ends the process.
void init_process();
unsigned long process_id();
// Ends this process at once, without cleanup. For the shutdown deadline and media-net's exit.
[[noreturn]] void exit_now(int code);
// Calls `on_exit` (from another thread) when the process that started this one exits. macOS
// only (design D8, defence in depth next to the owner pipe); on Windows this does nothing.
void watch_parent(void (*on_exit)());

// ---- Displays (display-inventory.hpp has the row and its JSON).

std::vector<CaptureDisplay> enumerate_displays();
// The primary display's size in pixels, for --probe.
DesktopRect primary_bounds();

// ---- Video and audio sources.

// Checks the operating system and the plugins every source needs; throws with what is
// missing.
void preflight();
// What --probe reports as `capture` ("dxgi" on Windows).
const char *capture_name();
// A GStreamer description from capture to the codec's parser, with the elements the worker
// probes named `capture` and `encoder`. `frames` limits capture (-1: unlimited).
struct VideoRequest {
    const std::optional<CaptureDisplay> &display;
    const StreamProfile &profile;
    const VideoCodec &codec;
    const EncoderBackend &backend;
    int frames = -1;
};
std::string video_pipeline(const VideoRequest &request);
// The audio branch from capture to `appsink name=audio-sink`, at 1 (mono-32k) or 2
// (stereo-96k) channels.
std::string audio_pipeline(int channels);

struct BackendAvailability {
    const EncoderBackend *backend;
    std::vector<std::string> codecs;
    bool on_capture_adapter;
};
// Every backend that really encodes each codec on this machine (--probe only: each answer is
// a real encode).
std::vector<BackendAvailability> available_backends(const std::optional<CaptureDisplay> &display);
// The encoder a stream of `codec_id` would use, without opening an encoder session.
Selection encoder_selection_for(const std::string &codec_id,
                                const std::optional<CaptureDisplay> &display,
                                const std::string &forced_backend);

// ---- Input. Each returns whether the event was posted; the broker tracks what is held.

// Empty when posted input reaches the system; otherwise why it cannot, for the owner. macOS
// drops posted events silently until the user approves the app that started VidVNC (gate MG3);
// Windows always accepts them.
std::string input_unavailable_reason();

// `code` is the platform's key code from input-policy.hpp.
bool post_key(unsigned short code, bool down);
bool post_button(int button, bool down);
// A normalised point (0..1) on the capture display, or the primary display without one.
bool post_move(double x, double y, const std::optional<CaptureDisplay> &display);
bool post_wheel(double delta);

// ---- media-net.

#ifdef _WIN32
using NetLaunch = sandbox::Launched;
#else
struct NetLaunch {
    pid_t pid = 0;
};
#endif
// The four ends media-net receives, in its argument order.
struct NetEnds {
    net_pipes::Native control_in, control_out, frames, input;
};
// Starts `<this executable> --network <four ends>` under the media-net sandbox. On failure
// returns false and says why in `error`; there is no unsandboxed fallback.
bool launch_network(const NetEnds &ends, NetLaunch &out, std::string &error);
// How media-net ended, for the log: an exit code, a signal, or "still running".
std::string network_exit(NetLaunch &launched);
void terminate_network(NetLaunch &launched);
// Whether 127.0.0.1:`port` (UDP) belongs to this media-net (design: answer attestation).
bool port_owned(const NetLaunch &launched, unsigned port);
// The socket audit, run every second: empty while media-net's network sockets are all on
// loopback, else the first one that is not, and the worker ends the source. macOS only, where
// the sandbox profile cannot stop media-net binding a LAN address (gate MG4); Windows' tier
// T1 sandbox needs no audit and this returns empty.
std::string network_socket_violation(const NetLaunch &launched);

// `media-worker --sandbox -- <program> [arguments]`, the launcher the relay runs under. On
// macOS also `--sandbox --network <four ends>`, how launch_network starts media-net.
int run_sandboxed(int argc, char **argv);

// Inside media-net, in this order: before plugins load (Winsock on Windows); after they have
// loaded and before any socket or peer data, the step that drops what it no longer needs
// (false: media-net must stop); and the run-time code guard, if the platform has one.
bool network_before_load();
bool network_drop_privileges();
bool network_code_guard();
// What media-net reports as its sandbox tier in net-ready.
const char *network_tier();
// How media-net ends: at once, with no orderly teardown (setting webrtcbin to NULL can hang).
[[noreturn]] void end_network_process(int code);

// ---- Network adapters.

// `media-worker --adapters`: the machine's network interfaces as one JSON array on stdout,
// read without sending anything (macOS; the server reads Windows adapters itself). Returns the
// exit code.
int list_adapters();

} // namespace platform
