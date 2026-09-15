#include <gst/gst.h>
#include <cassert>
#include <string>
#include "../src/sdp-payload.hpp"
static OfferPayloads payloads(const std::string &text) {
    auto sdp = parse_offer(text);
    assert(sdp);
    auto result = select_payloads(sdp);
    gst_sdp_message_free(sdp);
    return result;
}
int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    const std::string head = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const std::string video =
        head +
        "m=video 9 UDP/TLS/RTP/SAVPF 96 98 102\r\n"
        "a=rtpmap:96 VP8/90000\r\n"
        "a=rtpmap:98 H264/90000\r\n"
        "a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f\r\n"
        "a=rtpmap:102 H264/90000\r\n"
        "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n";
    assert(payloads(video).video == "102");
    assert(payloads(video).audio.empty());
    const std::string audio =
        head + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
    assert(payloads(audio).audio == "111" && payloads(audio).video.empty());
    const std::string baseline = head +
                                 "m=video 9 UDP/TLS/RTP/SAVPF 100\r\na=rtpmap:100 H264/90000\r\n"
                                 "a=fmtp:100 packetization-mode=1;profile-level-id=42001f\r\n";
    assert(payloads(baseline).video.empty());
    const std::string injected =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96!fakesink H264/90000\r\n"
               "a=fmtp:96!fakesink packetization-mode=1;profile-level-id=42e01f\r\n";
    assert(payloads(injected).video.empty());
    assert(rtpmap_payload("128 opus/48000/2").empty());
    assert(rtpmap_payload("111").empty());
    assert(rtpmap_payload(nullptr).empty());
    assert(!parse_offer("invalid"));
    assert(!parse_offer(std::string(65537, 'v')));
}
