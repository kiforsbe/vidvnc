#pragma once
#include <mutex>
#include <map>

// Probes only inspect metadata. No video copies, per-frame logging or disk IO.
struct MediaTelemetry {
    std::mutex mutex;
    guint64 captured = 0, submitted = 0, encoded = 0, bytes = 0;
    guint64 lastCaptured = 0, lastEncoded = 0, lastBytes = 0, maxBytes = 0;
    gint64 started = g_get_monotonic_time(), sampled = started, lastCapture = 0, maxGap = 0;
    double encodeSum = 0, encodeMax = 0;
    guint64 encodeSamples = 0, qosEvents = 0;
    std::map<GstClockTime, gint64> pending;
    std::map<std::string, guint64> qosDrops;
    void attach(GstElement *pipeline) {
        for (auto spec : {std::make_pair("capture", "src"), std::make_pair("encoder", "sink"),
                          std::make_pair("encoder", "src")}) {
            auto element = gst_bin_get_by_name(GST_BIN(pipeline), spec.first);
            auto pad = gst_element_get_static_pad(element, spec.second);
            gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, probe, this, nullptr);
            gst_object_unref(pad);
            gst_object_unref(element);
        }
    }
    static GstPadProbeReturn probe(GstPad *pad, GstPadProbeInfo *info, gpointer data) {
        auto &self = *static_cast<MediaTelemetry *>(data);
        auto buffer = GST_PAD_PROBE_INFO_BUFFER(info);
        auto parent = gst_pad_get_parent_element(pad);
        const bool capture = g_strcmp0(GST_OBJECT_NAME(parent), "capture") == 0;
        gst_object_unref(parent);
        const auto now = g_get_monotonic_time();
        std::lock_guard<std::mutex> lock(self.mutex);
        if (capture) {
            ++self.captured;
            if (self.lastCapture)
                self.maxGap = std::max(self.maxGap, now - self.lastCapture);
            self.lastCapture = now;
        } else if (GST_PAD_DIRECTION(pad) == GST_PAD_SINK) {
            ++self.submitted;
            if (GST_BUFFER_PTS_IS_VALID(buffer)) {
                if (self.pending.size() >= 256)
                    self.pending.erase(self.pending.begin());
                self.pending[GST_BUFFER_PTS(buffer)] = now;
            }
        } else {
            ++self.encoded;
            const auto size = static_cast<guint64>(gst_buffer_get_size(buffer));
            self.bytes += size;
            self.maxBytes = std::max(self.maxBytes, size);
            auto found = self.pending.find(GST_BUFFER_PTS(buffer));
            if (found != self.pending.end()) {
                double ms = (now - found->second) / 1000.0;
                self.encodeSum += ms;
                self.encodeMax = std::max(self.encodeMax, ms);
                ++self.encodeSamples;
                self.pending.erase(found);
            }
        }
        return GST_PAD_PROBE_OK;
    }
    void qos(GstMessage *message) {
        GstFormat format;
        guint64 processed, dropped;
        gst_message_parse_qos_stats(message, &format, &processed, &dropped);
        std::lock_guard<std::mutex> lock(mutex);
        ++qosEvents;
        if (format == GST_FORMAT_BUFFERS && dropped != G_MAXUINT64 && qosDrops.size() < 64)
            qosDrops[GST_OBJECT_NAME(GST_MESSAGE_SRC(message))] = dropped;
    }
    JsonObject *snapshot() {
        std::lock_guard<std::mutex> lock(mutex);
        auto result = json_object_new();
        auto now = g_get_monotonic_time();
        double seconds = std::max(0.000001, (now - sampled) / 1000000.0);
        auto number = [&](const char *name, double value) {
            json_object_set_double_member(result, name, value);
        };
        number("elapsedMs", (now - started) / 1000.0);
        number("captureFrames", static_cast<double>(captured));
        number("encoderInputFrames", static_cast<double>(submitted));
        number("encodedFrames", static_cast<double>(encoded));
        number("encodedBytes", static_cast<double>(bytes));
        number("captureFps", (captured - lastCaptured) / seconds);
        number("encodeFps", (encoded - lastEncoded) / seconds);
        number("encodedMbps", (bytes - lastBytes) * 8.0 / seconds / 1000000.0);
        number("maxFrameBytes", static_cast<double>(maxBytes));
        number("captureGapMaxMs", maxGap / 1000.0);
        number("pendingFrames", static_cast<double>(pending.size()));
        number("qosEvents", static_cast<double>(qosEvents));
        if (encodeSamples) {
            number("encodeMeanMs", encodeSum / encodeSamples);
            number("encodeMaxMs", encodeMax);
        } else {
            json_object_set_null_member(result, "encodeMeanMs");
            json_object_set_null_member(result, "encodeMaxMs");
        }
        // QoS counts belong to individual elements, not an end-to-end total.
        if (qosDrops.empty())
            json_object_set_null_member(result, "qosDroppedMax");
        else {
            guint64 largest = 0;
            for (const auto &pair : qosDrops)
                largest = std::max(largest, pair.second);
            number("qosDroppedMax", static_cast<double>(largest));
        }
        sampled = now;
        lastCaptured = captured;
        lastEncoded = encoded;
        lastBytes = bytes;
        maxBytes = 0;
        maxGap = 0;
        encodeSum = 0;
        encodeMax = 0;
        encodeSamples = 0;
        return result;
    }
};
