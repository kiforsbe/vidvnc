#pragma once
#include <json-glib/json-glib.h>
struct StreamProfile {
    int width = 2560, height = 1440, fps = 30, bitrate = 6000, mtu = 1200;
};
inline bool parse_stream_profile(JsonObject *object, StreamProfile &result) {
    if (!object || json_object_get_size(object) != 5)
        return false;
    const char *keys[] = {"width", "height", "fps", "bitrateKbps", "mtu"};
    gint64 values[5];
    for (int i = 0; i < 5; ++i) {
        auto node = json_object_get_member(object, keys[i]);
        if (!node || !JSON_NODE_HOLDS_VALUE(node) || json_node_get_value_type(node) != G_TYPE_INT64)
            return false;
        values[i] = json_node_get_int(node);
    }
    if (values[0] < 64 || values[0] > 4096 || values[0] % 2 || values[1] < 64 || values[1] > 4096 ||
        values[1] % 2 || values[2] < 1 || values[2] > 60 || values[3] < 100 || values[3] > 50000 ||
        values[4] != 1200)
        return false;
    result = {static_cast<int>(values[0]), static_cast<int>(values[1]), static_cast<int>(values[2]),
              static_cast<int>(values[3]), 1200};
    return true;
}
