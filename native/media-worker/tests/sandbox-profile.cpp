// The macOS sandbox profiles (src/platform/macos/sandbox-profile.hpp) and the start-up image
// walk they are built from (macho-images.hpp): media-net may use loopback UDP only and the
// relay UDP on any address; both deny by default, allow no Mach service, no fork and no exec
// but of their own program; paths are quoted, and a path that cannot be quoted refuses the
// profile. The walk finds this test's own non-system libraries and none of the system's.
#include "../src/platform/macos/sandbox-apply.hpp"
#include <cassert>
#include <string>

static bool has(const std::string &text, const std::string &part) {
    return text.find(part) != std::string::npos;
}

int main() {
    assert(macos::sbpl_string("/a b/c") == "\"/a b/c\"");
    assert(macos::sbpl_string("/a\"b\\c") == "\"/a\\\"b\\\\c\"");
    assert(macos::sbpl_string("/a\nb").empty());

    macos::SandboxRequest net{macos::SandboxKind::media_net,
                              "/Applications/VidVNC.app/Contents/MacOS/media-worker",
                              {"/Applications/VidVNC.app/Contents/Frameworks"},
                              {"/Users/someone/Library/Caches/registry.bin"},
                              {"/opt/brew/opt/lib/libx.dylib"}};
    const auto media_net = macos::sandbox_profile(net);
    assert(media_net.rfind("(version 1)\n(deny default)\n", 0) == 0);
    assert(has(media_net, "(allow process-exec (literal "
                          "\"/Applications/VidVNC.app/Contents/MacOS/media-worker\"))"));
    assert(has(media_net, "(allow file-read* file-map-executable (subpath "
                          "\"/Applications/VidVNC.app/Contents/Frameworks\"))"));
    assert(has(media_net, "(allow file-read* (subpath "
                          "\"/Users/someone/Library/Caches/registry.bin\"))"));
    // The link and every folder above it: metadata only.
    for (const char *path : {"/opt/brew/opt/lib/libx.dylib", "/opt/brew/opt/lib", "/opt/brew/opt",
                             "/opt/brew", "/opt"})
        assert(
            has(media_net, std::string("(allow file-read-metadata (literal \"") + path + "\"))"));
    assert(has(media_net, "(allow network-bind (local udp \"localhost:*\"))"));
    assert(has(media_net, "(allow network-outbound (remote udp \"localhost:*\"))"));
    assert(!has(media_net, "\"*:*\""));
    for (const auto &profile :
         {media_net,
          macos::sandbox_profile({macos::SandboxKind::relay, "/opt/node/bin/node", {}, {}, {}})}) {
        assert(!has(profile, "mach-lookup"));
        assert(!has(profile, "process-fork"));
        assert(!has(profile, "file-write*"));
        assert(!has(profile, "tcp"));
    }
    const auto relay =
        macos::sandbox_profile({macos::SandboxKind::relay, "/opt/node/bin/node", {}, {}, {}});
    assert(has(relay, "(allow network-bind (local udp \"*:*\"))"));
    assert(has(relay, "(allow network-outbound (remote udp \"*:*\"))"));
    assert(!has(relay, "localhost"));

    // Refused: a relative program or folder, or a path with a control character.
    assert(macos::sandbox_profile({macos::SandboxKind::relay, "node", {}, {}, {}}).empty());
    assert(macos::sandbox_profile({macos::SandboxKind::relay, "/node", {"lib"}, {}, {}}).empty());
    assert(macos::sandbox_profile({macos::SandboxKind::relay, "/no\nde", {}, {}, {}}).empty());

    // This test's own start-up images: itself first, then GLib (it links the GStreamer SDK),
    // never a system library.
    const auto self = macos::self_path();
    const auto images = macos::startup_images(self).images;
    assert(!images.empty() && images.front() == self);
    bool glib = false;
    for (const auto &image : images) {
        assert(!macos::in_system(image));
        glib = glib || has(image, "libglib-2.0");
    }
    assert(glib);
    // A system program maps nothing outside the system.
    assert(macos::startup_images("/usr/bin/true").images.empty());
    assert(macos::startup_images("/no/such/program").images.empty());
}
