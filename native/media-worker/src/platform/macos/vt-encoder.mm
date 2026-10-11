// vidvncvtenc: VTCompressionSession as a GStreamer video encoder (design D1). Hardware only,
// with low-latency rate control, real time and no frame reordering; key frames on the GOP and
// whenever a force-key-unit event reaches the encoder (the worker's keyframe limiter sends
// those). Each frame is encoded before the next is accepted, so an access unit leaves the
// encoder as soon as the hardware returns it.
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>
#include <gst/video/gstvideoencoder.h>
#include <gst/video/video.h>
#include <cstring>
#include <mutex>
#include <vector>
#include "../../video-codec.hpp"
#include "../platform.hpp"
#include "elements.hpp"

namespace {

CMVideoCodecType codec_type(const std::string &codec_id) {
    return codec_id == "h265" ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264;
}

// The encoded output of one frame, filled by VideoToolbox's callback.
struct Output {
    OSStatus status = noErr;
    bool produced = false, keyframe = false;
    std::vector<std::uint8_t> bytes; // Annex B
};

// VideoToolbox returns length-prefixed NAL units and keeps the parameter sets in the format
// description. The frames pipe carries Annex B, with the parameter sets in front of every key
// frame, as the Windows encoders deliver it.
bool annex_b(CMSampleBufferRef sample, bool hevc, bool keyframe, std::vector<std::uint8_t> &out) {
    static const std::uint8_t start[] = {0, 0, 0, 1};
    const auto format = CMSampleBufferGetFormatDescription(sample);
    int header = 4;
    if (keyframe) {
        size_t count = 0;
        const OSStatus counted = hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                                            format, 0, nullptr, nullptr, &count, &header)
                                      : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                                            format, 0, nullptr, nullptr, &count, &header);
        if (counted != noErr)
            return false;
        for (size_t i = 0; i < count; ++i) {
            const std::uint8_t *set = nullptr;
            size_t size = 0;
            const OSStatus got = hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                                            format, i, &set, &size, nullptr, nullptr)
                                      : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                                            format, i, &set, &size, nullptr, nullptr);
            if (got != noErr)
                return false;
            out.insert(out.end(), start, start + 4);
            out.insert(out.end(), set, set + size);
        }
    } else if (hevc) {
        CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, 0, nullptr, nullptr, nullptr,
                                                           &header);
    } else {
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nullptr, nullptr, nullptr,
                                                           &header);
    }
    if (header < 1 || header > 4)
        return false;
    const auto block = CMSampleBufferGetDataBuffer(sample);
    const size_t length = block ? CMBlockBufferGetDataLength(block) : 0;
    std::vector<std::uint8_t> data(length);
    if (!length || CMBlockBufferCopyDataBytes(block, 0, length, data.data()) != noErr)
        return false;
    for (size_t at = 0; at + header <= length;) {
        size_t size = 0;
        for (int i = 0; i < header; ++i)
            size = (size << 8) | data[at + i];
        at += header;
        if (size == 0 || size > length - at)
            return false;
        out.insert(out.end(), start, start + 4);
        out.insert(out.end(), data.begin() + at, data.begin() + at + size);
        at += size;
    }
    return true;
}

void encoded(void *refcon, void *, OSStatus status, VTEncodeInfoFlags flags,
             CMSampleBufferRef sample) {
    auto &output = *static_cast<Output *>(refcon);
    output.status = status;
    if (status != noErr || !sample || (flags & kVTEncodeInfo_FrameDropped))
        return;
    bool keyframe = true;
    if (auto attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false))
        if (CFArrayGetCount(attachments) > 0) {
            auto first = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
            keyframe = !CFDictionaryContainsKey(first, kCMSampleAttachmentKey_NotSync);
        }
    const bool hevc = CMFormatDescriptionGetMediaSubType(
                          CMSampleBufferGetFormatDescription(sample)) == kCMVideoCodecType_HEVC;
    output.bytes.clear();
    if (!annex_b(sample, hevc, keyframe, output.bytes)) {
        output.status = kVTVideoEncoderMalfunctionErr;
        return;
    }
    output.produced = true;
    output.keyframe = keyframe;
}

std::string status_text(const char *what, OSStatus status) {
    return std::string(what) + " failed (VideoToolbox status " + std::to_string(status) + ")";
}

// One session, configured as design D1 says. Returns null with `error` set.
VTCompressionSessionRef open_session(const std::string &codec_id, int width, int height,
                                     const VtRateSettings &settings, Output *output,
                                     std::string &error) {
    NSDictionary *specification = @{
        (id)kVTVideoEncoderSpecification_EnableLowLatencyRateControl : @YES,
        (id)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder : @YES,
    };
    VTCompressionSessionRef session = nullptr;
    OSStatus status = VTCompressionSessionCreate(nullptr, width, height, codec_type(codec_id),
                                                 (__bridge CFDictionaryRef)specification, nullptr,
                                                 nullptr, encoded, output, &session);
    if (status != noErr || !session) {
        error = status_text("Opening a hardware encoder", status);
        return nullptr;
    }
    const bool hevc = codec_id == "h265";
    struct Property {
        CFStringRef key;
        id value;
    };
    std::vector<Property> properties{
        {kVTCompressionPropertyKey_RealTime, @YES},
        {kVTCompressionPropertyKey_AllowFrameReordering, @NO},
        {kVTCompressionPropertyKey_ProfileLevel,
         (__bridge id)(hevc ? kVTProfileLevel_HEVC_Main_AutoLevel
                            : kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)},
        {kVTCompressionPropertyKey_AverageBitRate, @(settings.average_bits_per_second)},
        {kVTCompressionPropertyKey_DataRateLimits,
         @[ @(settings.limit_bytes), @(settings.limit_seconds) ]},
        {kVTCompressionPropertyKey_MaxKeyFrameInterval, @(settings.max_keyframe_interval)},
        {kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
         @(settings.max_keyframe_interval_seconds)},
        {kVTCompressionPropertyKey_ExpectedFrameRate, @(settings.expected_fps)},
    };
    if (settings.min_qp >= 0)
        properties.push_back({ kVTCompressionPropertyKey_MinAllowedFrameQP, @(settings.min_qp) });
    for (const auto &property : properties) {
        status = VTSessionSetProperty(session, property.key, (__bridge CFTypeRef)property.value);
        if (status != noErr) {
            // Every property here was measured as supported; one that is refused means the
            // session would not be the low-latency encoder the design asks for.
            error = status_text(
                ("Setting " + std::string([(__bridge NSString *)property.key UTF8String])).c_str(),
                status);
            VTCompressionSessionInvalidate(session);
            CFRelease(session);
            return nullptr;
        }
    }
    VTCompressionSessionPrepareToEncodeFrames(session);
    return session;
}

// Encodes one frame and waits for it. Returns false with `error` set on an encoder failure; a
// frame the encoder chose to drop is not a failure (output->produced stays false).
bool encode_one(VTCompressionSessionRef session, Output &output, CVPixelBufferRef pixels,
                CMTime pts, CMTime duration, bool force_keyframe, std::string &error) {
    output = Output{};
    NSDictionary *options = force_keyframe
                                ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame : @YES}
                                : nil;
    OSStatus status = VTCompressionSessionEncodeFrame(
        session, pixels, pts, duration, (__bridge CFDictionaryRef)options, nullptr, nullptr);
    if (status == noErr)
        status = VTCompressionSessionCompleteFrames(session, pts);
    if (status == noErr)
        status = output.status;
    if (status != noErr) {
        error = status_text("Encoding a frame", status);
        return false;
    }
    return true;
}

} // namespace

// ---- The element.

struct VidVncVtEncState {
    std::string codec = "h264";
    VtRateSettings settings{6000000, 750000, 1.0, 30, 1.0, -1, 30};
    VTCompressionSessionRef session = nullptr;
    Output output;
    GstVideoCodecState *input = nullptr;
    GstClockTime frame_duration = GST_SECOND / 30;
    void close() {
        if (session) {
            VTCompressionSessionInvalidate(session);
            CFRelease(session);
            session = nullptr;
        }
        if (input) {
            gst_video_codec_state_unref(input);
            input = nullptr;
        }
    }
};

struct VidVncVtEnc {
    GstVideoEncoder parent;
    VidVncVtEncState *state;
};
struct VidVncVtEncClass {
    GstVideoEncoderClass parent_class;
};

G_DEFINE_TYPE(VidVncVtEnc, vidvnc_vt_enc, GST_TYPE_VIDEO_ENCODER)

enum {
    PROP_0,
    PROP_CODEC,
    PROP_AVERAGE_BITRATE,
    PROP_LIMIT_BYTES,
    PROP_LIMIT_SECONDS,
    PROP_KEYFRAME_INTERVAL,
    PROP_KEYFRAME_SECONDS,
    PROP_MIN_QP,
    PROP_EXPECTED_FPS,
};

static VidVncVtEncState &state_of(gpointer self) {
    return *reinterpret_cast<VidVncVtEnc *>(self)->state;
}

static void vt_set_property(GObject *object, guint id, const GValue *value, GParamSpec *spec) {
    auto &state = state_of(object);
    switch (id) {
    case PROP_CODEC:
        state.codec = g_value_get_string(value) ? g_value_get_string(value) : "h264";
        break;
    case PROP_AVERAGE_BITRATE:
        state.settings.average_bits_per_second = static_cast<long>(g_value_get_int64(value));
        break;
    case PROP_LIMIT_BYTES:
        state.settings.limit_bytes = static_cast<long>(g_value_get_int64(value));
        break;
    case PROP_LIMIT_SECONDS:
        state.settings.limit_seconds = g_value_get_double(value);
        break;
    case PROP_KEYFRAME_INTERVAL:
        state.settings.max_keyframe_interval = g_value_get_int(value);
        break;
    case PROP_KEYFRAME_SECONDS:
        state.settings.max_keyframe_interval_seconds = g_value_get_double(value);
        break;
    case PROP_MIN_QP:
        state.settings.min_qp = g_value_get_int(value);
        break;
    case PROP_EXPECTED_FPS:
        state.settings.expected_fps = g_value_get_int(value);
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
    }
}

static void vt_get_property(GObject *object, guint id, GValue *value, GParamSpec *spec) {
    auto &state = state_of(object);
    switch (id) {
    case PROP_CODEC:
        g_value_set_string(value, state.codec.c_str());
        break;
    case PROP_AVERAGE_BITRATE:
        g_value_set_int64(value, state.settings.average_bits_per_second);
        break;
    case PROP_LIMIT_BYTES:
        g_value_set_int64(value, state.settings.limit_bytes);
        break;
    case PROP_LIMIT_SECONDS:
        g_value_set_double(value, state.settings.limit_seconds);
        break;
    case PROP_KEYFRAME_INTERVAL:
        g_value_set_int(value, state.settings.max_keyframe_interval);
        break;
    case PROP_KEYFRAME_SECONDS:
        g_value_set_double(value, state.settings.max_keyframe_interval_seconds);
        break;
    case PROP_MIN_QP:
        g_value_set_int(value, state.settings.min_qp);
        break;
    case PROP_EXPECTED_FPS:
        g_value_set_int(value, state.settings.expected_fps);
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
    }
}

static void vt_finalize(GObject *object) {
    auto *self = reinterpret_cast<VidVncVtEnc *>(object);
    self->state->close();
    delete self->state;
    G_OBJECT_CLASS(vidvnc_vt_enc_parent_class)->finalize(object);
}

static gboolean vt_stop(GstVideoEncoder *encoder) {
    state_of(encoder).close();
    return TRUE;
}

static gboolean vt_set_format(GstVideoEncoder *encoder, GstVideoCodecState *input) {
    auto &state = state_of(encoder);
    state.close();
    const auto *codec = find_video_codec(state.codec);
    if (!codec || codec->id == "av1") {
        GST_ELEMENT_ERROR(encoder, LIBRARY, SETTINGS,
                          ("VideoToolbox has no %s encoder.", state.codec.c_str()), (nullptr));
        return FALSE;
    }
    const int width = GST_VIDEO_INFO_WIDTH(&input->info);
    const int height = GST_VIDEO_INFO_HEIGHT(&input->info);
    const int fps_n = GST_VIDEO_INFO_FPS_N(&input->info),
              fps_d = GST_VIDEO_INFO_FPS_D(&input->info);
    state.frame_duration =
        fps_n > 0 ? gst_util_uint64_scale(GST_SECOND, fps_d, fps_n) : GST_SECOND / 30;
    std::string error;
    state.session = open_session(state.codec, width, height, state.settings, &state.output, error);
    if (!state.session) {
        GST_ELEMENT_ERROR(encoder, LIBRARY, INIT, ("%s", error.c_str()), (nullptr));
        return FALSE;
    }
    state.input = gst_video_codec_state_ref(input);
    auto caps = gst_caps_from_string(codec->caps.c_str());
    auto output = gst_video_encoder_set_output_state(encoder, caps, input);
    gst_video_codec_state_unref(output);
    return gst_video_encoder_negotiate(encoder);
}

static GstFlowReturn vt_handle_frame(GstVideoEncoder *encoder, GstVideoCodecFrame *frame) {
    auto &state = state_of(encoder);
    const auto pixels = macos::frame_pixels(frame->input_buffer);
    if (!state.session || !pixels) {
        gst_video_codec_frame_unref(frame);
        GST_ELEMENT_ERROR(encoder, STREAM, FORMAT, ("No captured frame to encode."), (nullptr));
        return GST_FLOW_ERROR;
    }
    const GstClockTime pts = GST_CLOCK_TIME_IS_VALID(frame->pts)
                                 ? frame->pts
                                 : frame->system_frame_number * state.frame_duration;
    const GstClockTime duration =
        GST_CLOCK_TIME_IS_VALID(frame->duration) ? frame->duration : state.frame_duration;
    std::string error;
    if (!encode_one(state.session, state.output, pixels, CMTimeMake(pts, GST_SECOND),
                    CMTimeMake(duration, GST_SECOND),
                    GST_VIDEO_CODEC_FRAME_IS_FORCE_KEYFRAME(frame), error)) {
        gst_video_codec_frame_unref(frame);
        GST_ELEMENT_ERROR(encoder, STREAM, ENCODE, ("%s", error.c_str()), (nullptr));
        return GST_FLOW_ERROR;
    }
    if (!state.output.produced) {
        // Dropped by rate control: finishing with no output drops it downstream too.
        return gst_video_encoder_finish_frame(encoder, frame);
    }
    frame->output_buffer =
        gst_buffer_new_memdup(state.output.bytes.data(), state.output.bytes.size());
    if (state.output.keyframe)
        GST_VIDEO_CODEC_FRAME_SET_SYNC_POINT(frame);
    else
        GST_VIDEO_CODEC_FRAME_UNSET_SYNC_POINT(frame);
    return gst_video_encoder_finish_frame(encoder, frame);
}

static GstStaticPadTemplate vt_sink_template = GST_STATIC_PAD_TEMPLATE(
    "sink", GST_PAD_SINK, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("video/x-raw(memory:CVPixelBuffer), format=NV12, width=[64, 4096], "
                    "height=[64, 4096], framerate=[1/1, 60/1]"));
static GstStaticPadTemplate vt_src_template = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("video/x-h264, profile=constrained-baseline, stream-format=byte-stream, "
                    "alignment=au; video/x-h265, profile=main, stream-format=byte-stream, "
                    "alignment=au"));

static void vidvnc_vt_enc_class_init(VidVncVtEncClass *klass) {
    auto *object = G_OBJECT_CLASS(klass);
    auto *element = GST_ELEMENT_CLASS(klass);
    auto *encoder = GST_VIDEO_ENCODER_CLASS(klass);
    object->set_property = vt_set_property;
    object->get_property = vt_get_property;
    object->finalize = vt_finalize;
    const auto flags = static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(
        object, PROP_CODEC, g_param_spec_string("codec", "Codec", "h264 or h265", "h264", flags));
    g_object_class_install_property(object, PROP_AVERAGE_BITRATE,
                                    g_param_spec_int64("average-bitrate", "Average bitrate",
                                                       "AverageBitRate, bit/s", 1, G_MAXINT64,
                                                       6000000, flags));
    g_object_class_install_property(object, PROP_LIMIT_BYTES,
                                    g_param_spec_int64("limit-bytes", "Limit bytes",
                                                       "DataRateLimits: bytes", 1, G_MAXINT64,
                                                       750000, flags));
    g_object_class_install_property(object, PROP_LIMIT_SECONDS,
                                    g_param_spec_double("limit-seconds", "Limit seconds",
                                                        "DataRateLimits: seconds", 0.001, 60.0, 1.0,
                                                        flags));
    g_object_class_install_property(object, PROP_KEYFRAME_INTERVAL,
                                    g_param_spec_int("keyframe-interval", "Key frame interval",
                                                     "MaxKeyFrameInterval, frames", 1, G_MAXINT, 30,
                                                     flags));
    g_object_class_install_property(
        object, PROP_KEYFRAME_SECONDS,
        g_param_spec_double("keyframe-seconds", "Key frame interval duration",
                            "MaxKeyFrameIntervalDuration, seconds", 0.0, 3600.0, 1.0, flags));
    g_object_class_install_property(object, PROP_MIN_QP,
                                    g_param_spec_int("min-qp", "Minimum QP",
                                                     "MinAllowedFrameQP, or -1 for none", -1,
                                                     vt_qp_maximum, -1, flags));
    g_object_class_install_property(object, PROP_EXPECTED_FPS,
                                    g_param_spec_int("expected-fps", "Expected frame rate",
                                                     "ExpectedFrameRate", 1, 240, 30, flags));
    gst_element_class_add_static_pad_template(element, &vt_sink_template);
    gst_element_class_add_static_pad_template(element, &vt_src_template);
    gst_element_class_set_static_metadata(
        element, "VidVNC VideoToolbox encoder", "Codec/Encoder/Video/Hardware",
        "Low-latency hardware H.264 and HEVC with VideoToolbox", "VidVNC");
    encoder->stop = vt_stop;
    encoder->set_format = vt_set_format;
    encoder->handle_frame = vt_handle_frame;
}

static void vidvnc_vt_enc_init(VidVncVtEnc *self) { self->state = new VidVncVtEncState; }

namespace macos {

GType vt_encoder_type() { return vidvnc_vt_enc_get_type(); }

bool hardware_encoder_listed(const std::string &codec_id) {
    if (codec_id != "h264" && codec_id != "h265")
        return false;
    CFArrayRef list = nullptr;
    if (VTCopyVideoEncoderList(nullptr, &list) != noErr || !list)
        return false;
    bool found = false;
    for (NSDictionary *entry in (__bridge NSArray *)list) {
        NSNumber *type = entry[(id)kVTVideoEncoderList_CodecType];
        NSNumber *hardware = entry[(id)kVTVideoEncoderList_IsHardwareAccelerated];
        if (type.unsignedIntValue == codec_type(codec_id) && hardware.boolValue)
            found = true;
    }
    CFRelease(list);
    return found;
}

bool encoder_self_test(const std::string &codec_id, int width, int height,
                       const VtRateSettings &settings, int frames, std::string &error) {
    Output output;
    auto session = open_session(codec_id, width, height, settings, &output, error);
    if (!session)
        return false;
    NSDictionary *attributes = @{(id)kCVPixelBufferIOSurfacePropertiesKey : @{}};
    CVPixelBufferRef pixels = nullptr;
    bool ok =
        CVPixelBufferCreate(nullptr, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                            (__bridge CFDictionaryRef)attributes, &pixels) == kCVReturnSuccess;
    if (!ok)
        error = "Unable to create a test frame";
    int produced = 0;
    for (int i = 0; ok && i < frames; ++i) {
        // A moving bar, so rate control sees changing content.
        CVPixelBufferLockBaseAddress(pixels, 0);
        for (size_t plane = 0; plane < 2; ++plane) {
            auto *base =
                static_cast<std::uint8_t *>(CVPixelBufferGetBaseAddressOfPlane(pixels, plane));
            const size_t stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, plane);
            const size_t rows = CVPixelBufferGetHeightOfPlane(pixels, plane);
            for (size_t row = 0; row < rows; ++row)
                std::memset(base + row * stride, plane ? 128 : ((row + i * 8) % 64 < 32 ? 40 : 200),
                            stride);
        }
        CVPixelBufferUnlockBaseAddress(pixels, 0);
        ok = encode_one(session, output, pixels, CMTimeMake(i, settings.expected_fps),
                        CMTimeMake(1, settings.expected_fps), i == 0, error);
        if (ok && output.produced && !output.bytes.empty())
            ++produced;
    }
    if (ok && produced != frames) {
        error = std::to_string(produced) + " of " + std::to_string(frames) + " frames encoded";
        ok = false;
    }
    if (pixels)
        CVPixelBufferRelease(pixels);
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    return ok;
}

} // namespace macos
