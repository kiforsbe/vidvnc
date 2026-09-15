#pragma once
#include <gst/sdp/sdp.h>
#include <cstring>
#include <string>

struct OfferPayloads {
    std::string video, audio;
};

// "102 H264/90000" -> "102". Payload numbers are interpolated into gst_parse descriptions,
// so anything but 1-3 digits <= 127 is refused.
inline std::string rtpmap_payload(const char *value) {
    const auto space = value ? std::strchr(value, ' ') : nullptr;
    if (!space || space == value || space - value > 3)
        return {};
    std::string candidate(value, space);
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

// Constrained-baseline H.264 with packetization-mode=1 (the last match wins, as before) and
// the first Opus payload.
inline OfferPayloads select_payloads(const GstSDPMessage *sdp) {
    OfferPayloads result;
    for (guint m = 0; m < gst_sdp_message_medias_len(sdp); ++m) {
        const auto media = gst_sdp_message_get_media(sdp, m);
        const auto kind = gst_sdp_media_get_media(media);
        for (guint a = 0; a < gst_sdp_media_attributes_len(media); ++a) {
            const auto attribute = gst_sdp_media_get_attribute(media, a);
            if (g_strcmp0(attribute->key, "rtpmap") != 0 || !attribute->value)
                continue;
            const auto candidate = rtpmap_payload(attribute->value);
            if (candidate.empty())
                continue;
            if (g_strcmp0(kind, "video") == 0 && strstr(attribute->value, "H264/90000")) {
                for (guint f = 0; f < gst_sdp_media_attributes_len(media); ++f) {
                    const auto fmtp = gst_sdp_media_get_attribute(media, f);
                    if (g_strcmp0(fmtp->key, "fmtp") == 0 && fmtp->value &&
                        std::string(fmtp->value).rfind(candidate + " ", 0) == 0 &&
                        strstr(fmtp->value, "packetization-mode=1") &&
                        strstr(fmtp->value, "profile-level-id=42e0"))
                        result.video = candidate;
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
