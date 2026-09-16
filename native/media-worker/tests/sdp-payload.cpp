#include <gst/gst.h>
#include <cassert>
#include <string>
#include "../src/sdp-payload.hpp"
static OfferPayloads payloads(const std::string &text, const VideoCodec &codec) {
    auto sdp = parse_offer(text);
    assert(sdp);
    auto result = select_payloads(sdp, codec);
    gst_sdp_message_free(sdp);
    return result;
}
int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    const auto &h264 = *find_video_codec("h264");
    const auto &h265 = *find_video_codec("h265");
    const auto &av1 = *find_video_codec("av1");
    const std::string head = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const std::string video =
        head +
        "m=video 9 UDP/TLS/RTP/SAVPF 96 98 102\r\n"
        "a=rtpmap:96 VP8/90000\r\n"
        "a=rtpmap:98 H264/90000\r\n"
        "a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f\r\n"
        "a=rtpmap:102 H264/90000\r\n"
        "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n";
    assert(payloads(video, h264).video == "102");
    assert(payloads(video, h264).audio.empty());
    const std::string audio =
        head + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
    assert(payloads(audio, h264).audio == "111" && payloads(audio, h264).video.empty());
    const std::string baseline = head +
                                 "m=video 9 UDP/TLS/RTP/SAVPF 100\r\na=rtpmap:100 H264/90000\r\n"
                                 "a=fmtp:100 packetization-mode=1;profile-level-id=42001f\r\n";
    assert(payloads(baseline, h264).video.empty());
    const std::string injected =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96!fakesink H264/90000\r\n"
               "a=fmtp:96!fakesink packetization-mode=1;profile-level-id=42e01f\r\n";
    assert(payloads(injected, h264).video.empty());
    assert(rtpmap_payload("128 opus/48000/2").empty());
    assert(rtpmap_payload("111").empty());
    assert(rtpmap_payload(nullptr).empty());
    assert(!parse_offer("invalid"));
    assert(!parse_offer(std::string(65537, 'v')));

    // A single offer covering VP8, two AV1 payloads, two H.265 payloads, H.264 and Opus.
    const std::string multi =
        head +
        "m=video 9 UDP/TLS/RTP/SAVPF 96 98 100 102 104 106\r\n"
        "a=rtpmap:96 VP8/90000\r\n"
        "a=rtpmap:98 AV1/90000\r\n"
        "a=fmtp:98 profile=0\r\n"
        "a=rtpmap:100 AV1/90000\r\n"
        "a=fmtp:100 profile=1\r\n"
        "a=rtpmap:102 H265/90000\r\n"
        "a=fmtp:102 profile-id=1\r\n"
        "a=rtpmap:104 H265/90000\r\n"
        "a=fmtp:104 profile-id=2\r\n"
        "a=rtpmap:106 H264/90000\r\n"
        "a=fmtp:106 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n"
        "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
        "a=rtpmap:111 opus/48000/2\r\n";
    assert(payloads(multi, av1).video == "98");
    assert(payloads(multi, av1).audio == "111");
    assert(payloads(multi, h265).video == "102");
    assert(payloads(multi, h265).audio == "111");
    assert(payloads(multi, h264).video == "106");
    assert(payloads(multi, h264).audio == "111");

    // No fmtp line at all -> selected.
    const std::string av1NoFmtp =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 98\r\na=rtpmap:98 AV1/90000\r\n";
    assert(payloads(av1NoFmtp, av1).video == "98");
    const std::string h265NoFmtp =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 102\r\na=rtpmap:102 H265/90000\r\n";
    assert(payloads(h265NoFmtp, h265).video == "102");

    // Only the wrong profile value present -> empty video.
    const std::string av1WrongProfile =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 100\r\na=rtpmap:100 AV1/90000\r\n"
               "a=fmtp:100 profile=1\r\n";
    assert(payloads(av1WrongProfile, av1).video.empty());
    const std::string h265WrongProfile =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 104\r\na=rtpmap:104 H265/90000\r\n"
               "a=fmtp:104 profile-id=2\r\n";
    assert(payloads(h265WrongProfile, h265).video.empty());

    // Parameter-name comparison must be exact: a differently-named key means the profile
    // key is absent, so the payload is still selected.
    const std::string av1PrefixParam =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 100\r\na=rtpmap:100 AV1/90000\r\n"
               "a=fmtp:100 profile-id=0\r\n";
    assert(payloads(av1PrefixParam, av1).video == "100");
    const std::string h265PrefixParam =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 102\r\na=rtpmap:102 H265/90000\r\n"
               "a=fmtp:102 xprofile-id=1\r\n";
    assert(payloads(h265PrefixParam, h265).video == "102");

    // An offer without the codec -> empty video.
    assert(payloads(video, av1).video.empty());
    assert(payloads(video, h265).video.empty());

    // rtpmap matching is case-insensitive: the server accepts a lowercase encoding name
    // (see apps/server/tests/video-codecs.test.mjs), so the worker must select it too.
    const std::string av1LowerCase =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 98\r\na=rtpmap:98 av1/90000\r\n";
    assert(payloads(av1LowerCase, av1).video == "98");

    // Payload-number guard.
    const std::string badPayload1 =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:1234 AV1/90000\r\n";
    assert(payloads(badPayload1, av1).video.empty());
    const std::string badPayload2 =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:9x H265/90000\r\n";
    assert(payloads(badPayload2, h265).video.empty());
}
