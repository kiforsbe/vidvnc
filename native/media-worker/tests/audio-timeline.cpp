#include <cassert>
#include "../src/audio-timeline.hpp"

int main() {
    constexpr std::int64_t ms = 1000000;
    // 480-sample chunks (10 ms) read in bursts: three at once, then a gap. Timestamps follow
    // the samples, not the reads.
    AudioTimeline timeline;
    const auto first = timeline.next(1000 * ms, 480);
    assert(first.pts_ns == 990 * ms && first.duration_ns == 10 * ms && !first.discont);
    const auto second = timeline.next(1001 * ms, 480);
    const auto third = timeline.next(1001 * ms, 480);
    assert(second.pts_ns == 1000 * ms && !second.discont);
    assert(third.pts_ns == 1010 * ms && !third.discont);
    const auto fourth = timeline.next(1030 * ms, 480);
    assert(fourth.pts_ns == 1020 * ms && !fourth.discont);

    // Odd chunk lengths add up exactly: 1000 chunks of 441 samples are 9.1875 s.
    AudioTimeline exact;
    std::int64_t last = 0;
    for (int i = 0; i < 1000; ++i)
        last = exact.next(10000 * ms + i * 9 * ms, 441).pts_ns;
    assert(exact.next(19000 * ms, 441).pts_ns - last == 9187500);

    // A pause in capture longer than the drift allowance starts the timeline again from the
    // clock, marked as a discontinuity.
    const auto resumed = timeline.next(5000 * ms, 480);
    assert(resumed.discont && resumed.pts_ns == 4990 * ms);
    const auto after = timeline.next(5000 * ms, 480);
    assert(!after.discont && after.pts_ns == 5000 * ms);

    // After reset (a restart), the first chunk starts again without a discontinuity.
    timeline.reset();
    assert(!timeline.next(100 * ms, 480).discont);

    // Opus packets by duration: 20 ms each, arriving 3 ms early and 4 ms late, keep a steady
    // 20 ms spacing (960 samples at 48 kHz).
    AudioTimeline opus;
    const auto a = opus.next_duration(2000 * ms, 20 * ms);
    const auto b = opus.next_duration(2017 * ms, 20 * ms);
    const auto c = opus.next_duration(2044 * ms, 20 * ms);
    assert(b.pts_ns - a.pts_ns == 20 * ms && c.pts_ns - b.pts_ns == 20 * ms);
    assert(!b.discont && !c.discont);
    return 0;
}
