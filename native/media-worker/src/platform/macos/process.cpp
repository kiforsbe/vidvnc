// The process, media-net's launch and attestation, and the relay's launcher on macOS.
//
// media-net and the relay run under a sandbox profile the launcher applies before `exec`
// (design D3, gate MG4). That launcher is phase 4 of the macOS plan; until it lands, both
// launches fail by name, because the worker never starts media-net or the relay unsandboxed.
// Port attestation and media-net's own steps are already the macOS ones.
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include "../platform.hpp"
#include "udp-ports.hpp"

namespace platform {

// A pipe whose reader is gone, or the server's stdout, fails with EPIPE instead of ending the
// worker before it can release held input.
void init_process() { signal(SIGPIPE, SIG_IGN); }

unsigned long process_id() { return static_cast<unsigned long>(getpid()); }

void exit_now(int code) { _exit(code); }

static const char *const sandbox_missing =
    "the macOS sandbox for media-net is not implemented yet (macOS plan, phase 4)";

bool launch_network(const NetEnds &, NetLaunch &, std::string &error) {
    error = sandbox_missing;
    return false;
}

std::string network_exit(NetLaunch &launched) {
    if (launched.pid <= 0)
        return {};
    int status = 0;
    pid_t ended = 0;
    // As on Windows, give it half a second to finish ending.
    for (int i = 0; i < 50 && (ended = waitpid(launched.pid, &status, WNOHANG)) == 0; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if (ended != launched.pid)
        return "still running";
    launched.pid = 0;
    if (WIFSIGNALED(status))
        return "signal " + std::to_string(WTERMSIG(status));
    return std::to_string(WEXITSTATUS(status));
}

void terminate_network(NetLaunch &launched) {
    if (launched.pid <= 0)
        return;
    kill(launched.pid, SIGKILL);
    waitpid(launched.pid, nullptr, 0);
    launched.pid = 0;
}

bool port_owned(const NetLaunch &launched, unsigned port) {
    return macos::udp_loopback_bound(launched.pid, port);
}

int run_sandboxed(int, char **) {
    std::cerr << "Unable to start the sandboxed program: " << sandbox_missing << std::endl;
    return 2;
}

// Nothing to start before plugins load, and no token to drop: on macOS the sandbox profile is
// applied before `exec`, so media-net never holds more than it needs (design D2). There is no
// run-time code guard. The tier says "none" until phase 4 applies the profile.
bool network_before_load() { return true; }
bool network_drop_privileges() { return true; }
bool network_code_guard() { return false; }
const char *network_tier() { return "none"; }

void end_network_process(int code) { _exit(code); }

} // namespace platform
