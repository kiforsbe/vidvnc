// Display inventory on Windows: one row per monitor, identified by its persistent device
// interface where Windows has one.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <stdexcept>
#include "../platform.hpp"

namespace platform {

static std::string display_utf8(const wchar_t *text) {
    const int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (length <= 0)
        return {};
    std::string result(length, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), length, nullptr, nullptr);
    result.resize(length - 1);
    return result;
}
std::vector<CaptureDisplay> enumerate_displays() {
    std::vector<CaptureDisplay> result;
    if (!EnumDisplayMonitors(
            nullptr, nullptr,
            [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
                auto &rows = *reinterpret_cast<std::vector<CaptureDisplay> *>(data);
                MONITORINFOEXW info{};
                info.cbSize = sizeof(info);
                if (!GetMonitorInfoW(monitor, &info))
                    return FALSE;
                DISPLAY_DEVICEW device{};
                device.cb = sizeof(device);
                bool persistent =
                    EnumDisplayDevicesW(info.szDevice, 0, &device, EDD_GET_DEVICE_INTERFACE_NAME) &&
                    device.DeviceID[0];
                // Persistent device interface, not display number. Ephemeral identities are
                // explicitly marked so policy must never persist permission for them.
                auto identity = persistent
                                    ? display_utf8(device.DeviceID)
                                    : display_utf8(info.szDevice) + ":" +
                                          std::to_string(reinterpret_cast<uintptr_t>(monitor));
                auto hash = g_compute_checksum_for_string(G_CHECKSUM_SHA256, identity.c_str(), -1);
                std::string id = hash;
                g_free(hash);
                DEVMODEW mode{};
                mode.dmSize = sizeof(mode);
                const bool have_mode =
                    EnumDisplaySettingsExW(info.szDevice, ENUM_CURRENT_SETTINGS, &mode, 0);
                rows.push_back(
                    {reinterpret_cast<std::uintptr_t>(monitor),
                     id,
                     device.DeviceString[0] ? display_utf8(device.DeviceString) : "Display",
                     {info.rcMonitor.left, info.rcMonitor.top,
                      info.rcMonitor.right - info.rcMonitor.left,
                      info.rcMonitor.bottom - info.rcMonitor.top},
                     (info.dwFlags & MONITORINFOF_PRIMARY) != 0,
                     persistent,
                     have_mode && mode.dmDisplayFrequency > 1
                         ? static_cast<int>(mode.dmDisplayFrequency)
                         : 0,
                     have_mode ? static_cast<int>(mode.dmDisplayOrientation) * 90 : 0});
                return TRUE;
            },
            reinterpret_cast<LPARAM>(&result)))
        throw std::runtime_error("Unable to enumerate displays");
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
    return {0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)};
}

} // namespace platform
