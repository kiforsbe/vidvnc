#include <cassert>
#include "../src/keyframe-limiter.hpp"
int main() {
    KeyframeLimiter limiter;
    assert(limiter.join(0));
    assert(!limiter.join(499));
    assert(limiter.join(500));
    assert(limiter.recovery(100));
    assert(!limiter.recovery(2099));
    assert(limiter.recovery(2100));
    assert(limiter.join(1000));
}
