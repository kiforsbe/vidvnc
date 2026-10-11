// Input on Windows: SendInput, keys by scan code so they reach every application.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cmath>
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

} // namespace platform
