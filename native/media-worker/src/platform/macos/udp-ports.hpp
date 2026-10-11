#pragma once
// media-net's sockets, from its own descriptor table (proc_pidinfo and proc_pidfdinfo). The
// worker uses it twice. Answer attestation (design D2): the port in media-net's answer must be
// one of media-net's own sockets on 127.0.0.1. The socket audit (design D3, gate MG4): the
// sandbox profile cannot keep media-net from binding a LAN address, so the worker checks every
// second that each of its network sockets is on loopback and ends the source if one is not.
// Reading another process's descriptors needs the same user, which media-net is.
#include <arpa/inet.h>
#include <libproc.h>
#include <netinet/in.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <functional>
#include <string>
#include <vector>

namespace macos {

// Calls `visit` for each IPv4 or IPv6 socket of `pid` with its protocol, until it returns
// false. False if the descriptor table could not be read (the process is gone, or not ours).
inline bool visit_inet_sockets(pid_t pid, const std::function<bool(const socket_info &)> &visit) {
    if (pid <= 0)
        return false;
    const int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nullptr, 0);
    if (size <= 0)
        return false;
    // Room for descriptors opened between the two calls; the second call says what it filled.
    std::vector<proc_fdinfo> fds(static_cast<std::size_t>(size) / sizeof(proc_fdinfo) + 16);
    const int filled = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds.data(),
                                    static_cast<int>(fds.size() * sizeof(proc_fdinfo)));
    if (filled <= 0)
        return false;
    const auto count = static_cast<std::size_t>(filled) / sizeof(proc_fdinfo);
    for (std::size_t i = 0; i < count; ++i) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET)
            continue;
        socket_fdinfo info{};
        if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info)) !=
            static_cast<int>(sizeof(info)))
            continue;
        const auto &socket = info.psi;
        if ((socket.soi_family != AF_INET && socket.soi_family != AF_INET6) ||
            (socket.soi_kind != SOCKINFO_IN && socket.soi_kind != SOCKINFO_TCP))
            continue;
        if (!visit(socket))
            break;
    }
    return true;
}

inline const in_sockinfo &inet_part(const socket_info &socket) {
    return socket.soi_kind == SOCKINFO_TCP ? socket.soi_proto.pri_tcp.tcpsi_ini
                                           : socket.soi_proto.pri_in;
}

inline bool udp_loopback_bound(pid_t pid, unsigned port) {
    if (port == 0 || port > 65535)
        return false;
    bool found = false;
    visit_inet_sockets(pid, [&](const socket_info &socket) {
        const auto &in = socket.soi_proto.pri_in;
        if (socket.soi_family == AF_INET && socket.soi_protocol == IPPROTO_UDP &&
            socket.soi_kind == SOCKINFO_IN && (in.insi_vflag & INI_IPV4) &&
            ntohs(static_cast<in_port_t>(in.insi_lport)) == port &&
            in.insi_laddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK))
            found = true;
        return !found;
    });
    return found;
}

// Whether an address (local or remote) is on loopback: 127.0.0.0/8, ::1, or 127.0.0.0/8
// mapped into IPv6. The unspecified address (bound to every interface) is not. A socket that
// can carry IPv6 is judged by its IPv6 address, which also covers its mapped IPv4 side.
inline bool on_loopback(const in_sockinfo &in, bool local) {
    const auto &v4 = local ? in.insi_laddr.ina_46.i46a_addr4 : in.insi_faddr.ina_46.i46a_addr4;
    if (!(in.insi_vflag & INI_IPV6))
        return (ntohl(v4.s_addr) >> 24) == 127;
    const auto &v6 = local ? in.insi_laddr.ina_6 : in.insi_faddr.ina_6;
    if (IN6_IS_ADDR_LOOPBACK(&v6))
        return true;
    return IN6_IS_ADDR_V4MAPPED(&v6) && v6.s6_addr[12] == 127;
}

inline std::string socket_text(const socket_info &socket, const in_sockinfo &in) {
    char local[INET6_ADDRSTRLEN] = "?";
    if (in.insi_vflag & INI_IPV6)
        inet_ntop(AF_INET6, &in.insi_laddr.ina_6, local, sizeof(local));
    else
        inet_ntop(AF_INET, &in.insi_laddr.ina_46.i46a_addr4, local, sizeof(local));
    return std::string(socket.soi_protocol == IPPROTO_TCP ? "TCP " : "UDP ") + local + ":" +
           std::to_string(ntohs(static_cast<in_port_t>(in.insi_lport)));
}

// The socket audit: empty while every bound or connected network socket of `pid` is on
// loopback, otherwise the first one that is not (for the log). A socket that is neither bound
// nor connected yet has no address to judge. A process whose sockets cannot be read is
// reported too: the audit fails closed.
inline std::string outside_loopback(pid_t pid) {
    std::string found;
    const bool read = visit_inet_sockets(pid, [&](const socket_info &socket) {
        const auto &in = inet_part(socket);
        const bool bound = in.insi_lport != 0;
        const bool connected = in.insi_fport != 0;
        if ((bound && !on_loopback(in, true)) || (connected && !on_loopback(in, false)))
            found = socket_text(socket, in);
        return found.empty();
    });
    return read ? found : std::string("its sockets could not be read");
}

} // namespace macos
