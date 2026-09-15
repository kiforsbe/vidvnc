#include "../src/input-policy.hpp"
#include "../src/host-input-permission.hpp"
#include <cassert>
int main() {
    HostInputPermission permission;
    assert(!permission.allowed(100));
    permission.grant(100, 5000);
    assert(permission.allowed(100));
    assert(permission.allowed(5099));
    assert(!permission.allowed(5100));
    permission.grant(5200, 5000);
    permission.revoke();
    assert(!permission.allowed(5201));
    permission.grant(6000, 0);
    assert(!permission.allowed(6000));
    permission.grant(6000, 6000); // Owner leases cannot exceed the five-second bound.
    assert(!permission.allowed(6000));
    assert(key_code("KeyA") == 0x41);
    assert(key_code("ControlRight") == 0xA3);
    assert(key_code("made-up") == 0);
    assert(key_code("KeyAA") == 0);
    assert(valid_point(0, 1));
    assert(!valid_point(-0.01, 0));
    assert(!valid_point(NAN, 0));
    assert(!valid_point(0, INFINITY));
    assert(valid_button(0) && valid_button(2));
    assert(!valid_button(3));
}
