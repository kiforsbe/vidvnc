#pragma once
// The sandbox profiles (SBPL) the launcher applies before `exec` (design D3, gate MG4): one for
// media-net and one for the media relay. Both deny by default, allow no `mach-lookup` (which
// alone keeps the window server, ScreenCaptureKit, tccd and the event system out of reach, so
// a compromised process cannot use VidVNC's Screen Recording or Accessibility grants), no
// fork, no exec but of the program itself, and no file writes. Reads are limited to the
// system, the folders of the files the program maps at start-up (macho-images.hpp), the
// metadata of the links dyld follows to reach them, and, for media-net, GStreamer's plugin
// folders and its prepared registry.
//
// Network: media-net may use UDP on loopback only; the relay UDP on any address. SBPL's
// network filters take only `*` or `localhost`, and `localhost` on the local side matches every
// local address, so media-net could still bind a LAN address and receive on it, though never
// send there. The worker's socket audit (udp-ports.hpp) ends the source if it ever does; the
// owner accepted that receive-only residual (MG4).
#include <algorithm>
#include <set>
#include <string>
#include <vector>

namespace macos {

enum class SandboxKind { media_net, relay };

struct SandboxRequest {
    SandboxKind kind;
    // The real path of the program the launcher will exec.
    std::string program;
    // Folders the program may read and map executable code from.
    std::vector<std::string> folders;
    // Folders and files it may only read (plugin registry).
    std::vector<std::string> read_only;
    // Paths whose symbolic links it may follow to reach the folders above: only their own
    // and their parents' metadata.
    std::vector<std::string> links;
};

// An SBPL string literal. Paths come from the file system, so quotes and backslashes are
// escaped; a path with a control character is refused (empty result) rather than guessed at.
inline std::string sbpl_string(const std::string &text) {
    std::string out = "\"";
    for (const unsigned char c : text) {
        if (c < 0x20 || c == 0x7f)
            return {};
        if (c == '"' || c == '\\')
            out.push_back('\\');
        out.push_back(static_cast<char>(c));
    }
    out.push_back('"');
    return out;
}

// The profile text, or empty if a path cannot be written into it.
inline std::string sandbox_profile(const SandboxRequest &request) {
    std::string profile = "(version 1)\n(deny default)\n";
    const auto program = sbpl_string(request.program);
    if (program.empty() || request.program.empty() || request.program[0] != '/')
        return {};
    // dyld and the system libraries: the shared cache and its cryptexes, and the root folder
    // (dyld checks it, and Node.js reads it because it runs from `/`).
    profile += "(allow file-read* file-map-executable (subpath \"/System\") (subpath "
               "\"/usr/lib\") (subpath \"/private/preboot\") (subpath \"/Library/Apple\"))\n"
               "(allow file-read-data file-read-metadata (literal \"/\"))\n"
               "(allow file-read* (subpath \"/usr/share\") (subpath "
               "\"/private/var/db/timezone\") (literal \"/private/etc/localtime\"))\n"
               "(allow file-read* file-write-data (literal \"/dev/null\"))\n"
               "(allow file-read* (literal \"/dev/urandom\") (literal \"/dev/random\"))\n"
               "(allow sysctl-read)\n"
               "(allow process-info* (target self))\n"
               "(allow signal (target self))\n";
    profile += "(allow process-exec (literal " + program + "))\n";
    for (const auto &folder : request.folders) {
        const auto quoted = sbpl_string(folder);
        if (quoted.empty() || folder.empty() || folder[0] != '/')
            return {};
        profile += "(allow file-read* file-map-executable (subpath " + quoted + "))\n";
    }
    for (const auto &path : request.read_only) {
        const auto quoted = sbpl_string(path);
        if (quoted.empty() || path.empty() || path[0] != '/')
            return {};
        profile += "(allow file-read* (subpath " + quoted + "))\n";
    }
    std::set<std::string> metadata;
    for (const auto &link : request.links)
        for (auto path = link; path.size() > 1 && path[0] == '/';
             path = path.substr(0, std::max<std::size_t>(path.find_last_of('/'), 1)))
            metadata.insert(path);
    for (const auto &path : metadata) {
        const auto quoted = sbpl_string(path);
        if (quoted.empty())
            return {};
        profile += "(allow file-read-metadata (literal " + quoted + "))\n";
    }
    const char *scope = request.kind == SandboxKind::media_net ? "localhost" : "*";
    profile += std::string("(allow network-bind (local udp \"") + scope + ":*\"))\n" +
               "(allow network-inbound (local udp \"" + scope + ":*\"))\n" +
               "(allow network-outbound (remote udp \"" + scope + ":*\"))\n";
    return profile;
}

} // namespace macos
