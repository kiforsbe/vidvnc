#pragma once
#include <gst/sdp/sdp.h>
#include <cstring>
#include <string>
#include "video-codec.hpp"

struct OfferPayloads {
    std::string video, audio;
};

// "102 H264/90000" -> "102". Payload numbers are interpolated into gst_parse descriptions,
// so anything but 1-3 digits <= 127 is refused.
inline std::string rtpmap_payload(const char *value) {
    const auto space = value ? std::strchr(value, ' ') : nullptr;
    if (!space || space == value || space - value > 3)
        return {};
    std::string candidate(value, static_cast<std::size_t>(space - value));
    for (const char c : candidate)
        if (c < '0' || c > '9')
            return {};
    return std::stoi(candidate) <= 127 ? candidate : std::string();
}

inline GstSDPMessage *parse_offer(const std::string &text) {
    if (text.empty() || text.size() > 65536)
        return nullptr;
    GstSDPMessage *sdp = nullptr;
    gst_sdp_message_new(&sdp);
    if (gst_sdp_message_parse_buffer(reinterpret_cast<const guint8 *>(text.data()),
                                     static_cast<guint>(text.size()), sdp) != GST_SDP_OK ||
        !gst_sdp_message_get_version(sdp) || gst_sdp_message_medias_len(sdp) < 1) {
        gst_sdp_message_free(sdp);
        return nullptr;
    }
    return sdp;
}

// ASCII case-insensitive substring search. The server's offeredVideoCodecs() matches the
// rtpmap encoding name case-insensitively (and a unit test asserts a lowercase "av1/90000"
// offer is recognised), so the worker must agree here or it can refuse a peer the server
// already committed the policy to.
inline bool strstr_ci(const char *haystack, const char *needle) {
    if (!haystack || !needle)
        return false;
    const auto lower = [](unsigned char c) -> unsigned char {
        return c >= 'A' && c <= 'Z' ? static_cast<unsigned char>(c - 'A' + 'a') : c;
    };
    const std::size_t needle_len = std::strlen(needle);
    if (needle_len == 0)
        return true;
    for (const char *h = haystack; *h; ++h) {
        std::size_t i = 0;
        while (i < needle_len && h[i] &&
               lower(static_cast<unsigned char>(h[i])) ==
                   lower(static_cast<unsigned char>(needle[i])))
            ++i;
        if (i == needle_len)
            return true;
    }
    return false;
}

// `params` is the fmtp value with the leading payload number already stripped. True when
// `key` is absent, or present with exactly `value`. Parameters are split on ';' and trimmed;
// the key is compared exactly, so "profile-id=1" never matches "xprofile-id=1" and
// "profile=0" never matches "profile-id=0".
inline bool fmtp_profile_ok(const std::string &params, const std::string &key,
                            const std::string &value) {
    bool present = false, matches = false;
    std::size_t pos = 0;
    while (pos <= params.size()) {
        const auto semi = params.find(';', pos);
        auto token = params.substr(pos, semi == std::string::npos ? std::string::npos : semi - pos);
        const auto begin = token.find_first_not_of(' ');
        if (begin != std::string::npos) {
            const auto end = token.find_last_not_of(' ');
            token = token.substr(begin, end - begin + 1);
            const auto eq = token.find('=');
            if (eq != std::string::npos && token.substr(0, eq) == key) {
                present = true;
                matches = token.substr(eq + 1) == value;
            }
        }
        if (semi == std::string::npos)
            break;
        pos = semi + 1;
    }
    return !present || matches;
}

// Constrained-baseline H.264 with packetization-mode=1 keeps its own last-match-wins rule
// (unchanged). H.265 and AV1 match the codec's rtpmap value and take the first payload whose
// fmtp either omits the profile key, or carries the accepted value (H.265 profile-id=1,
// AV1 profile=0). Audio always selects the first Opus payload.
inline OfferPayloads select_payloads(const GstSDPMessage *sdp, const VideoCodec &codec) {
    OfferPayloads result;
    const bool h264 = codec.id == "h264";
    const std::string profile_key = codec.id == "h265" ? "profile-id" : "profile";
    const std::string profile_value = codec.id == "h265" ? "1" : "0";
    for (guint m = 0; m < gst_sdp_message_medias_len(sdp); ++m) {
        const auto media = gst_sdp_message_get_media(sdp, m);
        const auto kind = gst_sdp_media_get_media(media);
        bool video_matched = false;
        for (guint a = 0; a < gst_sdp_media_attributes_len(media); ++a) {
            if (!h264 && video_matched)
                break;
            const auto attribute = gst_sdp_media_get_attribute(media, a);
            if (g_strcmp0(attribute->key, "rtpmap") != 0 || !attribute->value)
                continue;
            const auto candidate = rtpmap_payload(attribute->value);
            if (candidate.empty())
                continue;
            if (g_strcmp0(kind, "video") == 0 && h264 && strstr(attribute->value, "H264/90000")) {
                for (guint f = 0; f < gst_sdp_media_attributes_len(media); ++f) {
                    const auto fmtp = gst_sdp_media_get_attribute(media, f);
                    if (g_strcmp0(fmtp->key, "fmtp") == 0 && fmtp->value &&
                        std::string(fmtp->value).rfind(candidate + " ", 0) == 0 &&
                        strstr(fmtp->value, "packetization-mode=1") &&
                        strstr(fmtp->value, "profile-level-id=42e0"))
                        result.video = candidate;
                }
            } else if (g_strcmp0(kind, "video") == 0 && !h264 &&
                       strstr_ci(attribute->value, codec.rtpmap.c_str())) {
                bool has_fmtp = false;
                std::string params;
                for (guint f = 0; f < gst_sdp_media_attributes_len(media); ++f) {
                    const auto fmtp = gst_sdp_media_get_attribute(media, f);
                    if (g_strcmp0(fmtp->key, "fmtp") == 0 && fmtp->value &&
                        std::string(fmtp->value).rfind(candidate + " ", 0) == 0) {
                        has_fmtp = true;
                        params = std::string(fmtp->value).substr(candidate.size() + 1);
                        break;
                    }
                }
                if (!has_fmtp || fmtp_profile_ok(params, profile_key, profile_value)) {
                    result.video = candidate;
                    video_matched = true;
                }
            }
            if (g_strcmp0(kind, "audio") == 0 && result.audio.empty() &&
                (strstr(attribute->value, " opus/48000/2") ||
                 strstr(attribute->value, " opus/48000")))
                result.audio = candidate;
        }
    }
    return result;
}
