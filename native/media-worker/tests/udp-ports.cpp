// media-net's sockets on macOS (src/platform/macos/udp-ports.hpp). Answer attestation: a
// loopback UDP port is attributed to the process that bound it, not to another process, and
// not to anyone once it is closed. The socket audit: sockets on loopback pass, a socket bound
// to any other address (including every address at once) is reported, and so is a process
// whose sockets cannot be read.
#include "../src/platform/macos/udp-ports.hpp"
#include <arpa/inet.h>
#include <cassert>
#include <string>
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

    // The socket audit. No sockets, and an unbound one: nothing to report.
    assert(macos::outside_loopback(self).empty());
    const int unbound = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    assert(macos::outside_loopback(self).empty());
    // Loopback, IPv4 and IPv6, UDP and a TCP listener, and a UDP socket connected on loopback.
    unsigned port = 0;
    const int loopback = bound_socket(INADDR_LOOPBACK, port);
    const int six = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
    sockaddr_in6 local6{};
    local6.sin6_len = sizeof(local6);
    local6.sin6_family = AF_INET6;
    local6.sin6_addr = in6addr_loopback;
    assert(bind(six, reinterpret_cast<sockaddr *>(&local6), sizeof(local6)) == 0);
    const int listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in tcp_local{};
    tcp_local.sin_len = sizeof(tcp_local);
    tcp_local.sin_family = AF_INET;
    tcp_local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(bind(listener, reinterpret_cast<sockaddr *>(&tcp_local), sizeof(tcp_local)) == 0);
    assert(listen(listener, 1) == 0);
    sockaddr_in target{};
    target.sin_len = sizeof(target);
    target.sin_family = AF_INET;
    target.sin_port = htons(static_cast<in_port_t>(port));
    target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(connect(unbound, reinterpret_cast<sockaddr *>(&target), sizeof(target)) == 0);
    assert(macos::outside_loopback(self).empty());
    // Every address at once, IPv4 and IPv6: reported, by protocol, address and port.
    unsigned wildcard_port = 0;
    const int wildcard = bound_socket(INADDR_ANY, wildcard_port);
    const auto found = macos::outside_loopback(self);
    assert(found == "UDP 0.0.0.0:" + std::to_string(wildcard_port));
    close(wildcard);
    assert(macos::outside_loopback(self).empty());
    const int any6 = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
    sockaddr_in6 every6{};
    every6.sin6_len = sizeof(every6);
    every6.sin6_family = AF_INET6;
    every6.sin6_addr = in6addr_any;
    assert(bind(any6, reinterpret_cast<sockaddr *>(&every6), sizeof(every6)) == 0);
    assert(macos::outside_loopback(self).rfind("UDP :::", 0) == 0);
    close(any6);
    // A process whose sockets cannot be read fails closed.
    assert(!macos::outside_loopback(0).empty());
    close(unbound);
    close(loopback);
    close(six);
    close(listener);
}
