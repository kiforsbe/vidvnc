#pragma once
#include <cmath>
#include <optional>
struct DesktopRect {
    int x, y, width, height;
};
struct AbsolutePoint {
    long x, y;
};
inline std::optional<AbsolutePoint> desktop_point(double x, double y, DesktopRect display,
                                                  DesktopRect desktop) {
    if (!std::isfinite(x) || !std::isfinite(y) || x < 0 || y < 0 || x > 1 || y > 1 ||
        display.width <= 0 || display.height <= 0 || desktop.width <= 1 || desktop.height <= 1 ||
        display.x < desktop.x || display.y < desktop.y ||
        static_cast<double>(display.x) + display.width >
            static_cast<double>(desktop.x) + desktop.width ||
        static_cast<double>(display.y) + display.height >
            static_cast<double>(desktop.y) + desktop.height)
        return std::nullopt;
    return AbsolutePoint{static_cast<long>(std::lround((display.x - static_cast<double>(desktop.x) +
                                                        x * (display.width - 1)) *
                                                       65535 / (desktop.width - 1))),
                         static_cast<long>(std::lround((display.y - static_cast<double>(desktop.y) +
                                                        y * (display.height - 1)) *
                                                       65535 / (desktop.height - 1)))};
}
