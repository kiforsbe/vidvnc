// The process, media-net's launch and attestation, the socket audit, and the relay's launcher
// on macOS.
//
// media-net and the relay run under a sandbox profile (sandbox-profile.hpp) that the launcher
// applies before `exec` (design D3, gate MG4); the worker never starts either without it.
//
// - media-net: the worker spawns `media-worker --sandbox --network <3> <4> <5> <6>` with only
//   its four pipe ends (as descriptors 3 to 6) and the null device; that launcher applies the
//   media-net profile and execs `media-worker --network ...` in place, so the pid the worker
//   attests ports against is media-net's own.
// - The relay: the server runs `media-worker --sandbox -- <node> ...`; the launcher applies the
//   relay profile in a child, execs the program there, and waits, like the Windows launcher.
//   It forwards the server's stop signals and kills the program if the server goes away.
#include <crt_externs.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <libproc.h>
#include <sandbox.h>
#include <signal.h>
#include <spawn.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <unistd.h>
#include <chrono>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <set>
#include <string>
#include <thread>
#include <vector>
#include "../platform.hpp"
#include "sandbox-apply.hpp"
#include "udp-ports.hpp"

namespace platform {

// A pipe whose reader is gone, or the server's stdout, fails with EPIPE instead of ending the
// worker before it can release held input.
void init_process() { signal(SIGPIPE, SIG_IGN); }

unsigned long process_id() { return static_cast<unsigned long>(getpid()); }

void exit_now(int code) { _exit(code); }

// Closes every descriptor above the standard three but `keep`, so the sandboxed program gets
// nothing it was not meant to.
static void close_inherited(int keep) {
    const int size = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, nullptr, 0);
    if (size <= 0)
        return;
    std::vector<proc_fdinfo> fds(static_cast<std::size_t>(size) / sizeof(proc_fdinfo));
    const int filled = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds.data(),
                                    static_cast<int>(fds.size() * sizeof(proc_fdinfo)));
    for (int i = 0; filled > 0 && i < filled / static_cast<int>(sizeof(proc_fdinfo)); ++i)
        if (fds[i].proc_fd > 2 && fds[i].proc_fd != keep)
            close(fds[i].proc_fd);
}

// ---- The parent watch (design D8): a kqueue NOTE_EXIT on the process that started this one.

// Waits on `queue` (which already watches the parent) until the parent exits. A parent that
// was already gone when the watch began is caught by comparing the parent pid afterwards.
static bool watch_parent_on(int queue, pid_t parent) {
    struct kevent change;
    EV_SET(&change, parent, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
    if (kevent(queue, &change, 1, nullptr, 0, nullptr) != 0)
        return false; // ESRCH: already gone
    return getppid() == parent;
}

void watch_parent(void (*on_exit)()) {
    const pid_t parent = getppid();
    std::thread([parent, on_exit] {
        const int queue = kqueue();
        if (queue < 0)
            return;
        if (watch_parent_on(queue, parent)) {
            struct kevent event;
            while (kevent(queue, nullptr, 0, &event, 1, nullptr) < 0 && errno == EINTR) {
            }
        }
        close(queue);
        on_exit();
    }).detach();
}

// ---- media-net.

static const char *const network_flag = "--network";

bool launch_network(const NetEnds &ends, NetLaunch &out, std::string &error) {
    const auto executable = macos::self_path();
    if (executable.empty()) {
        error = "the media worker executable was not found";
        return false;
    }
    // Copies of the four ends above anything they could collide with when posix_spawn maps
    // them to 3 to 6; dup2 clears close-on-exec on the targets only.
    const int sources[4] = {ends.control_in, ends.control_out, ends.frames, ends.input};
    int high[4] = {-1, -1, -1, -1};
    const auto close_high = [&] {
        for (auto &fd : high)
            if (fd >= 0) {
                close(fd);
                fd = -1;
            }
    };
    for (int i = 0; i < 4; ++i)
        if ((high[i] = fcntl(sources[i], F_DUPFD_CLOEXEC, 64)) < 0) {
            close_high();
            error = "the pipe ends could not be passed to the network process";
            return false;
        }
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    posix_spawn_file_actions_init(&actions);
    posix_spawnattr_init(&attributes);
    // Only what the file actions name is inherited.
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
    for (int fd = 0; fd < 3; ++fd)
        posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", O_RDWR, 0);
    for (int i = 0; i < 4; ++i)
        posix_spawn_file_actions_adddup2(&actions, high[i], 3 + i);
    std::vector<std::string> arguments = {executable, "--sandbox", network_flag, "3",
                                          "4",        "5",         "6"};
    std::vector<char *> argv;
    for (auto &argument : arguments)
        argv.push_back(argument.data());
    argv.push_back(nullptr);
    // The worker's environment, with the registry fixed: media-net must never rebuild it, which
    // would start gst-plugin-scanner, which its profile forbids.
    std::vector<std::string> environment;
    for (char **entry = *_NSGetEnviron(); *entry; ++entry)
        if (std::strncmp(*entry, "GST_REGISTRY_UPDATE=", 20) != 0 &&
            std::strncmp(*entry, "GST_REGISTRY_FORK=", 18) != 0)
            environment.emplace_back(*entry);
    environment.emplace_back("GST_REGISTRY_UPDATE=no");
    environment.emplace_back("GST_REGISTRY_FORK=no");
    std::vector<char *> envp;
    for (auto &entry : environment)
        envp.push_back(entry.data());
    envp.push_back(nullptr);
    pid_t pid = 0;
    const int spawned =
        posix_spawn(&pid, executable.c_str(), &actions, &attributes, argv.data(), envp.data());
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    close_high();
    if (spawned != 0) {
        error = std::string("posix_spawn failed: ") + std::strerror(spawned);
        return false;
    }
    out.pid = pid;
    return true;
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

std::string network_socket_violation(const NetLaunch &launched) {
    if (launched.pid <= 0)
        return {};
    auto found = macos::outside_loopback(launched.pid);
    // A media-net that has ended has no sockets; its pipes report the exit.
    if (!found.empty() && kill(launched.pid, 0) != 0 && errno == ESRCH)
        return {};
    return found;
}

// ---- The launcher.

// `--sandbox --network <3> <4> <5> <6>`: media-net, in place.
static int launch_media_net(int argc, char **argv) {
    if (argc != 7)
        return 2;
    for (int i = 3; i < 7; ++i)
        if (std::strcmp(argv[i], std::to_string(i).c_str()) != 0)
            return 2;
    const auto executable = macos::self_path();
    std::string error;
    if (executable.empty() ||
        !macos::apply_profile(macos::profile_for(macos::SandboxKind::media_net, executable), error))
        return 3;
    char *arguments[] = {
        argv[0], const_cast<char *>(network_flag), argv[3], argv[4], argv[5], argv[6], nullptr};
    execv(executable.c_str(), arguments);
    return 3;
}

int run_sandboxed(int argc, char **argv) {
    if (argc >= 3 && std::strcmp(argv[2], network_flag) == 0)
        return launch_media_net(argc, argv);
    if (argc < 4 || std::strcmp(argv[2], "--") != 0)
        return 2;
    const auto program = macos::real_path(argv[3]);
    if (program.empty() || argv[3][0] != '/') {
        std::cerr << "Unable to start the sandboxed program: " << argv[3]
                  << " is not an absolute path to a program" << std::endl;
        return 2;
    }
    // The profile is compiled here, before the fork, so the child only applies it.
    const auto profile = macos::profile_for(macos::SandboxKind::relay, program);
    // Watch the server, and the stop signals it sends, before the program exists.
    const pid_t parent = getppid();
    const int queue = kqueue();
    if (queue < 0) {
        std::cerr << "Unable to start the sandboxed program: kqueue failed" << std::endl;
        return 2;
    }
    const int forwarded[] = {SIGTERM, SIGINT, SIGHUP};
    for (const int signal_number : forwarded) {
        signal(signal_number, SIG_IGN);
        struct kevent change;
        EV_SET(&change, signal_number, EVFILT_SIGNAL, EV_ADD, 0, 0, nullptr);
        kevent(queue, &change, 1, nullptr, 0, nullptr);
    }
    int report[2];
    if (pipe(report) != 0) {
        std::cerr << "Unable to start the sandboxed program: pipe failed" << std::endl;
        return 2;
    }
    fcntl(report[1], F_SETFD, FD_CLOEXEC);
    const pid_t child = fork();
    if (child < 0) {
        std::cerr << "Unable to start the sandboxed program: fork failed" << std::endl;
        return 2;
    }
    if (child == 0) {
        for (const int signal_number : forwarded)
            signal(signal_number, SIG_DFL);
        signal(SIGPIPE, SIG_DFL);
        close(report[0]);
        // Everything but stdio and the report pipe, which closes on exec.
        const int keep = report[1];
        close_inherited(keep);
        std::string error;
        if (macos::apply_profile(profile, error))
            execv(program.c_str(), argv + 3);
        if (error.empty())
            error = std::string("exec failed: ") + std::strerror(errno);
        const auto written = write(keep, error.data(), error.size());
        (void)written;
        _exit(127);
    }
    close(report[1]);
    std::string failure;
    char buffer[512];
    ssize_t count = 0;
    while ((count = read(report[0], buffer, sizeof(buffer))) > 0 || (count < 0 && errno == EINTR))
        if (count > 0)
            failure.append(buffer, static_cast<std::size_t>(count));
    close(report[0]);
    if (!failure.empty()) {
        waitpid(child, nullptr, 0);
        std::cerr << "Unable to start the sandboxed program: " << failure << std::endl;
        return 2;
    }
    struct kevent change;
    EV_SET(&change, child, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
    kevent(queue, &change, 1, nullptr, 0, nullptr);
    bool parent_alive = watch_parent_on(queue, parent);
    for (;;) {
        int status = 0;
        if (waitpid(child, &status, WNOHANG) == child)
            return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : WEXITSTATUS(status);
        if (!parent_alive) {
            // The server is gone: nothing may outlive it.
            kill(child, SIGKILL);
            waitpid(child, nullptr, 0);
            return 1;
        }
        struct kevent event;
        if (kevent(queue, nullptr, 0, &event, 1, nullptr) < 0)
            continue;
        if (event.filter == EVFILT_SIGNAL)
            kill(child, static_cast<int>(event.ident));
        else if (event.filter == EVFILT_PROC && static_cast<pid_t>(event.ident) == parent)
            parent_alive = false;
    }
}

// Nothing to start before plugins load, and no token to drop: the launcher applied the profile
// before `exec`, so media-net never holds more than it needs (design D2). There is no run-time
// code guard.
bool network_before_load() { return true; }
bool network_drop_privileges() { return true; }
bool network_code_guard() { return false; }
const char *network_tier() { return "profile"; }

void end_network_process(int code) { _exit(code); }

} // namespace platform
