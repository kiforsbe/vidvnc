// Display inventory on macOS: one row per active display, in global points (the space
// CGDisplayBounds and posted events use), identified by its display UUID.
#import <AppKit/AppKit.h>
#include <CoreGraphics/CoreGraphics.h>
#include <glib.h>
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include "../platform.hpp"

namespace platform {

static std::string display_name(CGDirectDisplayID display) {
    @autoreleasepool {
        for (NSScreen *screen in NSScreen.screens) {
            NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
            if (number && number.unsignedIntValue == display)
                return screen.localizedName.UTF8String ?: "Display";
        }
    }
    return CGDisplayIsBuiltin(display) ? "Built-in display" : "Display";
}

std::vector<CaptureDisplay> enumerate_displays() {
    // Online rather than active: a display that is asleep, as it usually is when nobody is at
    // the Mac, is still one a viewer can choose.
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(0, nullptr, &count) != kCGErrorSuccess)
        throw std::runtime_error("Unable to enumerate displays");
    std::vector<CGDirectDisplayID> ids(count);
    if (count && CGGetOnlineDisplayList(count, ids.data(), &count) != kCGErrorSuccess)
        throw std::runtime_error("Unable to enumerate displays");
    ids.resize(count);
    std::vector<CaptureDisplay> result;
    for (const auto display : ids) {
        // A mirror shows another display's picture: capture and input go to the one it mirrors.
        if (CGDisplayMirrorsDisplay(display) != kCGNullDirectDisplay)
            continue;
        // The display UUID survives restarts and reconnection. Without one, the identity is
        // marked ephemeral, so policy never persists permission for it.
        std::string identity;
        bool persistent = false;
        if (CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display)) {
            if (CFStringRef text = CFUUIDCreateString(nullptr, uuid)) {
                char buffer[64] = {};
                persistent =
                    CFStringGetCString(text, buffer, sizeof(buffer), kCFStringEncodingUTF8);
                identity = buffer;
                CFRelease(text);
            }
            CFRelease(uuid);
        }
        if (!persistent)
            identity = "display:" + std::to_string(display);
        auto hash = g_compute_checksum_for_string(G_CHECKSUM_SHA256, identity.c_str(), -1);
        std::string id = hash;
        g_free(hash);
        const auto bounds = CGDisplayBounds(display);
        int refresh = 0;
        if (CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display)) {
            refresh = static_cast<int>(std::lround(CGDisplayModeGetRefreshRate(mode)));
            CGDisplayModeRelease(mode);
        }
        result.push_back(
            {display,
             id,
             display_name(display),
             {static_cast<int>(bounds.origin.x), static_cast<int>(bounds.origin.y),
              static_cast<int>(bounds.size.width), static_cast<int>(bounds.size.height)},
             CGDisplayIsMain(display) != 0,
             persistent,
             refresh > 1 ? refresh : 0,
             static_cast<int>(std::lround(CGDisplayRotation(display))) % 360});
    }
    std::sort(result.begin(), result.end(),
              [](const auto &a, const auto &b) { return a.id < b.id; });
    for (size_t i = 1; i < result.size(); ++i)
        if (result[i - 1].id == result[i].id)
            throw std::runtime_error("Ambiguous display identity");
    if (result.empty())
        throw std::runtime_error("No active displays");
    return result;
}

DesktopRect primary_bounds() {
    const auto display = CGMainDisplayID();
    return {0, 0, static_cast<int>(CGDisplayPixelsWide(display)),
            static_cast<int>(CGDisplayPixelsHigh(display))};
}

} // namespace platform
