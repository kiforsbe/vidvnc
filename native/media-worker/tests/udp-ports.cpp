// Answer attestation on macOS (src/platform/macos/udp-ports.hpp): a loopback UDP port is
// attributed to the process that bound it, not to another process, and not to anyone once it
// is closed.
#include "../src/platform/macos/udp-ports.hpp"
#include <arpa/inet.h>
#include <cassert>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static int bound_socket(in_addr_t address, unsigned &port) {
    const int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    assert(fd >= 0);
    sockaddr_in local{};
    local.sin_len = sizeof(local);
    local.sin_family = AF_INET;
    local.sin_addr.s_addr = htonl(address);
    assert(bind(fd, reinterpret_cast<sockaddr *>(&local), sizeof(local)) == 0);
    socklen_t size = sizeof(local);
    assert(getsockname(fd, reinterpret_cast<sockaddr *>(&local), &size) == 0);
    port = ntohs(local.sin_port);
    return fd;
}

int main() {
    const pid_t self = getpid();
    // Owned by this process.
    unsigned mine = 0;
    const int socket_fd = bound_socket(INADDR_LOOPBACK, mine);
    assert(macos::udp_loopback_bound(self, mine));

    // Owned by another process: a child binds one and reports its port.
    int report[2];
    assert(pipe(report) == 0);
    const pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
        // Only the child's own socket: not the one inherited from the parent. It never
        // outlives a failed test by more than a few seconds.
        close(socket_fd);
        close(report[0]);
        alarm(10);
        unsigned port = 0;
        bound_socket(INADDR_LOOPBACK, port);
        if (write(report[1], &port, sizeof(port)) != sizeof(port))
            _exit(1);
        pause();
        _exit(0);
    }
    close(report[1]);
    unsigned theirs = 0;
    assert(read(report[0], &theirs, sizeof(theirs)) == sizeof(theirs));
    assert(macos::udp_loopback_bound(child, theirs));
    assert(!macos::udp_loopback_bound(self, theirs));
    assert(!macos::udp_loopback_bound(child, mine));
    kill(child, SIGKILL);
    waitpid(child, nullptr, 0);

    // Owned by nobody: the port was closed.
    close(socket_fd);
    assert(!macos::udp_loopback_bound(self, mine));

    // Nonsense inputs.
    assert(!macos::udp_loopback_bound(0, mine));
    assert(!macos::udp_loopback_bound(self, 0));
    assert(!macos::udp_loopback_bound(self, 70000));
}
