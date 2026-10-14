// Which game input APIs see InputInjector's virtual gamepad (platform/windows/input.cpp).
// Plugs one in, holds A, the left stick half right and the right trigger, then reports what
// XInput and Windows.Gaming.Input read. Not a CTest: whether it works depends on the process's
// package identity and capabilities, so run it by hand, unpackaged and from the package.
//
//   pad-probe [seconds to hold, default 3] [seconds to stay running after unplugging]
//   pad-probe stages <seconds>   (presence of the device at each step, as the worker does them)
//             [inject-only]   (no XInput or Windows.Gaming.Input calls, as in the worker)
//   pad-probe observe <seconds>   (report only, while another process injects)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cfgmgr32.h>
#include <xinput.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <chrono>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Gaming.Input.h>
#include <winrt/Windows.UI.Input.Preview.Injection.h>

using namespace winrt::Windows::Gaming::Input;
using namespace winrt::Windows::UI::Input::Preview::Injection;

// `inject-only`: no XInput or Windows.Gaming.Input calls at all, as in the worker.
static bool inject_only = false;

static void report_xinput(const char *when) {
    if (inject_only)
        return;
    for (DWORD slot = 0; slot < XUSER_MAX_COUNT; ++slot) {
        XINPUT_STATE state{};
        if (XInputGetState(slot, &state) == ERROR_SUCCESS)
            std::printf("  xinput %s: slot %lu buttons=0x%04x lx=%d rt=%u\n", when, slot,
                        state.Gamepad.wButtons, state.Gamepad.sThumbLX,
                        state.Gamepad.bRightTrigger);
    }
}

static void report_wgi(const char *when) {
    if (inject_only)
        return;
    const auto pads = Gamepad::Gamepads();
    std::printf("  wgi %s: %u gamepad(s)\n", when, pads.Size());
    for (const auto &pad : pads) {
        const auto reading = pad.GetCurrentReading();
        std::printf("    buttons=0x%04x lx=%.2f rt=%.2f\n", static_cast<unsigned>(reading.Buttons),
                    reading.LeftThumbstickX, reading.RightTrigger);
    }
    std::printf("  wgi %s: %u raw controller(s)\n", when,
                RawGameController::RawGameControllers().Size());
}

// Whether Windows' synthetic Xbox controller (the device InputInjector's gamepad uses) is
// present now.
static bool synthetic_present() {
    DEVINST node = 0;
    wchar_t id[] = L"SWD\\XBOXGIPSYNTHETIC\\XBOXGIPSYNTHETIC_000";
    return CM_Locate_DevNodeW(&node, id, CM_LOCATE_DEVNODE_NORMAL) == CR_SUCCESS;
}

// `pad-probe stages <seconds>`: each step of a virtual gamepad's life, held for <seconds>,
// with whether the device is present once a second.
static int stages(int hold) {
    const auto stage = [hold](const char *name) {
        for (int second = 0; second < hold; ++second) {
            std::printf("%-28s t+%ds present=%s\n", name, second,
                        synthetic_present() ? "yes" : "no");
            std::fflush(stdout);
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    };
    stage("1 process started");
    InputInjector injector{nullptr};
    try {
        injector = InputInjector::TryCreate();
    } catch (const winrt::hresult_error &error) {
        std::printf("TryCreate failed: 0x%08x %ls\n", static_cast<unsigned>(error.code().value),
                    error.message().c_str());
        return 3;
    } catch (...) {
        std::printf("TryCreate failed with a non-WinRT exception\n");
        return 4;
    }
    if (!injector) {
        std::printf("TryCreate returned null\n");
        return 2;
    }
    stage("2 TryCreate");
    injector.InitializeGamepadInjection();
    stage("3 InitializeGamepadInjection");
    InjectedInputGamepadInfo info;
    info.Buttons(GamepadButtons::A);
    injector.InjectGamepadInput(info);
    stage("4 InjectGamepadInput");
    injector.InjectGamepadInput(InjectedInputGamepadInfo());
    injector.UninitializeGamepadInjection();
    stage("5 UninitializeGamepadInjection");
    injector = nullptr;
    stage("6 injector released");
    injector = InputInjector::TryCreate();
    injector.InitializeGamepadInjection();
    injector.InjectGamepadInput(info);
    stage("7 plugged in again");
    injector.InjectGamepadInput(InjectedInputGamepadInfo());
    injector.UninitializeGamepadInjection();
    injector = nullptr;
    std::printf("8 exiting\n");
    return 0;
}

int main(int argc, char **argv) {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const int seconds = argc > 1 ? std::atoi(argv[1]) : 3;
    if (argc > 2 && std::string(argv[1]) == "stages")
        return stages(std::atoi(argv[2]));
    inject_only = argc > 3 && std::string(argv[3]) == "inject-only";
    // Windows.Gaming.Input fills its lists once something listens for controllers arriving.
    if (!inject_only) {
        Gamepad::GamepadAdded(
            [](auto &&, const Gamepad &) { std::printf("  event: GamepadAdded\n"); });
        Gamepad::GamepadRemoved(
            [](auto &&, const Gamepad &) { std::printf("  event: GamepadRemoved\n"); });
        RawGameController::RawGameControllerAdded([](auto &&, const RawGameController &controller) {
            std::printf("  event: RawGameControllerAdded %ls\n", controller.DisplayName().c_str());
        });
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1000));
    // `pad-probe observe N`: only report, once a second, while another process injects.
    if (argc > 2 && std::string(argv[1]) == "observe") {
        for (int second = 0; second < std::atoi(argv[2]); ++second) {
            std::printf("t=%d:\n", second);
            report_xinput("observed");
            report_wgi("observed");
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        return 0;
    }
    std::printf("before:\n");
    report_xinput("before");
    report_wgi("before");
    try {
        auto injector = InputInjector::TryCreate();
        if (!injector) {
            std::printf("InputInjector::TryCreate returned null: no inputInjectionBrokered.\n");
            return 2;
        }
        injector.InitializeGamepadInjection();
        InjectedInputGamepadInfo info;
        info.Buttons(GamepadButtons::A);
        info.LeftThumbstickX(0.5);
        info.RightTrigger(1.0);
        for (int tick = 0; tick < seconds * 10; ++tick) {
            injector.InjectGamepadInput(info);
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        std::printf("while holding A, left stick +0.5, right trigger 1.0:\n");
        report_xinput("holding");
        report_wgi("holding");
        injector.InjectGamepadInput(InjectedInputGamepadInfo());
        injector.UninitializeGamepadInjection();
    } catch (const winrt::hresult_error &error) {
        std::printf("failed: 0x%08x %ls\n", static_cast<unsigned>(error.code().value),
                    error.message().c_str());
        return 1;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    std::printf("after unplugging:\n");
    report_xinput("after");
    report_wgi("after");
    // Stay alive with the injector released, as the worker does after unplugging, to see
    // whether the device leaves without the process exiting.
    if (argc > 2)
        std::this_thread::sleep_for(std::chrono::seconds(std::atoi(argv[2])));
    return 0;
}
