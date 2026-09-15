#pragma once
#include <cstdint>
#include <limits>

// Only owner-pipe commands may renew this lease. Client pings cannot extend it.
class HostInputPermission {
    std::int64_t expires = 0;

  public:
    bool allowed(std::int64_t now) const { return now >= 0 && now < expires; }
    void revoke() { expires = 0; }
    void grant(std::int64_t now, std::int64_t duration) {
        revoke();
        if (now >= 0 && duration > 0 && duration <= 5000 &&
            now <= std::numeric_limits<std::int64_t>::max() - duration)
            expires = now + duration;
    }
};
