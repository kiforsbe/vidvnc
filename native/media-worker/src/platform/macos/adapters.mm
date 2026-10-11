// `media-worker --adapters` on macOS (design D6): what each network interface is, for the
// server's LAN eligibility (apps/server/src/macos-lan-adapters.mjs documents the JSON). It
// only reads: SystemConfiguration for interface types, routers and the routers' hardware
// addresses, getifaddrs for state and addresses, and IOKit for Thunderbolt ports.
// Nothing is sent on any network, so no Local Network prompt can follow from it.
#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <json-glib/json-glib.h>
#include <cstddef>
#include <cstdio>
#include <stdexcept>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <vector>
#include "../platform.hpp"

namespace {

struct Address {
    std::string text;
    int prefix_length;
};
struct Router {
    std::string address, hardware_address;
};
struct Interface {
    std::string name;
    std::optional<std::string> type; // SCNetworkInterfaceGetInterfaceType, if listed
    bool thunderbolt = false, up = false;
    std::vector<Address> addresses;
    std::optional<Router> router;
};

std::string utf8(CFStringRef text) {
    if (!text)
        return {};
    char buffer[256];
    return CFStringGetCString(text, buffer, sizeof(buffer), kCFStringEncodingUTF8) ? buffer
                                                                                   : std::string();
}

// The mask's leading one bits. The kernel may shorten a mask's sockaddr to its last non-zero
// byte, so only `sa_len` bytes are read.
int prefix_length(const sockaddr *mask, int family) {
    if (!mask)
        return 0;
    const std::size_t offset =
        family == AF_INET ? offsetof(sockaddr_in, sin_addr) : offsetof(sockaddr_in6, sin6_addr);
    const std::size_t size = family == AF_INET ? 4 : 16;
    const auto bytes = reinterpret_cast<const unsigned char *>(mask);
    int bits = 0;
    for (std::size_t i = 0; i < size && offset + i < mask->sa_len; ++i) {
        for (int bit = 7; bit >= 0; --bit) {
            if (!(bytes[offset + i] >> bit & 1))
                return bits;
            ++bits;
        }
    }
    return bits;
}

std::optional<std::string> address_text(const sockaddr *address) {
    char text[INET6_ADDRSTRLEN] = {};
    if (address->sa_family == AF_INET) {
        const auto &in = reinterpret_cast<const sockaddr_in *>(address)->sin_addr;
        if (!inet_ntop(AF_INET, &in, text, sizeof(text)))
            return std::nullopt;
    } else if (address->sa_family == AF_INET6) {
        auto in6 = reinterpret_cast<const sockaddr_in6 *>(address)->sin6_addr;
        // The kernel embeds the scope in a link-local address's second 16 bits; the address
        // itself has zeros there.
        if (IN6_IS_ADDR_LINKLOCAL(&in6))
            in6.s6_addr[2] = in6.s6_addr[3] = 0;
        if (!inet_ntop(AF_INET6, &in6, text, sizeof(text)))
            return std::nullopt;
    } else
        return std::nullopt;
    return std::string(text);
}

// Ethernet over a Thunderbolt port: the interface's driver is Apple's Thunderbolt IP port.
bool thunderbolt_port(const std::string &name) {
    CFMutableDictionaryRef matching = IOBSDNameMatching(kIOMainPortDefault, 0, name.c_str());
    if (!matching)
        return false;
    io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, matching);
    if (!service)
        return false;
    bool found = false;
    io_registry_entry_t entry = service;
    IOObjectRetain(entry);
    for (int depth = 0; depth < 4 && entry && !found; ++depth) {
        io_name_t class_name = {};
        if (IOObjectGetClass(entry, class_name) == KERN_SUCCESS &&
            std::string(class_name).find("Thunderbolt") != std::string::npos)
            found = true;
        io_registry_entry_t parent = 0;
        const bool has_parent =
            IORegistryEntryGetParentEntry(entry, kIOServicePlane, &parent) == KERN_SUCCESS;
        IOObjectRelease(entry);
        entry = has_parent ? parent : 0;
    }
    if (entry)
        IOObjectRelease(entry);
    IOObjectRelease(service);
    return found;
}

// Each interface's IPv4 router and its hardware address, from the services' dynamic state:
// the address configd resolved for the router, which is also what it identifies the network
// by (its NetworkSignature).
std::map<std::string, Router> routers() {
    std::map<std::string, Router> result;
    SCDynamicStoreRef store =
        SCDynamicStoreCreate(nullptr, CFSTR("vidvnc-adapters"), nullptr, nullptr);
    if (!store)
        return result;
    CFArrayRef keys = SCDynamicStoreCopyKeyList(store, CFSTR("State:/Network/Service/[^/]+/IPv4"));
    const auto text = [](CFDictionaryRef dictionary, CFStringRef key) {
        const auto value = CFDictionaryGetValue(dictionary, key);
        return value && CFGetTypeID(value) == CFStringGetTypeID()
                   ? utf8(static_cast<CFStringRef>(value))
                   : std::string();
    };
    if (keys) {
        for (CFIndex i = 0; i < CFArrayGetCount(keys); ++i) {
            const auto key = static_cast<CFStringRef>(CFArrayGetValueAtIndex(keys, i));
            CFPropertyListRef value = SCDynamicStoreCopyValue(store, key);
            if (value && CFGetTypeID(value) == CFDictionaryGetTypeID()) {
                const auto dictionary = static_cast<CFDictionaryRef>(value);
                const auto name = text(dictionary, kSCPropInterfaceName);
                const auto router = text(dictionary, kSCPropNetIPv4Router);
                const auto resolved = text(dictionary, CFSTR("ARPResolvedIPAddress"));
                const auto hardware = text(dictionary, CFSTR("ARPResolvedHardwareAddress"));
                if (!name.empty() && !router.empty() && resolved == router && !hardware.empty())
                    result[name] = {router, hardware};
            }
            if (value)
                CFRelease(value);
        }
        CFRelease(keys);
    }
    CFRelease(store);
    return result;
}

std::vector<Interface> interfaces() {
    std::map<std::string, Interface> rows;
    ifaddrs *list = nullptr;
    if (getifaddrs(&list) != 0)
        throw std::runtime_error("Unable to list the network interfaces");
    for (auto entry = list; entry; entry = entry->ifa_next) {
        if (!entry->ifa_name)
            continue;
        auto &row = rows[entry->ifa_name];
        row.name = entry->ifa_name;
        row.up = (entry->ifa_flags & IFF_UP) && (entry->ifa_flags & IFF_RUNNING);
        if (!entry->ifa_addr || (entry->ifa_flags & IFF_LOOPBACK))
            continue;
        if (auto text = address_text(entry->ifa_addr))
            row.addresses.push_back(
                {*text, prefix_length(entry->ifa_netmask, entry->ifa_addr->sa_family)});
    }
    freeifaddrs(list);
    // Loopback is never a LAN; an interface with no IP address cannot be one either.
    for (auto it = rows.begin(); it != rows.end();)
        it = it->second.addresses.empty() ? rows.erase(it) : std::next(it);
    CFArrayRef all = SCNetworkInterfaceCopyAll();
    if (all) {
        for (CFIndex i = 0; i < CFArrayGetCount(all); ++i) {
            const auto interface =
                static_cast<SCNetworkInterfaceRef>(CFArrayGetValueAtIndex(all, i));
            const auto name = utf8(SCNetworkInterfaceGetBSDName(interface));
            const auto found = rows.find(name);
            if (found != rows.end())
                found->second.type = utf8(SCNetworkInterfaceGetInterfaceType(interface));
        }
        CFRelease(all);
    }
    const auto known_routers = routers();
    std::vector<Interface> result;
    for (auto &[name, row] : rows) {
        row.thunderbolt = thunderbolt_port(name);
        const auto router = known_routers.find(name);
        if (router != known_routers.end())
            row.router = router->second;
        result.push_back(std::move(row));
    }
    return result;
}

} // namespace

namespace platform {

int list_adapters() {
    try {
        @autoreleasepool {
            auto array = json_array_new();
            for (const auto &row : interfaces()) {
                auto object = json_object_new();
                json_object_set_string_member(object, "name", row.name.c_str());
                if (row.type)
                    json_object_set_string_member(object, "type", row.type->c_str());
                else
                    json_object_set_null_member(object, "type");
                json_object_set_boolean_member(object, "thunderbolt", row.thunderbolt);
                json_object_set_boolean_member(object, "up", row.up);
                auto addresses = json_array_new();
                for (const auto &address : row.addresses) {
                    auto item = json_object_new();
                    json_object_set_string_member(item, "address", address.text.c_str());
                    json_object_set_int_member(item, "prefixLength", address.prefix_length);
                    json_array_add_object_element(addresses, item);
                }
                json_object_set_array_member(object, "addresses", addresses);
                if (row.router) {
                    auto router = json_object_new();
                    json_object_set_string_member(router, "address", row.router->address.c_str());
                    json_object_set_string_member(router, "hardwareAddress",
                                                  row.router->hardware_address.c_str());
                    json_object_set_object_member(object, "router", router);
                } else
                    json_object_set_null_member(object, "router");
                json_array_add_object_element(array, object);
            }
            auto document = json_object_new();
            json_object_set_array_member(document, "interfaces", array);
            auto node = json_node_new(JSON_NODE_OBJECT);
            json_node_take_object(node, document);
            auto text = json_to_string(node, false);
            std::cout << text << std::endl;
            g_free(text);
            json_node_free(node);
        }
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}

} // namespace platform
