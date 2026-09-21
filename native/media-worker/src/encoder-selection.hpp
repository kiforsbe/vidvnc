#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "encoder-backend.hpp"

// Picks one encoder element from the candidates a machine actually offers.
//
// DXGI desktop duplication captures on whichever GPU drives the monitor, which on a hybrid
// machine is usually the integrated one. Preferring an encoder on that same adapter avoids
// copying every frame across adapters, so affinity comes first and the vendor order only
// breaks ties. Building the candidate list is the worker's job; this is pure so it can be
// tested without a GPU.

struct EncoderCandidate {
    std::string backend_id;
    std::string element_name;
    bool has_adapter; // False when the element declares no `adapter-luid`.
    std::int64_t adapter_luid;
};

enum class SelectionReason {
    AdapterMatch,      // Chosen because it sits on the capture adapter.
    FixedOrder,        // Chosen by the backend order in `encoder_backends()`.
    Forced,            // Chosen because the host set `encoderBackend`.
    ForcedUnavailable, // The host's choice is absent; this is the automatic pick instead.
};

struct Selection {
    bool found;
    EncoderCandidate candidate;
    SelectionReason reason;
};

namespace encoder_selection_detail {

// Lower sorts better. Rank first, then position in the fixed backend order.
inline int rank(const EncoderCandidate &candidate, bool capture_known, std::int64_t capture_luid) {
    if (!candidate.has_adapter)
        return 2;
    if (capture_known && candidate.adapter_luid == capture_luid)
        return 0;
    return 1;
}

inline size_t order(const std::string &backend_id) {
    const auto &table = encoder_backends();
    for (size_t index = 0; index < table.size(); ++index)
        if (table[index].id == backend_id)
            return index;
    return table.size();
}

} // namespace encoder_selection_detail

inline Selection select_encoder(const std::vector<EncoderCandidate> &candidates,
                                bool capture_adapter_known, std::int64_t capture_adapter_luid,
                                const std::string &forced_backend_id) {
    const bool forced = !forced_backend_id.empty() && forced_backend_id != "auto";
    if (forced)
        for (const auto &candidate : candidates)
            if (candidate.backend_id == forced_backend_id)
                return {true, candidate, SelectionReason::Forced};

    const EncoderCandidate *best = nullptr;
    int best_rank = 0;
    size_t best_order = 0;
    for (const auto &candidate : candidates) {
        const int candidate_rank =
            encoder_selection_detail::rank(candidate, capture_adapter_known, capture_adapter_luid);
        const size_t candidate_order = encoder_selection_detail::order(candidate.backend_id);
        if (best && !(candidate_rank < best_rank ||
                      (candidate_rank == best_rank && candidate_order < best_order)))
            continue;
        best = &candidate;
        best_rank = candidate_rank;
        best_order = candidate_order;
    }
    if (!best)
        return {false, {}, SelectionReason::FixedOrder};
    // A forced backend that is not installed must not refuse the stream: a configuration file
    // follows its machine, and the hardware it names may simply not be here.
    const auto reason = forced           ? SelectionReason::ForcedUnavailable
                        : best_rank == 0 ? SelectionReason::AdapterMatch
                                         : SelectionReason::FixedOrder;
    return {true, *best, reason};
}
