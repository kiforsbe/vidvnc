#pragma once
#include <cstdint>
#include <limits>

// Join keyframes coalesce briefly; recovery keyframes keep the source-wide 2 s limit.
class KeyframeLimiter {
    static constexpr std::int64_t never = std::numeric_limits<std::int64_t>::min() / 2;
    std::int64_t last_join = never, last_recovery = never;
    static bool take(std::int64_t &last, std::int64_t now, std::int64_t interval) {
        if (now - last < interval)
            return false;
        last = now;
        return true;
    }

  public:
    bool join(std::int64_t now) { return take(last_join, now, 500); }
    bool recovery(std::int64_t now) { return take(last_recovery, now, 2000); }
};
