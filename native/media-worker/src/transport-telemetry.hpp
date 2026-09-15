#pragma once
#include <deque>
#include <mutex>
#include <algorithm>

// Metadata-only probes. ICE-input timing is NOT socket/NIC transmit timing.
struct PacketWindow {
    std::mutex mutex;
    std::deque<std::pair<gint64, gsize>> recent, shortRecent;
    guint64 sum1 = 0, sum10 = 0;
    guint64 packets = 0, bytes = 0, peak1 = 0, peak10 = 0, truncated = 0;
    void add(gsize size, gint64 now) {
        std::lock_guard<std::mutex> lock(mutex);
        ++packets;
        bytes += size;
        while (!recent.empty() && now - recent.front().first >= 10000) {
            sum10 -= recent.front().second;
            recent.pop_front();
        }
        while (!shortRecent.empty() && now - shortRecent.front().first >= 1000) {
            sum1 -= shortRecent.front().second;
            shortRecent.pop_front();
        }
        // Explicit bound even under extreme bursts; report if it affects results.
        if (recent.size() == 8192) {
            sum10 -= recent.front().second;
            recent.pop_front();
            ++truncated;
        }
        if (shortRecent.size() == 8192) {
            sum1 -= shortRecent.front().second;
            shortRecent.pop_front();
        }
        recent.emplace_back(now, size);
        shortRecent.emplace_back(now, size);
        sum1 += size;
        sum10 += size;
        peak1 = std::max(peak1, sum1);
        peak10 = std::max(peak10, sum10);
    }
    void merge(JsonObject *result, const std::string &prefix) {
        std::lock_guard<std::mutex> lock(mutex);
        for (auto field : {std::make_pair("Packets", packets),
                           {"Bytes", bytes},
                           {"Peak1msBytes", peak1},
                           {"Peak10msBytes", peak10},
                           {"WindowTruncated", truncated}})
            json_object_set_double_member(result, (prefix + field.first).c_str(),
                                          static_cast<double>(field.second));
        peak1 = peak10 = 0;
    }
    static GstPadProbeReturn probe(GstPad *, GstPadProbeInfo *info, gpointer data) {
        auto &self = *static_cast<PacketWindow *>(data);
        const auto now = g_get_monotonic_time();
        if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER) {
            self.add(gst_buffer_get_size(GST_PAD_PROBE_INFO_BUFFER(info)), now);
        } else if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
            auto list = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
            for (guint i = 0; i < gst_buffer_list_length(list); ++i)
                self.add(gst_buffer_get_size(gst_buffer_list_get(list, i)), now);
        }
        return GST_PAD_PROBE_OK;
    }
};

struct TransportTelemetry {
    PacketWindow video, ice;
    void attach_element(GstElement *element) {
        auto factory = gst_element_get_factory(element);
        const auto name = factory ? gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(factory)) : "";
        PacketWindow *window = g_strcmp0(name, "nicesink") == 0                           ? &ice
                               : g_strcmp0(GST_OBJECT_NAME(element), "video-output") == 0 ? &video
                                                                                          : nullptr;
        if (!window || g_object_get_data(G_OBJECT(element), "vidvnc-packet-probe"))
            return;
        auto pad = gst_element_get_static_pad(element, window == &ice ? "sink" : "src");
        if (!pad)
            return;
        gst_pad_add_probe(pad,
                          static_cast<GstPadProbeType>(GST_PAD_PROBE_TYPE_BUFFER |
                                                       GST_PAD_PROBE_TYPE_BUFFER_LIST),
                          PacketWindow::probe, window, nullptr);
        g_object_set_data(G_OBJECT(element), "vidvnc-packet-probe", GINT_TO_POINTER(1));
        gst_object_unref(pad);
    }
    void attach(GstElement *pipe) {
        g_signal_connect(pipe, "deep-element-added",
                         G_CALLBACK(+[](GstBin *, GstBin *, GstElement *element, gpointer data) {
                             static_cast<TransportTelemetry *>(data)->attach_element(element);
                         }),
                         this);
    }
    void merge(GstElement *pipe, JsonObject *result) {
        auto iterator = gst_bin_iterate_recurse(GST_BIN(pipe));
        GValue item = G_VALUE_INIT;
        guint64 requests = 0, retransmitted = 0, queueBytes = 0, queueNs = 0;
        guint rtxElements = 0;
        bool done = false;
        while (!done) {
            switch (gst_iterator_next(iterator, &item)) {
            case GST_ITERATOR_OK: {
                auto element = GST_ELEMENT(g_value_get_object(&item));
                attach_element(element);
                auto factory = gst_element_get_factory(element);
                const auto name =
                    factory ? gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(factory)) : "";
                if (g_strcmp0(name, "rtprtxsend") == 0) {
                    guint a = 0, b = 0;
                    g_object_get(element, "num-rtx-requests", &a, "num-rtx-packets", &b, nullptr);
                    requests += a;
                    retransmitted += b;
                    ++rtxElements;
                }
                if (g_strcmp0(name, "queue") == 0) {
                    guint bytes = 0;
                    guint64 time = 0;
                    g_object_get(element, "current-level-bytes", &bytes, "current-level-time",
                                 &time, nullptr);
                    queueBytes = std::max(queueBytes, static_cast<guint64>(bytes));
                    queueNs = std::max(queueNs, time);
                }
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC:
                gst_iterator_resync(iterator);
                requests = retransmitted = queueBytes = queueNs = 0;
                rtxElements = 0;
                break;
            default:
                done = true;
                break;
            }
        }
        if (G_VALUE_TYPE(&item))
            g_value_unset(&item);
        gst_iterator_free(iterator);
        video.merge(result, "videoRtp");
        ice.merge(result, "iceInput");
        json_object_set_int_member(result, "rtxSenders", rtxElements);
        json_object_set_double_member(result, "rtxRequests", static_cast<double>(requests));
        json_object_set_double_member(result, "rtxPackets", static_cast<double>(retransmitted));
        json_object_set_double_member(result, "queueMaxBytesSampled",
                                      static_cast<double>(queueBytes));
        json_object_set_double_member(result, "queueMaxMsSampled", queueNs / 1e6);
    }
};
