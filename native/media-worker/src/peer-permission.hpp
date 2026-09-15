#pragma once
#include <cstdint>
#include <string>
#include "host-input-permission.hpp"

// One permitted peer per source worker. Only owner-pipe commands change it; client pings cannot.
class PeerPermission {
    HostInputPermission lease;
    std::string owner;

  public:
    // An unknown peer means the server's view is stale: refuse it and clear the current owner.
    void grant(const std::string &peer, bool known, std::int64_t now, std::int64_t duration) {
        lease.revoke();
        owner.clear();
        if (!known || peer.empty())
            return;
        lease.grant(now, duration);
        if (lease.allowed(now))
            owner = peer;
    }
    void revoke(const std::string &peer) {
        if (peer != owner)
            return;
        lease.revoke();
        owner.clear();
    }
    bool allowed(const std::string &peer, std::int64_t now) const {
        return !owner.empty() && peer == owner && lease.allowed(now);
    }
    const std::string &permitted() const { return owner; }
};
