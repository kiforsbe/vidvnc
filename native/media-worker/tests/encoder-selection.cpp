#include <cassert>
#include <string>
#include <vector>
#include "../src/encoder-selection.hpp"

static const std::int64_t capture = 111;
static const std::int64_t other = 222;

static EncoderCandidate on(const std::string &backend, const std::string &element,
                           std::int64_t luid) {
    return {backend, element, true, luid};
}
static EncoderCandidate agnostic(const std::string &backend, const std::string &element) {
    return {backend, element, false, 0};
}

int main() {
    // Sitting on the capture adapter beats sorting earlier in the fixed order. This is the
    // whole point of adapter affinity: the encoder that already owns the texture wins.
    {
        const std::vector<EncoderCandidate> candidates{on("nvenc", "nvd3d11h264enc", other),
                                                       on("amf", "amfh264enc", capture)};
        const auto choice = select_encoder(candidates, true, capture, "auto");
        assert(choice.found);
        assert(choice.candidate.backend_id == "amf");
        assert(choice.reason == SelectionReason::AdapterMatch);
    }

    // Within a rank the fixed order decides.
    {
        const std::vector<EncoderCandidate> candidates{on("qsv", "qsvh264enc", capture),
                                                       on("nvenc", "nvd3d11h264enc", capture)};
        const auto choice = select_encoder(candidates, true, capture, "auto");
        assert(choice.candidate.backend_id == "nvenc");
        assert(choice.reason == SelectionReason::AdapterMatch);
    }

    // An element that cannot say which adapter it is on ranks below one that can, even when
    // that one is on the wrong adapter, because nothing can be reasoned about it.
    {
        const std::vector<EncoderCandidate> candidates{agnostic("mediafoundation", "mfh264enc"),
                                                       on("amf", "amfh264enc", other)};
        const auto choice = select_encoder(candidates, true, capture, "auto");
        assert(choice.candidate.backend_id == "amf");
        assert(choice.reason == SelectionReason::FixedOrder);
    }

    // With no capture adapter known, every candidate is equal and the fixed order alone decides.
    {
        const std::vector<EncoderCandidate> candidates{on("amf", "amfh264enc", capture),
                                                       on("nvenc", "nvd3d11h264enc", other)};
        const auto choice = select_encoder(candidates, false, 0, "auto");
        assert(choice.candidate.backend_id == "nvenc");
        assert(choice.reason == SelectionReason::FixedOrder);
    }

    // An explicit host setting overrides ranking entirely.
    {
        const std::vector<EncoderCandidate> candidates{on("nvenc", "nvd3d11h264enc", capture),
                                                       on("qsv", "qsvh264enc", other)};
        const auto choice = select_encoder(candidates, true, capture, "qsv");
        assert(choice.candidate.backend_id == "qsv");
        assert(choice.reason == SelectionReason::Forced);
    }

    // Forcing a backend this machine does not have falls back to automatic rather than
    // refusing to stream. A configuration file may have come from another machine.
    {
        const std::vector<EncoderCandidate> candidates{on("nvenc", "nvd3d11h264enc", capture),
                                                       on("amf", "amfh264enc", other)};
        const auto choice = select_encoder(candidates, true, capture, "qsv");
        assert(choice.found);
        assert(choice.candidate.backend_id == "nvenc");
        assert(choice.reason == SelectionReason::ForcedUnavailable);
    }

    // An empty candidate list is not a crash; the caller reports that nothing can encode.
    {
        const auto choice = select_encoder({}, true, capture, "auto");
        assert(!choice.found);
    }

    // An empty forced id means automatic, the same as "auto".
    {
        const std::vector<EncoderCandidate> candidates{on("amf", "amfh264enc", capture)};
        const auto choice = select_encoder(candidates, true, capture, "");
        assert(choice.found && choice.reason == SelectionReason::AdapterMatch);
    }
}
