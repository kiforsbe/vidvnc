// Input on Windows: SendInput, keys by scan code so they reach every application; gamepads
// through InputInjector's virtual gamepad (Windows.UI.Input.Preview.Injection), which needs the
// package's inputInjectionBrokered capability.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cmath>
#include <ostream>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Gaming.Input.h>
#include <winrt/Windows.UI.Input.Preview.Injection.h>
#include "../platform.hpp"

namespace platform {

std::string input_unavailable_reason() { return {}; }

static bool inject(INPUT &input) { return SendInput(1, &input, sizeof(input)) == 1; }

static DesktopRect virtual_desktop() {
    return {GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)};
}

bool post_key(unsigned short vk, bool down) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
    input.ki.wScan = static_cast<WORD>(scan & 0xFF);
    input.ki.dwFlags = KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP) |
                       ((scan & 0xFF00) ? KEYEVENTF_EXTENDEDKEY : 0);
    return inject(input);
}

bool post_button(int button, bool down) {
    static const DWORD downs[] = {MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_MIDDLEDOWN,
                                  MOUSEEVENTF_RIGHTDOWN};
    static const DWORD ups[] = {MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP};
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = down ? downs[button] : ups[button];
    return inject(input);
}

bool post_move(double x, double y, const std::optional<CaptureDisplay> &capture_display) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    const auto bounds = capture_display ? capture_display->bounds : primary_bounds();
    if (auto point = desktop_point(x, y, bounds, virtual_desktop())) {
        input.mi.dx = point->x;
        input.mi.dy = point->y;
        input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        return inject(input);
    }
    return false;
}

bool post_wheel(double delta) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = MOUSEEVENTF_WHEEL;
    input.mi.mouseData = static_cast<DWORD>(static_cast<LONG>(delta));
    return inject(input);
}

// ---- Gamepads. One InputInjector per pad index, each with its virtual gamepad plugged in
// while that pad is in use. All calls come from the worker's main loop.

namespace injection = winrt::Windows::UI::Input::Preview::Injection;

static injection::InputInjector pads[max_pads] = {nullptr, nullptr, nullptr, nullptr};
// Set once creating an injector has failed: without the capability every later attempt fails
// the same way, and the log should say so once.
static bool pads_unavailable = false;

static void log_pad_failure(const char *what, const winrt::hresult_error *error = nullptr) {
    if (auto log = worker_log()) {
        *log << "PAD " << what;
        if (error)
            *log << " hr=0x" << std::hex << static_cast<uint32_t>(error->code().value) << std::dec
                 << " " << winrt::to_string(error->message());
        *log << std::endl;
    }
}

bool post_pad(const PadState &pad) {
    auto &injector = pads[pad.index];
    try {
        if (!injector) {
            if (pads_unavailable)
                return false;
            injector = injection::InputInjector::TryCreate();
            if (!injector) {
                pads_unavailable = true;
                log_pad_failure("unavailable: InputInjector::TryCreate returned null (is the "
                                "inputInjectionBrokered capability declared?)");
                return false;
            }
            injector.InitializeGamepadInjection();
        }
        const auto reading = windows_pad_reading(pad);
        injection::InjectedInputGamepadInfo info;
        info.Buttons(static_cast<winrt::Windows::Gaming::Input::GamepadButtons>(reading.buttons));
        info.LeftThumbstickX(reading.left_x);
        info.LeftThumbstickY(reading.left_y);
        info.RightThumbstickX(reading.right_x);
        info.RightThumbstickY(reading.right_y);
        info.LeftTrigger(reading.left_trigger);
        info.RightTrigger(reading.right_trigger);
        injector.InjectGamepadInput(info);
        return true;
    } catch (const winrt::hresult_error &error) {
        log_pad_failure("injection failed:", &error);
        pads_unavailable = true;
        injector = nullptr;
        return false;
    }
}

void unplug_pad(int index) {
    auto &injector = pads[index];
    if (!injector)
        return;
    try {
        // Back to rest first, so nothing reads a held button between now and the removal.
        injector.InjectGamepadInput(injection::InjectedInputGamepadInfo());
        injector.UninitializeGamepadInjection();
    } catch (const winrt::hresult_error &error) {
        log_pad_failure("unplug failed:", &error);
    }
    injector = nullptr;
}

} // namespace platform
