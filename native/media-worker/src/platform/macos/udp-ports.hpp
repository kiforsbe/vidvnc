#pragma once
// Which UDP ports a process has bound on 127.0.0.1, from its own descriptor table
// (proc_pidinfo and proc_pidfdinfo). The worker uses it for answer attestation (design D2):
// the port in media-net's answer must be one of media-net's own sockets. Reading another
// process's descriptors needs the same user, which media-net is.
#include <libproc.h>
#include <netinet/in.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <vector>

namespace macos {

inline bool udp_loopback_bound(pid_t pid, unsigned port) {
    if (pid <= 0 || port == 0 || port > 65535)
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
        if (socket.soi_family != AF_INET || socket.soi_protocol != IPPROTO_UDP ||
            socket.soi_kind != SOCKINFO_IN || !(socket.soi_proto.pri_in.insi_vflag & INI_IPV4))
            continue;
        const auto &in = socket.soi_proto.pri_in;
        if (ntohs(static_cast<in_port_t>(in.insi_lport)) == port &&
            in.insi_laddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK))
            return true;
    }
    return false;
}

} // namespace macos
