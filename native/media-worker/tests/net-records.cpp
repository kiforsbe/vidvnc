#include <cassert>
#include <string>
#include "../src/net-records.hpp"
using namespace net_records;
static const unsigned char *bytes(const std::string &text) {
    return reinterpret_cast<const unsigned char *>(text.data());
}
int main() {
    // A frame round-trips, and its header is exactly 32 bytes.
    const std::string payload = "\x00\x00\x00\x01\x67payload";
    FrameHeader header{FrameKind::VideoBuffer, flag_delta,
                       static_cast<std::uint32_t>(payload.size()), 33333333};
    const auto record = encode_frame(header, payload.data());
    assert(record.size() == frame_header_size + payload.size());
    const auto decoded = decode_frame_header(bytes(record));
    assert(decoded && decoded->kind == FrameKind::VideoBuffer && decoded->flags == flag_delta);
    assert(decoded->length == payload.size() && decoded->duration == 33333333);
    assert(record.substr(frame_header_size) == payload);

    // Anything else in a header ends the stream.
    for (std::size_t i = 0; i < frame_header_size; ++i) {
        if (i >= 16 && i < 24)
            continue; // the duration is free-form
        if (i >= 8 && i < 12)
            continue; // length checked below
        auto broken = record;
        broken[i] = static_cast<char>(broken[i] ^ 0x40);
        assert(!decode_frame_header(bytes(broken)));
    }
    // A length over the limit, written straight into an otherwise valid header.
    auto oversized = encode_frame({FrameKind::AudioBuffer, 0, 0, 0}, nullptr);
    put32(reinterpret_cast<unsigned char *>(oversized.data()) + 8, max_frame_bytes + 1);
    assert(!decode_frame_header(bytes(oversized)));
    std::string caps = "video/x-h264,stream-format=byte-stream";
    auto caps_record = encode_frame(
        {FrameKind::VideoCaps, 0, static_cast<std::uint32_t>(caps.size()), 0}, caps.data());
    assert(decode_frame_header(bytes(caps_record))->kind == FrameKind::VideoCaps);
    caps_record[5] = flag_delta; // caps carry no flags
    assert(!decode_frame_header(bytes(caps_record)));
    std::string long_caps(max_caps_bytes + 1, 'x');
    assert(!decode_frame_header(bytes(
        encode_frame({FrameKind::AudioCaps, 0, static_cast<std::uint32_t>(long_caps.size()), 0},
                     long_caps.data()))));

    // Input records.
    const auto input = encode_input("stream-1", "{\"type\":\"ping\"}");
    const auto sizes = decode_input_header(bytes(input));
    assert(sizes && sizes->peer == 8 && sizes->text == 15);
    assert(input.substr(4, 8) == "stream-1" && input.substr(12) == "{\"type\":\"ping\"}");
    assert(!decode_input_header(bytes(encode_input("", "x"))));
    assert(!decode_input_header(bytes(encode_input("p", ""))));
    assert(!decode_input_header(bytes(encode_input(std::string(65, 'p'), "x"))));
    assert(!decode_input_header(bytes(encode_input("p", std::string(1025, 'x')))));

    assert(valid_peer_id("0f8b3c2e-1d4a-4b6f-9e7a-2c3d4e5f6a7b"));
    assert(!valid_peer_id("") && !valid_peer_id(std::string(65, 'a')));
    assert(!valid_peer_id("a b") && !valid_peer_id("a\"b") && !valid_peer_id("a/b"));
}
