// Input on macOS (design D4): CGEventPost at the HID level, keys by macOS virtual key code
// (input-policy.hpp), pointer positions in global points on the capture display.
//
// Without the user's approval to control the computer, posted events are dropped silently
// (gate MG3), so every post checks first and reports failure: the broker then records nothing
// as held, and the worker has already told the server input is unavailable.
#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include "../platform.hpp"

namespace platform {

namespace {

// What the broker has pressed through this process, so posted events carry the modifiers and
// moves become drags while a button is down.
struct State {
    CGEventSourceRef source = nullptr;
    CGPoint position{};
    bool positioned = false;
    bool buttons[3] = {};
    CGEventFlags modifiers = 0;
    // Double and triple clicks: macOS counts them from the click state the event carries.
    int last_button = -1, clicks = 0;
    std::chrono::steady_clock::time_point last_click;
    CGPoint last_click_at{};
};

State &state() {
    static State value;
    if (!value.source)
        value.source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    return value;
}

bool allowed() { return CGPreflightPostEventAccess(); }

bool post(CGEventRef event) {
    if (!event)
        return false;
    CGEventSetFlags(event, state().modifiers);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    return true;
}

CGPoint current_position() {
    auto &s = state();
    if (!s.positioned) {
        if (CGEventRef now = CGEventCreate(nullptr)) {
            s.position = CGEventGetLocation(now);
            CFRelease(now);
        }
        s.positioned = true;
    }
    return s.position;
}

CGEventFlags modifier_flag(unsigned short code) {
    switch (code) {
    case kVK_Shift:
    case kVK_RightShift:
        return kCGEventFlagMaskShift;
    case kVK_Control:
    case kVK_RightControl:
        return kCGEventFlagMaskControl;
    case kVK_Option:
    case kVK_RightOption:
        return kCGEventFlagMaskAlternate;
    case kVK_Command:
    case kVK_RightCommand:
        return kCGEventFlagMaskCommand;
    default:
        return 0;
    }
}

const CGEventType downs[] = {kCGEventLeftMouseDown, kCGEventOtherMouseDown, kCGEventRightMouseDown};
const CGEventType ups[] = {kCGEventLeftMouseUp, kCGEventOtherMouseUp, kCGEventRightMouseUp};
const CGEventType drags[] = {kCGEventLeftMouseDragged, kCGEventOtherMouseDragged,
                             kCGEventRightMouseDragged};
// The protocol's buttons are 0 left, 1 middle, 2 right; Core Graphics numbers them 0 left,
// 1 right, 2 middle.
const CGMouseButton cg_buttons[] = {kCGMouseButtonLeft, kCGMouseButtonCenter, kCGMouseButtonRight};

} // namespace

std::string input_unavailable_reason() {
    if (allowed())
        return {};
    return "Remote control needs permission. In System Settings, Privacy & Security, Device "
           "Control & Data Access, allow the app that started VidVNC.";
}

bool post_key(unsigned short code, bool down) {
    if (!allowed())
        return false;
    auto &s = state();
    if (const auto flag = modifier_flag(code))
        s.modifiers = down ? (s.modifiers | flag) : (s.modifiers & ~flag);
    return post(CGEventCreateKeyboardEvent(s.source, code, down));
}

bool post_button(int button, bool down) {
    if (!allowed() || button < 0 || button > 2)
        return false;
    auto &s = state();
    const auto at = current_position();
    if (down) {
        const auto now = std::chrono::steady_clock::now();
        const bool again =
            s.last_button == button && now - s.last_click < std::chrono::milliseconds(500) &&
            std::abs(at.x - s.last_click_at.x) <= 4 && std::abs(at.y - s.last_click_at.y) <= 4;
        s.clicks = again ? std::min(s.clicks + 1, 3) : 1;
        s.last_button = button;
        s.last_click = now;
        s.last_click_at = at;
    }
    auto event = CGEventCreateMouseEvent(s.source, down ? downs[button] : ups[button], at,
                                         cg_buttons[button]);
    if (event)
        CGEventSetIntegerValueField(event, kCGMouseEventClickState, std::max(s.clicks, 1));
    if (!post(event))
        return false;
    s.buttons[button] = down;
    return true;
}

bool post_move(double x, double y, const std::optional<CaptureDisplay> &capture_display) {
    if (!allowed() || !std::isfinite(x) || !std::isfinite(y) || x < 0 || y < 0 || x > 1 || y > 1)
        return false;
    // The display's current bounds in global points: Retina and non-Retina displays side by
    // side, and displays left of or above the main one, all map correctly.
    const auto display = capture_display ? static_cast<CGDirectDisplayID>(capture_display->handle)
                                         : CGMainDisplayID();
    const auto bounds = CGDisplayBounds(display);
    if (bounds.size.width < 1 || bounds.size.height < 1)
        return false;
    const CGPoint point{bounds.origin.x + x * (bounds.size.width - 1),
                        bounds.origin.y + y * (bounds.size.height - 1)};
    auto &s = state();
    auto type = kCGEventMouseMoved;
    CGMouseButton button = kCGMouseButtonLeft;
    for (int i = 0; i < 3; ++i)
        if (s.buttons[i]) {
            type = drags[i];
            button = cg_buttons[i];
            break;
        }
    if (!post(CGEventCreateMouseEvent(s.source, type, point, button)))
        return false;
    s.position = point;
    s.positioned = true;
    return true;
}

bool post_wheel(double delta) {
    if (!allowed() || !std::isfinite(delta))
        return false;
    // The protocol's wheel is Windows' scale: 120 to a notch, positive away from the user (the
    // viewer sends one notch per wheel event). A notch scrolls about three lines on Windows;
    // here it is 40 points, positive scrolling up as on Windows.
    const auto pixels = static_cast<int32_t>(std::lround(delta / 3));
    if (!pixels)
        return true;
    return post(
        CGEventCreateScrollWheelEvent2(state().source, kCGScrollEventUnitPixel, 1, pixels, 0, 0));
}

} // namespace platform
