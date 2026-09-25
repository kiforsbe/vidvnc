#include <cassert>
#include "../src/ice-ports.hpp"
int main() {
    auto range = parse_ice_ports("40000-40049");
    assert(range && range->min == 40000 && range->max == 40049);
    assert(parse_ice_ports("1024-1031"));
    assert(parse_ice_ports("64536-65535"));
    assert(!parse_ice_ports(nullptr));
    assert(!parse_ice_ports(""));
    assert(!parse_ice_ports("40000"));
    assert(!parse_ice_ports("40000-"));
    assert(!parse_ice_ports("-40000"));
    assert(!parse_ice_ports("40049-40000"));
    assert(!parse_ice_ports("1000-1010"));
    assert(!parse_ice_ports("40000-40006"));
    assert(!parse_ice_ports("40000-41000"));
    assert(!parse_ice_ports("65530-70000"));
    assert(!parse_ice_ports("40000-40049x"));
    assert(!parse_ice_ports(" 40000-40049"));
    assert(!parse_ice_ports("400000-400049"));
}
