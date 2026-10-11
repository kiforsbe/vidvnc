#pragma once
// Timestamps for audio that arrives in bursts: macOS system audio in vidvncaudiosrc, and Opus
// packets reaching media-net over the frame pipe. Stamping each chunk with the time it
// arrives (appsrc's or basesrc's do-timestamp) gives a jittery, overlapping timeline; for
// Opus that becomes jittery RTP timestamps, which the viewer's jitter buffer stretches and
// conceals into crackles. Instead each chunk follows on from the last by its own length, and
// the timeline is set again from the clock only when it has drifted further than a burst can
// explain (a pause, dropped chunks), with the chunk marked as a discontinuity. Free of
// GStreamer headers so it is tested alone.
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
        return advance(now_ns, frames, frames * 1000000000 / rate_);
    }

    // The same for a chunk known by its duration, such as an encoded Opus packet.
    Stamp next_duration(std::int64_t now_ns, std::int64_t duration_ns) {
        return advance(now_ns, duration_ns * rate_ / 1000000000, duration_ns);
    }

    void reset() { started_ = false; }

  private:
    Stamp advance(std::int64_t now_ns, std::int64_t frames, std::int64_t duration) {
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

    std::int64_t rate_;
    std::int64_t drift_ns_;
    bool started_ = false;
    std::int64_t origin_ns_ = 0;
    std::int64_t samples_ = 0;
    std::int64_t next_ns_ = 0;
};
