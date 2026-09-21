#include <cassert>
#include <string>
#include "../src/video-codec.hpp"
int main() {
    const auto &table = video_codecs();
    assert(table.size() == 3);
    assert(table[0].id == "h264");
    assert(table[1].id == "h265");
    assert(table[2].id == "av1");

    // Encoder elements and their properties live in encoder-backend.hpp; a codec row describes
    // only the bitstream and how it is carried.
    const auto *h264 = find_video_codec("h264");
    assert(h264 && h264->parser == "h264parse" && h264->payloader == "rtph264pay" &&
           h264->encoding_name == "H264");
    const auto *h265 = find_video_codec("h265");
    assert(h265 && h265->parser == "h265parse config-interval=-1" &&
           h265->payloader == "rtph265pay" && h265->encoding_name == "H265");
    const auto *av1 = find_video_codec("av1");
    assert(av1 && av1->parser == "av1parse" && av1->payloader == "rtpav1pay" &&
           av1->encoding_name == "AV1");

    assert(!find_video_codec(""));
    assert(!find_video_codec("H264"));
    assert(!find_video_codec("vp9"));
}
