#pragma once
// Writing and applying a sandbox profile (sandbox-profile.hpp) for a program: the launcher in
// process.cpp, and the sandbox probe (tests/sandbox-probe-macos.mm), which applies exactly the
// profile media-net gets to itself.
#include <mach-o/dyld.h>
#include <sandbox.h>
#include <algorithm>
#include <cstdlib>
#include <initializer_list>
#include <set>
#include <string>
#include <vector>
#include "macho-images.hpp"
#include "sandbox-profile.hpp"

namespace macos {

// This executable's real path.
inline std::string self_path() {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::string path(size, '\0');
    if (_NSGetExecutablePath(path.data(), &size) != 0)
        return {};
    return real_path(path.c_str());
}

// Colon-separated folders from the first of `names` that is set.
inline std::vector<std::string> env_folders(std::initializer_list<const char *> names) {
    for (const auto name : names)
        if (const char *value = getenv(name)) {
            std::vector<std::string> out;
            std::string text = value;
            for (std::size_t start = 0; start <= text.size();) {
                const auto end = std::min(text.find(':', start), text.size());
                const auto real = real_path(text.substr(start, end - start));
                if (!real.empty())
                    out.push_back(real);
                start = end + 1;
            }
            return out;
        }
    return {};
}

// The profile for `program`: its start-up images' folders, and for media-net GStreamer's
// plugin folders and registry (which the worker has already brought up to date; media-net
// runs with GST_REGISTRY_UPDATE=no and never rebuilds it).
inline std::string profile_for(SandboxKind kind, const std::string &program) {
    SandboxRequest request{kind, program, {}, {}, {}};
    std::set<std::string> folders;
    const auto startup = startup_images(program);
    for (const auto &image : startup.images)
        folders.insert(parent_folder(image));
    request.links = startup.links;
    if (kind == SandboxKind::media_net) {
        for (const auto &folder :
             env_folders({"GST_PLUGIN_PATH_1_0", "GST_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
                          "GST_PLUGIN_SYSTEM_PATH"}))
            folders.insert(folder);
        std::string registry;
        for (const auto name : {"GST_REGISTRY_1_0", "GST_REGISTRY"})
            if (const char *value = getenv(name); value && registry.empty())
                registry = value;
        if (registry.empty()) {
            // GLib's user cache folder, where GStreamer keeps its registry by default.
            const char *cache = getenv("XDG_CACHE_HOME");
            const char *home = getenv("HOME");
            if (cache && *cache)
                registry = std::string(cache) + "/gstreamer-1.0";
            else if (home && *home)
                registry = std::string(home) + "/.cache/gstreamer-1.0";
        }
        const auto real = real_path(registry);
        if (!real.empty())
            request.read_only.push_back(real);
    }
    request.folders.assign(folders.begin(), folders.end());
    return sandbox_profile(request);
}

// Applies the profile to this process. The `sandbox_init` family is deprecated (risk R1) but
// is still how a launcher applies a profile on macOS 27.
inline bool apply_profile(const std::string &profile, std::string &error) {
    if (profile.empty()) {
        error = "the sandbox profile could not be written for this path";
        return false;
    }
    char *message = nullptr;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    const int applied = sandbox_init(profile.c_str(), 0, &message);
    if (applied != 0) {
        error = std::string("sandbox_init failed: ") + (message ? message : "unknown error");
        sandbox_free_error(message);
    }
#pragma clang diagnostic pop
    return applied == 0;
}

} // namespace macos
