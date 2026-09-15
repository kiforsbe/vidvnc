#include <gst/gst.h>
#include <json-glib/json-glib.h>
#include <string>
#include <cassert>
#include "../src/transport-telemetry.hpp"
int main() {
    PacketWindow window;
    window.add(1200, 0);
    window.add(800, 500);
    window.add(100, 1000);
    auto result = json_object_new();
    window.merge(result, "test");
    assert(json_object_get_double_member(result, "testPackets") == 3);
    assert(json_object_get_double_member(result, "testBytes") == 2100);
    assert(json_object_get_double_member(result, "testPeak1msBytes") == 2000);
    assert(json_object_get_double_member(result, "testPeak10msBytes") == 2100);
    window.add(50, 11000);
    window.merge(result, "test");
    assert(json_object_get_double_member(result, "testPeak1msBytes") == 50);
    assert(json_object_get_double_member(result, "testPeak10msBytes") == 50);
    for (int i = 0; i < 9000; ++i)
        window.add(1, 12000);
    window.merge(result, "test");
    assert(json_object_get_double_member(result, "testWindowTruncated") > 0);
    assert(window.recent.size() <= 8192 && window.shortRecent.size() <= 8192);
    json_object_unref(result);
}
