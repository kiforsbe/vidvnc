#pragma once
// One display the worker can capture, as the platform layer lists it
// (platform::enumerate_displays), and the inventory JSON the server reads.
#include <glib.h>
#include <json-glib/json-glib.h>
#include <cstdint>
#include <string>
#include <vector>
#include "display-coordinates.hpp"

struct CaptureDisplay {
    // The platform's own handle: an HMONITOR on Windows, a CGDirectDisplayID on macOS.
    std::uintptr_t handle;
    std::string id, name;
    DesktopRect bounds;
    bool primary, persistent;
    int refresh_hz, rotation;
};
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
