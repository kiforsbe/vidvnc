// The macOS sandbox probe (design D3, gate MG4), run by tests/sandbox-check.mjs. It applies to
// itself exactly the profile the launcher gives media-net (sandbox-apply.hpp), then tries what
// a compromised media-net would: use VidVNC's Screen Recording and Accessibility grants
// through their system services, read the owner's files, write files, start processes, and
// reach the LAN. It prints one PASS, FAIL or INFO line per check and exits non-zero on a FAIL.
//
// Usage: sandbox-probe [--baseline] [<secret file>]
//   --baseline  runs the same checks without the profile, so the check can show the probe
//               detects what the profile then denies.
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <arpa/inet.h>
#include <bootstrap.h>
#include <dirent.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include "../src/platform/macos/sandbox-apply.hpp"
#include "../src/platform/macos/udp-ports.hpp"

extern char **environ;

static bool baseline = false;
static int failures = 0;

// `denied`: what the profile must give. Under --baseline every line is INFO.
static void report(const char *name, bool denied, const std::string &detail) {
    const char *verdict = baseline ? "INFO" : denied ? "PASS" : "FAIL";
    if (!baseline && !denied)
        ++failures;
    std::printf("%s: %s - %s\n", verdict, name, detail.c_str());
}

static std::string error_text(int code) {
    return code ? std::string(std::strerror(code)) : std::string("allowed");
}

static bool mach_service_reachable(const char *name) {
    mach_port_t port = MACH_PORT_NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    const kern_return_t result = bootstrap_look_up(bootstrap_port, name, &port);
#pragma clang diagnostic pop
    if (result == KERN_SUCCESS && port != MACH_PORT_NULL)
        mach_port_deallocate(mach_task_self(), port);
    return result == KERN_SUCCESS;
}

static int udp_socket(const char *address, unsigned short port, bool bind_it) {
    const int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0 || !bind_it)
        return fd;
    sockaddr_in local{};
    local.sin_len = sizeof(local);
    local.sin_family = AF_INET;
    local.sin_port = htons(port);
    inet_pton(AF_INET, address, &local.sin_addr);
    if (bind(fd, reinterpret_cast<sockaddr *>(&local), sizeof(local)) != 0) {
        const int code = errno;
        close(fd);
        errno = code;
        return -1;
    }
    return fd;
}

static int send_to(int fd, const char *address, unsigned short port) {
    sockaddr_in remote{};
    remote.sin_len = sizeof(remote);
    remote.sin_family = AF_INET;
    remote.sin_port = htons(port);
    inet_pton(AF_INET, address, &remote.sin_addr);
    const char byte = 0;
    return sendto(fd, &byte, 1, 0, reinterpret_cast<sockaddr *>(&remote), sizeof(remote)) == 1
               ? 0
               : errno;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        std::string secret;
        for (int i = 1; i < argc; ++i) {
            if (std::strcmp(argv[i], "--baseline") == 0)
                baseline = true;
            else
                secret = argv[i];
        }
        const char *home = getenv("HOME");
        const std::string documents = std::string(home ? home : "") + "/Documents";
        if (!baseline) {
            std::string error;
            if (!macos::apply_profile(
                    macos::profile_for(macos::SandboxKind::media_net, macos::self_path()), error)) {
                std::printf("FAIL: the media-net profile applies - %s\n", error.c_str());
                return 1;
            }
            std::printf("PASS: the media-net profile applies\n");
        }

        // The services behind VidVNC's privacy grants: the window server (capture and posted
        // events), ScreenCaptureKit's daemon and TCC.
        for (const char *service : {"com.apple.windowserver.active", "com.apple.replayd",
                                    "com.apple.tccd", "com.apple.tccd.system"}) {
            const bool reachable = mach_service_reachable(service);
            report((std::string("mach-lookup ") + service).c_str(), !reachable,
                   reachable ? "reachable" : "denied");
        }

        // Screen capture through ScreenCaptureKit.
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block NSString *capture = @"timed out";
        __block bool listed = false;
        [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,
                                                                       NSError *failure) {
          listed = content && content.displays.count > 0;
          capture = listed ? [NSString stringWithFormat:@"%lu displays listed",
                                                        (unsigned long)content.displays.count]
                           : (failure.localizedDescription ?: @"no displays");
          dispatch_semaphore_signal(done);
        }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
        report("ScreenCaptureKit lists no displays", !listed, capture.UTF8String);

        // Posted events need a window server event source.
        CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        const bool posting = CGPreflightPostEventAccess();
        report("no posting access", !posting,
               std::string(posting ? "CGPreflightPostEventAccess true" : "false") +
                   (source ? ", event source created" : ", no event source"));
        if (source)
            CFRelease(source);

        // The owner's files.
        DIR *folder = opendir(documents.c_str());
        report("~/Documents cannot be listed", !folder, error_text(folder ? 0 : errno));
        if (folder)
            closedir(folder);
        if (!secret.empty()) {
            const int fd = open(secret.c_str(), O_RDONLY);
            report("a file in the VidVNC data folder cannot be read", fd < 0,
                   error_text(fd < 0 ? errno : 0));
            if (fd >= 0)
                close(fd);
        }
        const std::string written = "/private/tmp/vidvnc-sandbox-probe-" + std::to_string(getpid());
        const int created = open(written.c_str(), O_CREAT | O_WRONLY | O_EXCL, 0600);
        report("no file can be written", created < 0, error_text(created < 0 ? errno : 0));
        if (created >= 0) {
            close(created);
            unlink(written.c_str());
        }

        // Processes.
        const pid_t forked = fork();
        if (forked == 0)
            _exit(0);
        report("fork is denied", forked < 0, error_text(forked < 0 ? errno : 0));
        if (forked > 0)
            waitpid(forked, nullptr, 0);
        pid_t spawned = 0;
        char *arguments[] = {const_cast<char *>("/usr/bin/true"), nullptr};
        const int spawn_error =
            posix_spawn(&spawned, "/usr/bin/true", nullptr, nullptr, arguments, environ);
        report("exec is denied", spawn_error != 0, error_text(spawn_error));
        if (!spawn_error)
            waitpid(spawned, nullptr, 0);

        // The network: loopback UDP works; nothing reaches the LAN; no TCP.
        const int loopback = udp_socket("127.0.0.1", 0, true);
        const int loopback_bound = loopback < 0 ? errno : 0;
        std::printf("%s: UDP binds on 127.0.0.1 - %s\n",
                    loopback_bound ? "FAIL" : (baseline ? "INFO" : "PASS"),
                    error_text(loopback_bound).c_str());
        if (loopback_bound && !baseline)
            ++failures;
        if (loopback >= 0) {
            const int sent = send_to(loopback, "127.0.0.1", 9);
            std::printf("%s: UDP sends to 127.0.0.1 - %s\n",
                        sent ? "FAIL" : (baseline ? "INFO" : "PASS"), error_text(sent).c_str());
            if (sent && !baseline)
                ++failures;
            close(loopback);
        }
        const int lan = udp_socket("0.0.0.0", 0, false);
        // TEST-NET-1 (RFC 5737): never routed, so a send that leaves would go nowhere. The
        // profile refuses it before routing, with EPERM.
        const int lan_sent = lan < 0 ? errno : send_to(lan, "192.0.2.1", 9);
        report("UDP cannot send off loopback", lan_sent == EPERM, error_text(lan_sent));
        if (lan >= 0)
            close(lan);
        const int stream = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        int tcp_error = stream < 0 ? errno : 0;
        if (stream >= 0) {
            sockaddr_in remote{};
            remote.sin_len = sizeof(remote);
            remote.sin_family = AF_INET;
            remote.sin_port = htons(9);
            remote.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            tcp_error = connect(stream, reinterpret_cast<sockaddr *>(&remote), sizeof(remote)) == 0
                            ? 0
                            : errno;
            close(stream);
        }
        // Refused by the profile (EPERM), not by an empty port (ECONNREFUSED).
        report("TCP cannot connect, even on loopback", tcp_error == EPERM, error_text(tcp_error));

        // The accepted residual: binding every address is not refused, so the worker's audit
        // must catch it. Shown, not judged; the audit is checked by udp-ports-test.
        const int wildcard = udp_socket("0.0.0.0", 0, true);
        const auto audit = macos::outside_loopback(getpid());
        std::printf("INFO: UDP bind on 0.0.0.0 (residual) - %s; the socket audit reports: %s\n",
                    error_text(wildcard < 0 ? errno : 0).c_str(),
                    audit.empty() ? "nothing" : audit.c_str());
        if (wildcard >= 0) {
            if (audit.empty() && !baseline) {
                std::printf("FAIL: the socket audit sees the wildcard socket\n");
                ++failures;
            }
            close(wildcard);
        }
    }
    std::printf("%s: sandbox probe\n", baseline ? "INFO" : failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
}
