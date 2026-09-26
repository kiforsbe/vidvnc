#pragma once
// json-glib helpers shared by the media worker and media-net. Every accessor tolerates a
// missing or mistyped member, because both processes parse JSON from a less trusted side.
#include <json-glib/json-glib.h>
#include <cmath>
#include <initializer_list>
#include <string>
#include <utility>

inline JsonObject *parse_object(const std::string &text, JsonParser **parser) {
    *parser = json_parser_new();
    if (!json_parser_load_from_data(*parser, text.c_str(), static_cast<gssize>(text.size()),
                                    nullptr))
        return nullptr;
    auto root = json_parser_get_root(*parser);
    return root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : nullptr;
}
inline const char *string_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    return node && JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING
               ? json_node_get_string(node)
               : "";
}
inline double number_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    if (!node || !JSON_NODE_HOLDS_VALUE(node))
        return NAN;
    auto type = json_node_get_value_type(node);
    return type == G_TYPE_DOUBLE || type == G_TYPE_INT64 ? json_node_get_double(node) : NAN;
}
inline bool boolean_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    return node && JSON_NODE_HOLDS_VALUE(node) &&
           json_node_get_value_type(node) == G_TYPE_BOOLEAN && json_node_get_boolean(node);
}
// Takes ownership of `object`.
inline std::string object_text(JsonObject *object) {
    auto node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, object);
    auto text = json_to_string(node, false);
    std::string result = text;
    g_free(text);
    json_node_free(node);
    return result;
}
inline JsonObject *
typed_object(const char *type,
             std::initializer_list<std::pair<const char *, std::string>> fields = {}) {
    auto object = json_object_new();
    json_object_set_string_member(object, "type", type);
    for (const auto &field : fields)
        json_object_set_string_member(object, field.first, field.second.c_str());
    return object;
}
