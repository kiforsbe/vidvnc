#include <json-glib/json-glib.h>
#include <cassert>
#include "../src/stream-profile.hpp"
int main() {
    auto parser = json_parser_new();
    StreamProfile profile;
    auto parse = [&](const char *text) {
        assert(json_parser_load_from_data(parser, text, -1, nullptr));
        return parse_stream_profile(json_node_get_object(json_parser_get_root(parser)), profile);
    };
    assert(parse(R"({"width":1600,"height":900,"fps":30,"bitrateKbps":3000,"mtu":1200})"));
    assert(profile.width == 1600 && profile.height == 900 && profile.bitrate == 3000);
    assert(!parse(R"({"width":1279,"height":720,"fps":15,"bitrateKbps":1000,"mtu":1200})"));
    assert(!parse(R"({"width":1280,"height":720,"fps":"15","bitrateKbps":1000,"mtu":1200})"));
    assert(!parse(R"({"width":1280,"height":720,"fps":true,"bitrateKbps":1000,"mtu":1200})"));
    assert(!parse(R"({"width":1280,"height":720,"fps":15,"bitrateKbps":1000,"mtu":9000})"));
    assert(!parse(R"({"width":1280,"height":720,"fps":61,"bitrateKbps":1000,"mtu":1200})"));
    assert(
        !parse(R"({"width":1280,"height":720,"fps":15,"bitrateKbps":1000,"mtu":1200,"extra":1})"));
    assert(!parse(R"({"width":1280})"));
    g_object_unref(parser);
}
