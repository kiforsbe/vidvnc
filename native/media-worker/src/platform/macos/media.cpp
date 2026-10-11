// Displays, capture, encode, audio and input on macOS: ScreenCaptureKit, VideoToolbox and
// CGEventPost (design D1 and D4). They are phase 3 of the macOS plan; until then each fails
// by name, so the probe reports what is missing and the server offers no source.
#include <CoreGraphics/CoreGraphics.h>
#include <stdexcept>
#include "../platform.hpp"

namespace platform {

[[noreturn]] static void missing(const char *what) {
    throw std::runtime_error(std::string(what) +
                             " on macOS is not implemented yet (macOS plan, phase 3).");
}

std::vector<CaptureDisplay> enumerate_displays() { missing("Display inventory"); }

DesktopRect primary_bounds() {
    const auto display = CGMainDisplayID();
    return {0, 0, static_cast<int>(CGDisplayPixelsWide(display)),
            static_cast<int>(CGDisplayPixelsHigh(display))};
}

void preflight() { missing("Screen capture with ScreenCaptureKit"); }

const char *capture_name() { return "screencapturekit"; }

std::string video_pipeline(const VideoRequest &) { missing("Video encoding with VideoToolbox"); }

std::string audio_pipeline(int) { missing("Audio capture with ScreenCaptureKit"); }

std::vector<BackendAvailability> available_backends(const std::optional<CaptureDisplay> &) {
    return {};
}

Selection encoder_selection_for(const std::string &, const std::optional<CaptureDisplay> &,
                                const std::string &) {
    return {false, {}, SelectionReason::FixedOrder};
}

// No event is posted: the broker sees each one fail, so nothing is recorded as held.
bool post_key(unsigned short, bool) { return false; }
bool post_button(int, bool) { return false; }
bool post_move(double, double, const std::optional<CaptureDisplay> &) { return false; }
bool post_wheel(double) { return false; }

} // namespace platform
