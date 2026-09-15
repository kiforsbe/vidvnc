#include "../src/display-coordinates.hpp"
#include <cassert>
#include <limits>
int main() {
    const DesktopRect all{-1920, 0, 3840, 1080}, left{-1920, 0, 1920, 1080};
    auto center = desktop_point(.5, .5, left, all);
    assert(center && center->x >= 16370 && center->x <= 16390);
    auto origin = desktop_point(0, 0, left, all);
    assert(origin && origin->x == 0 && origin->y == 0);
    auto end = desktop_point(1, 1, {0, 0, 1920, 1080}, all);
    assert(end && end->x == 65535 && end->y == 65535);
    assert(!desktop_point(-.1, .5, left, all));
    assert(!desktop_point(std::numeric_limits<double>::quiet_NaN(), 0, left, all));
    assert(!desktop_point(0, 0, left, {0, 0, 0, 1080}));
    assert(!desktop_point(0, 0, {-3000, 0, 1920, 1080}, all));
    // Portrait monitor above primary uses already-oriented desktop bounds.
    auto portrait = desktop_point(0, 0, {0, -1920, 1080, 1920}, {0, -1920, 2560, 3360});
    assert(portrait && portrait->x == 0 && portrait->y == 0);
}
