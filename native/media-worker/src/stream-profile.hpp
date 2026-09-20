#pragma once
#include <json-glib/json-glib.h>
#include <cstring>
enum class BitrateMode { Cbr, Vbr };
enum class Quality { Efficient, Balanced, High };
struct StreamProfile {
    int width = 2560, height = 1440, fps = 30, bitrate = 6000, mtu = 1200;
    BitrateMode bitrate_mode = BitrateMode::Cbr;
    Quality quality = Quality::Balanced;
};
inline bool parse_stream_profile(JsonObject *object, StreamProfile &result) {
    if (!object || json_object_get_size(object) != 7)
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
    auto string_member = [&](const char *key) -> const char * {
        auto node = json_object_get_member(object, key);
        if (!node || !JSON_NODE_HOLDS_VALUE(node) ||
            json_node_get_value_type(node) != G_TYPE_STRING)
            return nullptr;
        return json_node_get_string(node);
    };
    auto mode = string_member("bitrateMode");
    auto quality = string_member("quality");
    if (!mode || !quality)
        return false;
    StreamProfile parsed = {static_cast<int>(values[0]), static_cast<int>(values[1]),
                            static_cast<int>(values[2]), static_cast<int>(values[3]), 1200};
    if (!strcmp(mode, "cbr"))
        parsed.bitrate_mode = BitrateMode::Cbr;
    else if (!strcmp(mode, "vbr"))
        parsed.bitrate_mode = BitrateMode::Vbr;
    else
        return false;
    if (!strcmp(quality, "efficient"))
        parsed.quality = Quality::Efficient;
    else if (!strcmp(quality, "balanced"))
        parsed.quality = Quality::Balanced;
    else if (!strcmp(quality, "high"))
        parsed.quality = Quality::High;
    else
        return false;
    result = parsed;
    return true;
}
