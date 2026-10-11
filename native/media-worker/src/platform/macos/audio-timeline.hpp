#pragma once
// Timestamps for vidvncaudiosrc. ScreenCaptureKit hands over system audio in bursts of a few
// chunks at irregular times, so stamping each chunk with the time it is read (basesrc's
// do-timestamp) gives a jittery, overlapping timeline, which the Opus encoder and the
// receiver's jitter buffer turn into crackles. Instead each chunk follows on from the last by
// its own length in samples, and the timeline is set again from the clock only when it has
// drifted further than a burst can explain (a pause in capture, dropped chunks), with the
// chunk marked as a discontinuity. Free of GStreamer headers so it is tested alone.
#include <cstdint>

class AudioTimeline {
  public:
    // `drift_ns`: how far the sample-count timeline may run from the clock before it is
    // set again.
    explicit AudioTimeline(std::int64_t rate = 48000, std::int64_t drift_ns = 200000000)
        : rate_(rate), drift_ns_(drift_ns) {}

    struct Stamp {
        std::int64_t pts_ns;
        std::int64_t duration_ns;
        bool discont;
    };

    // `now_ns`: the running time when the chunk of `frames` samples was read.
    Stamp next(std::int64_t now_ns, std::int64_t frames) {
        const auto duration = frames * 1000000000 / rate_;
        bool discont = false;
        if (!started_ || next_ns_ - now_ns > drift_ns_ || now_ns - next_ns_ > drift_ns_) {
            // The chunk ended about now, so it started one chunk length ago.
            next_ns_ = now_ns > duration ? now_ns - duration : 0;
            discont = started_;
            started_ = true;
            samples_ = 0;
            origin_ns_ = next_ns_;
        }
        const Stamp stamp{next_ns_, duration, discont};
        // From the sample count, not by adding rounded durations, so it never wanders.
        samples_ += frames;
        next_ns_ = origin_ns_ + samples_ * 1000000000 / rate_;
        return stamp;
    }

    void reset() { started_ = false; }

  private:
    std::int64_t rate_;
    std::int64_t drift_ns_;
    bool started_ = false;
    std::int64_t origin_ns_ = 0;
    std::int64_t samples_ = 0;
    std::int64_t next_ns_ = 0;
};
