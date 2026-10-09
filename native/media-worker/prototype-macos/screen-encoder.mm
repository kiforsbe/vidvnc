// MG2 prototype only (throwaway): ScreenCaptureKit -> VTCompressionSession -> Annex B.
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>
#include <mach/mach_time.h>
#include <algorithm>
#include <atomic>
#include <mutex>
#include <sstream>
#include <vector>
#include "screen-encoder.hpp"

namespace {

double host_ms(uint64_t mach) {
    static mach_timebase_info_data_t timebase{};
    if (!timebase.denom)
        mach_timebase_info(&timebase);
    return static_cast<double>(mach) * timebase.numer / timebase.denom / 1e6;
}

struct FrameContext {
    uint64_t displayed, submitted;
};

class Impl;

} // namespace

@interface MG2Output : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, assign) void *owner;
@end

namespace {

class Impl : public ScreenEncoder {
  public:
    ScreenEncoderSettings settings;
    Unit unit;
    Failure failure;
    SCStream *stream = nil;
    MG2Output *output = nil;
    dispatch_queue_t queue = nullptr;
    VTCompressionSessionRef session = nullptr;
    std::atomic<bool> force_key{false}, stopped{false};
    bool low_latency = false;
    std::vector<std::string> refused;
    std::string display_text;

    std::mutex stats_mutex;
    uint64_t captured = 0, idle = 0, encoded = 0, keyframes = 0, bytes = 0, dropped = 0;
    std::vector<double> capture_to_unit, encode_only;

    void fail(const std::string &message) {
        if (!stopped.exchange(true) && failure)
            failure(message);
    }

    bool set(CFStringRef key, CFTypeRef value) {
        const auto status = VTSessionSetProperty(session, key, value);
        if (status != noErr)
            refused.push_back(std::string([(__bridge NSString *)key UTF8String]) + "=" +
                              std::to_string(status));
        return status == noErr;
    }

    bool create_session() {
        const auto codec = settings.hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264;
        NSDictionary *low = @{
            (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder :
                @YES,
            (__bridge NSString *)kVTVideoEncoderSpecification_EnableLowLatencyRateControl : @YES
        };
        NSDictionary *plain = @{
            (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder :
                @YES
        };
        OSStatus status =
            VTCompressionSessionCreate(kCFAllocatorDefault, settings.width, settings.height, codec,
                                       (__bridge CFDictionaryRef)low, nullptr, nullptr, on_encoded,
                                       this, &session);
        low_latency = status == noErr;
        if (!low_latency)
            status = VTCompressionSessionCreate(kCFAllocatorDefault, settings.width,
                                                settings.height, codec,
                                                (__bridge CFDictionaryRef)plain, nullptr, nullptr,
                                                on_encoded, this, &session);
        if (status != noErr) {
            fail("VTCompressionSessionCreate failed: " + std::to_string(status));
            return false;
        }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
        set(kVTCompressionPropertyKey_ProfileLevel,
            settings.hevc ? kVTProfileLevel_HEVC_Main_AutoLevel
                          : kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel);
        set(kVTCompressionPropertyKey_AverageBitRate,
            (__bridge CFTypeRef) @(settings.bitrate_kbps * 1000));
        const int cap_kbps = settings.max_bitrate_kbps ? settings.max_bitrate_kbps
                                                       : settings.bitrate_kbps;
        set(kVTCompressionPropertyKey_DataRateLimits,
            (__bridge CFTypeRef) @[ @(cap_kbps * 1000 / 8), @1.0 ]);
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFTypeRef) @(settings.gop_frames));
        set(kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFTypeRef) @(settings.fps));
        VTCompressionSessionPrepareToEncodeFrames(session);
        return true;
    }

    static void on_encoded(void *refcon, void *frame, OSStatus status, VTEncodeInfoFlags flags,
                        CMSampleBufferRef sample) {
        auto self = static_cast<Impl *>(refcon);
        std::unique_ptr<FrameContext> context(static_cast<FrameContext *>(frame));
        if (status != noErr || !sample || (flags & kVTEncodeInfo_FrameDropped)) {
            std::lock_guard<std::mutex> lock(self->stats_mutex);
            ++self->dropped;
            return;
        }
        self->emit(sample, *context);
    }

    void emit(CMSampleBufferRef sample, const FrameContext &context) {
        bool keyframe = true;
        if (auto attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
            attachments && CFArrayGetCount(attachments) > 0) {
            auto first = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
            CFBooleanRef not_sync = nullptr;
            if (CFDictionaryGetValueIfPresent(first, kCMSampleAttachmentKey_NotSync,
                                              reinterpret_cast<const void **>(&not_sync)))
                keyframe = !CFBooleanGetValue(not_sync);
        }
        static const char start_code[4] = {0, 0, 0, 1};
        std::string out;
        const auto format = CMSampleBufferGetFormatDescription(sample);
        size_t count = 0;
        int length_size = 4;
        if (settings.hevc)
            CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, 0, nullptr, nullptr, &count,
                                                               &length_size);
        else
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nullptr, nullptr, &count,
                                                               &length_size);
        if (keyframe)
            for (size_t i = 0; i < count; ++i) {
                const uint8_t *set = nullptr;
                size_t size = 0;
                const auto status =
                    settings.hevc
                        ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, i, &set, &size,
                                                                             nullptr, nullptr)
                        : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, i, &set, &size,
                                                                             nullptr, nullptr);
                if (status == noErr) {
                    out.append(start_code, 4);
                    out.append(reinterpret_cast<const char *>(set), size);
                }
            }
        const auto block = CMSampleBufferGetDataBuffer(sample);
        const size_t total = CMBlockBufferGetDataLength(block);
        std::vector<uint8_t> data(total);
        CMBlockBufferCopyDataBytes(block, 0, total, data.data());
        size_t offset = 0;
        while (offset + length_size <= total) {
            size_t nal = 0;
            for (int i = 0; i < length_size; ++i)
                nal = (nal << 8) | data[offset + i];
            offset += length_size;
            if (offset + nal > total)
                break;
            out.append(start_code, 4);
            out.append(reinterpret_cast<const char *>(data.data() + offset), nal);
            offset += nal;
        }
        const auto now = mach_absolute_time();
        {
            std::lock_guard<std::mutex> lock(stats_mutex);
            ++encoded;
            keyframes += keyframe;
            bytes += out.size();
            if (context.displayed)
                capture_to_unit.push_back(host_ms(now) - host_ms(context.displayed));
            encode_only.push_back(host_ms(now) - host_ms(context.submitted));
        }
        if (!stopped && unit)
            unit(reinterpret_cast<const uint8_t *>(out.data()), out.size(), keyframe);
    }

    void frame(CMSampleBufferRef sample) {
        if (stopped)
            return;
        auto attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
        if (!attachments || CFArrayGetCount(attachments) == 0)
            return;
        NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
        NSNumber *status = info[SCStreamFrameInfoStatus];
        auto pixels = CMSampleBufferGetImageBuffer(sample);
        if (!status || status.integerValue != SCFrameStatusComplete || !pixels) {
            std::lock_guard<std::mutex> lock(stats_mutex);
            ++idle;
            return;
        }
        NSNumber *displayed = info[SCStreamFrameInfoDisplayTime];
        {
            std::lock_guard<std::mutex> lock(stats_mutex);
            ++captured;
        }
        NSDictionary *options =
            force_key.exchange(false)
                ? @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame : @YES}
                : nil;
        auto context = new FrameContext{displayed ? displayed.unsignedLongLongValue : 0,
                                        mach_absolute_time()};
        const auto result = VTCompressionSessionEncodeFrame(
            session, pixels, CMSampleBufferGetPresentationTimeStamp(sample), kCMTimeInvalid,
            (__bridge CFDictionaryRef)options, context, nullptr);
        if (result != noErr) {
            delete context;
            std::lock_guard<std::mutex> lock(stats_mutex);
            ++dropped;
        }
    }

    void start(const ScreenEncoderSettings &requested, Unit on_unit, Failure on_failure) override {
        settings = requested;
        unit = std::move(on_unit);
        failure = std::move(on_failure);
        if (!create_session())
            return;
        queue = dispatch_queue_create("vidvnc.mg2.capture", DISPATCH_QUEUE_SERIAL);
        [SCShareableContent
            getShareableContentExcludingDesktopWindows:NO
                                   onScreenWindowsOnly:YES
                                     completionHandler:^(SCShareableContent *content,
                                                         NSError *error) {
                                       if (error || content.displays.count == 0) {
                                           fail(error ? std::string("ScreenCaptureKit: ") +
                                                            error.localizedDescription.UTF8String
                                                      : "No display to capture");
                                           return;
                                       }
                                       SCDisplay *display = content.displays.firstObject;
                                       for (SCDisplay *candidate in content.displays)
                                           if (candidate.displayID == CGMainDisplayID())
                                               display = candidate;
                                       begin(display);
                                     }];
    }

    void begin(SCDisplay *display) {
        display_text = std::to_string(display.width) + "x" + std::to_string(display.height);
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display
                                                          excludingWindows:@[]];
        SCStreamConfiguration *config = [SCStreamConfiguration new];
        config.width = settings.width;
        config.height = settings.height;
        config.minimumFrameInterval = CMTimeMake(1, settings.fps);
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
        config.showsCursor = YES;
        config.queueDepth = 6;
        output = [MG2Output new];
        output.owner = this;
        stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];
        NSError *error = nil;
        if (![stream addStreamOutput:output
                                type:SCStreamOutputTypeScreen
                  sampleHandlerQueue:queue
                               error:&error])
            return fail(std::string("addStreamOutput: ") + error.localizedDescription.UTF8String);
        [stream startCaptureWithCompletionHandler:^(NSError *startError) {
          if (startError)
              fail(std::string("startCapture: ") + startError.localizedDescription.UTF8String);
        }];
    }

    void request_keyframe() override { force_key = true; }

    void stop() override {
        stopped = true;
        if (stream) {
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            [stream stopCaptureWithCompletionHandler:^(NSError *) {
              dispatch_semaphore_signal(done);
            }];
            dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
            stream = nil;
        }
        if (session) {
            VTCompressionSessionCompleteFrames(session, kCMTimeInvalid);
            VTCompressionSessionInvalidate(session);
            CFRelease(session);
            session = nullptr;
        }
    }

    static std::string percentiles(std::vector<double> values) {
        if (values.empty())
            return "null";
        std::sort(values.begin(), values.end());
        const auto at = [&](double p) {
            return values[std::min(values.size() - 1, static_cast<size_t>(p * values.size()))];
        };
        std::ostringstream text;
        text << "{\"p50\":" << at(0.5) << ",\"p95\":" << at(0.95) << ",\"p99\":" << at(0.99)
             << ",\"max\":" << values.back() << ",\"n\":" << values.size() << "}";
        return text.str();
    }

    std::string take_stats() override {
        std::lock_guard<std::mutex> lock(stats_mutex);
        std::ostringstream text;
        text << "{\"captured\":" << captured << ",\"idle\":" << idle << ",\"encoded\":" << encoded
             << ",\"keyframes\":" << keyframes << ",\"bytes\":" << bytes
             << ",\"dropped\":" << dropped << ",\"lowLatency\":" << (low_latency ? "true" : "false")
             << ",\"display\":\"" << display_text << "\""
             << ",\"captureToUnitMs\":" << percentiles(capture_to_unit)
             << ",\"encodeMs\":" << percentiles(encode_only) << ",\"refused\":[";
        for (size_t i = 0; i < refused.size(); ++i)
            text << (i ? "," : "") << "\"" << refused[i] << "\"";
        text << "]}";
        captured = idle = encoded = keyframes = bytes = dropped = 0;
        capture_to_unit.clear();
        encode_only.clear();
        return text.str();
    }
};

} // namespace

@implementation MG2Output
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    if (type == SCStreamOutputTypeScreen)
        static_cast<Impl *>(self.owner)->frame(sampleBuffer);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    static_cast<Impl *>(self.owner)->fail(std::string("Capture stopped: ") +
                                          error.localizedDescription.UTF8String);
}
@end

std::unique_ptr<ScreenEncoder> ScreenEncoder::create() { return std::make_unique<Impl>(); }

std::string screen_capture_probe() {
    __block std::string result = "timed out";
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,
                                                                   NSError *error) {
      result = error ? std::string("error: ") + error.localizedDescription.UTF8String
                     : "ok " + std::to_string(content.displays.count) + " displays";
      dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    return result;
}
