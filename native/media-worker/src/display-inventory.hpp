#pragma once
#include <windows.h>
#include <glib.h>
#include <json-glib/json-glib.h>
#include <string>
#include <vector>
#include <algorithm>
#include <stdexcept>
#include "display-coordinates.hpp"

struct CaptureDisplay {
    HMONITOR handle;
    std::string id, name;
    DesktopRect bounds;
    bool primary, persistent;
    int refresh_hz, rotation;
};
inline std::string display_utf8(const wchar_t *text) {
    const int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (length <= 0)
        return {};
    std::string result(length, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), length, nullptr, nullptr);
    result.resize(length - 1);
    return result;
}
inline std::vector<CaptureDisplay> enumerate_displays() {
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
                    {monitor,
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
inline JsonArray *display_inventory_json(const std::vector<CaptureDisplay> &rows) {
    auto array = json_array_new();
    for (const auto &d : rows) {
        auto object = json_object_new();
        json_object_set_string_member(object, "id", d.id.c_str());
        json_object_set_string_member(object, "name", d.name.c_str());
        json_object_set_boolean_member(object, "primary", d.primary);
        json_object_set_boolean_member(object, "persistent", d.persistent);
        json_object_set_int_member(object, "x", d.bounds.x);
        json_object_set_int_member(object, "y", d.bounds.y);
        json_object_set_int_member(object, "width", d.bounds.width);
        json_object_set_int_member(object, "height", d.bounds.height);
        json_object_set_int_member(object, "rotation", d.rotation);
        if (d.refresh_hz)
            json_object_set_int_member(object, "refreshHz", d.refresh_hz);
        else
            json_object_set_null_member(object, "refreshHz");
        json_array_add_object_element(array, object);
    }
    return array;
}
