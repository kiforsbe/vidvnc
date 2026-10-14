// Input on Windows: SendInput, keys by scan code so they reach every application; gamepads
// through InputInjector's virtual gamepad (Windows.UI.Input.Preview.Injection), which needs the
// package's inputInjectionBrokered capability.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <map>
#include <mutex>
#include <ostream>
#include <string>
#include <thread>
#include <vector>
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
// while that pad is in use. Every WinRT call runs on one thread of its own, which joins the
// multithreaded apartment once and keeps it for the worker's life. Called from the GLib main
// thread instead, they crashed the worker (0xC0000005 in C++/WinRT's cached activation factory,
// about 30 s in): that thread's COM apartment is started and ended by other code in the
// process, which left the cached factory pointing at freed memory.

namespace injection = winrt::Windows::UI::Input::Preview::Injection;

namespace {

struct PadCommand {
    bool unplug = false;
    PadState pad;
};

std::mutex pad_mutex;
std::condition_variable pad_wake;
// The newest command per pad index, so a slow injection can never build up a backlog.
std::map<int, PadCommand> pad_commands;
bool pad_thread_started = false;
// Set once creating an injector has failed: without the capability every later attempt fails
// the same way. Read by the main thread, set by the pad thread.
std::atomic<bool> pads_unavailable{false};
// Failures the pad thread found, logged by the main thread (the log is not thread-safe).
std::vector<std::string> pad_failures;

void pad_failure(std::string what, const winrt::hresult_error *error = nullptr) {
    if (error)
        what += " hr=0x" +
                [&] {
                    char code[9];
                    std::snprintf(code, sizeof(code), "%08x",
                                  static_cast<uint32_t>(error->code().value));
                    return std::string(code);
                }() +
                " " + winrt::to_string(error->message());
    std::lock_guard lock(pad_mutex);
    if (pad_failures.size() < 16)
        pad_failures.push_back(std::move(what));
}

void inject(injection::InputInjector &injector, const PadState &pad) {
    if (!injector) {
        injector = injection::InputInjector::TryCreate();
        if (!injector) {
            pads_unavailable = true;
            pad_failure("unavailable: InputInjector::TryCreate returned null (is the "
                        "inputInjectionBrokered capability declared?)");
            return;
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
}

void remove(injection::InputInjector &injector) {
    if (!injector)
        return;
    // Back to rest first, so nothing reads a held button between now and the removal.
    injector.InjectGamepadInput(injection::InjectedInputGamepadInfo());
    injector.UninitializeGamepadInjection();
    injector = nullptr;
}

void pad_thread() {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    injection::InputInjector pads[max_pads] = {nullptr, nullptr, nullptr, nullptr};
    for (;;) {
        std::map<int, PadCommand> commands;
        {
            std::unique_lock lock(pad_mutex);
            pad_wake.wait(lock, [] { return !pad_commands.empty(); });
            commands.swap(pad_commands);
        }
        for (auto &[index, command] : commands) {
            auto &injector = pads[index];
            try {
                if (command.unplug)
                    remove(injector);
                else if (!pads_unavailable)
                    inject(injector, command.pad);
            } catch (const winrt::hresult_error &error) {
                pad_failure(command.unplug ? "unplug failed:" : "injection failed:", &error);
                if (!command.unplug)
                    pads_unavailable = true;
                injector = nullptr;
            } catch (...) {
                pad_failure(command.unplug ? "unplug failed with a non-WinRT exception"
                                           : "injection failed with a non-WinRT exception");
                if (!command.unplug)
                    pads_unavailable = true;
                injector = nullptr;
            }
        }
    }
}

void queue(int index, PadCommand command) {
    std::vector<std::string> failures;
    {
        std::lock_guard lock(pad_mutex);
        if (!pad_thread_started) {
            pad_thread_started = true;
            std::thread(pad_thread).detach();
        }
        pad_commands[index] = command;
        failures.swap(pad_failures);
    }
    pad_wake.notify_one();
    if (auto log = worker_log())
        for (const auto &failure : failures)
            *log << "PAD " << failure << std::endl;
}

} // namespace

// Queued for the pad thread; false once injection is known to be unavailable.
bool post_pad(const PadState &pad) {
    if (pads_unavailable)
        return false;
    queue(pad.index, {false, pad});
    return true;
}

void unplug_pad(int index) { queue(index, {true, {}}); }

} // namespace platform
