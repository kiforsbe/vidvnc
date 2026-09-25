#pragma once
#include <optional>
#include <string>

// The ICE port range from VIDVNC_ICE_PORTS ("min-max"), so a router can forward exactly the
// ports media uses. The server validates the setting; this parser still refuses anything
// outside the same bounds, and nothing (not a partial range) is applied on a bad value.
struct IcePorts {
    unsigned min;
    unsigned max;
};

inline std::optional<IcePorts> parse_ice_ports(const char *text) {
    if (!text)
        return std::nullopt;
    const std::string value(text);
    const auto dash = value.find('-');
    if (dash == std::string::npos || dash == 0 || dash + 1 >= value.size() || dash > 5 ||
        value.size() - dash - 1 > 5)
        return std::nullopt;
    for (std::size_t i = 0; i < value.size(); ++i)
        if (i != dash && (value[i] < '0' || value[i] > '9'))
            return std::nullopt;
    const auto min = static_cast<unsigned>(std::stoul(value.substr(0, dash)));
    const auto max = static_cast<unsigned>(std::stoul(value.substr(dash + 1)));
    if (min < 1024 || max > 65535 || min > max || max - min + 1 < 8 || max - min + 1 > 1000)
        return std::nullopt;
    return IcePorts{min, max};
}
