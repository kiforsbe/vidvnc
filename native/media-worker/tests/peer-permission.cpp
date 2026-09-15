#include <cassert>
#include "../src/peer-permission.hpp"
int main() {
    PeerPermission permission;
    permission.grant("a", true, 1000, 5000);
    assert(permission.allowed("a", 1000) && !permission.allowed("b", 1000));
    permission.grant("b", true, 2000, 5000);
    assert(!permission.allowed("a", 2000) && permission.allowed("b", 2000));
    permission.revoke("a");
    assert(permission.allowed("b", 2000));
    permission.revoke("b");
    assert(!permission.allowed("b", 2000) && permission.permitted().empty());
    permission.grant("b", true, 3000, 5000);
    permission.grant("ghost", false, 3500, 5000);
    assert(!permission.allowed("b", 3500) && !permission.allowed("ghost", 3500));
    assert(permission.permitted().empty());
    permission.grant("a", true, 4000, 5000);
    assert(permission.allowed("a", 8999) && !permission.allowed("a", 9000));
    permission.grant("a", true, 4000, 5001);
    assert(!permission.allowed("a", 4000) && permission.permitted().empty());
    permission.grant("", true, 4000, 5000);
    assert(permission.permitted().empty());
}
