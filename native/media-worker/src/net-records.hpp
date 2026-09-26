#pragma once
// Binary records between the media worker and its sandboxed network process, media-net
// (docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-split-design.md, "Pipes
// between the worker and media-net"). Portable: no Windows or GStreamer types, so the parsing
// the worker does on data from the untrusted media-net is unit-tested on its own.
//
// Frames (worker -> media-net): a 32-byte header, then `length` payload bytes.
// Input (media-net -> worker): a 4-byte header (peer id length, text length), the peer id,
// then the data-channel text exactly as the browser sent it.
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <string_view>

namespace net_records {

constexpr std::uint32_t frame_magic = 0x4d524656; // "VFRM", little-endian
constexpr std::size_t frame_header_size = 32;
// A 4K keyframe is a few megabytes at the bitrates VidVNC uses; anything larger is refused.
constexpr std::uint32_t max_frame_bytes = 16u * 1024 * 1024;
constexpr std::uint32_t max_caps_bytes = 4096;
constexpr std::size_t max_peer_id = 64;
constexpr std::size_t max_input_text = 1024;
// JSON lines on the control pipe: an answer is at most 64 KiB of SDP, escaped.
constexpr std::size_t max_control_line = 262144;

enum class FrameKind : std::uint8_t {
    VideoBuffer = 1,
    AudioBuffer = 2,
    VideoCaps = 3,
    AudioCaps = 4
};
constexpr std::uint8_t flag_delta = 1;

struct FrameHeader {
    FrameKind kind = FrameKind::VideoBuffer;
    std::uint8_t flags = 0;
    std::uint32_t length = 0;
    std::uint64_t duration = 0; // nanoseconds, 0 when unknown
};

inline void put32(unsigned char *out, std::uint32_t value) {
    for (int i = 0; i < 4; ++i)
        out[i] = static_cast<unsigned char>(value >> (8 * i));
}
inline void put64(unsigned char *out, std::uint64_t value) {
    for (int i = 0; i < 8; ++i)
        out[i] = static_cast<unsigned char>(value >> (8 * i));
}
inline std::uint32_t get32(const unsigned char *in) {
    std::uint32_t value = 0;
    for (int i = 3; i >= 0; --i)
        value = (value << 8) | in[i];
    return value;
}
inline std::uint64_t get64(const unsigned char *in) {
    std::uint64_t value = 0;
    for (int i = 7; i >= 0; --i)
        value = (value << 8) | in[i];
    return value;
}

inline bool is_caps(FrameKind kind) {
    return kind == FrameKind::VideoCaps || kind == FrameKind::AudioCaps;
}

// Header bytes followed by the payload, ready to write.
inline std::string encode_frame(const FrameHeader &header, const void *payload) {
    std::string record(frame_header_size + header.length, '\0');
    auto out = reinterpret_cast<unsigned char *>(record.data());
    put32(out, frame_magic);
    out[4] = static_cast<unsigned char>(header.kind);
    out[5] = header.flags;
    put32(out + 8, header.length);
    put64(out + 16, header.duration);
    if (header.length)
        std::memcpy(out + frame_header_size, payload, header.length);
    return record;
}

// nullopt for anything that is not a well-formed header: the reader then ends the stream.
inline std::optional<FrameHeader> decode_frame_header(const unsigned char *in) {
    if (get32(in) != frame_magic || in[6] != 0 || in[7] != 0 || get32(in + 12) != 0 ||
        get64(in + 24) != 0)
        return std::nullopt;
    const auto kind = in[4];
    if (kind < 1 || kind > 4 || (in[5] & ~flag_delta) != 0)
        return std::nullopt;
    FrameHeader header;
    header.kind = static_cast<FrameKind>(kind);
    header.flags = in[5];
    header.length = get32(in + 8);
    header.duration = get64(in + 16);
    const auto limit = is_caps(header.kind) ? max_caps_bytes : max_frame_bytes;
    if (header.length > limit || (is_caps(header.kind) && header.flags))
        return std::nullopt;
    return header;
}

// Peer ids are the server's stream ids: 1-64 characters of letters, digits and '-'.
inline bool valid_peer_id(std::string_view id) {
    if (id.empty() || id.size() > max_peer_id)
        return false;
    for (const char c : id)
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '-'))
            return false;
    return true;
}

inline std::string encode_input(std::string_view peer, std::string_view text) {
    std::string record(4, '\0');
    record[0] = static_cast<char>(peer.size() & 0xff);
    record[1] = static_cast<char>(peer.size() >> 8);
    record[2] = static_cast<char>(text.size() & 0xff);
    record[3] = static_cast<char>(text.size() >> 8);
    record.append(peer);
    record.append(text);
    return record;
}

struct InputSizes {
    std::size_t peer = 0, text = 0;
};
inline std::optional<InputSizes> decode_input_header(const unsigned char *in) {
    InputSizes sizes{static_cast<std::size_t>(in[0] | (in[1] << 8)),
                     static_cast<std::size_t>(in[2] | (in[3] << 8))};
    if (sizes.peer == 0 || sizes.peer > max_peer_id || sizes.text == 0 ||
        sizes.text > max_input_text)
        return std::nullopt;
    return sizes;
}

} // namespace net_records
