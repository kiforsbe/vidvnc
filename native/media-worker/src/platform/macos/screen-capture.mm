// vidvncscreensrc (ScreenCaptureKit) and vidvncaudiosrc (a Core Audio system audio tap) as
// GStreamer live sources (design D1), and the registration of the worker's macOS elements
// (elements.hpp).
//
// Each video source owns one SCStream. System audio does not use ScreenCaptureKit: with an
// audio SCStream running in another process, stopping one video SCStream left macOS unable to
// start the next one (startCapture never returned) and froze the audio, so switching a
// viewer's profile failed. A process tap is independent of ScreenCaptureKit. The capture
// callbacks run on their own queues; the streaming thread waits for the next frame or audio
// chunk. A screen that does not change sends no new frames, so the video source repeats its
// last frame at the profile's rate, as desktop duplication does on Windows: the encoder's
// rate control and forced key frames both need frames to act on.
#import <Foundation/Foundation.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <CoreGraphics/CoreGraphics.h>
#include <gst/audio/audio.h>
#include "../../audio-timeline.hpp"
#include <gst/base/gstpushsrc.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include "../platform.hpp"
#include "elements.hpp"

namespace macos {
GType vt_encoder_type();
}

namespace {

GQuark pixels_quark() {
    static const GQuark quark = g_quark_from_static_string("vidvnc-cv-pixel-buffer");
    return quark;
}

// What ScreenCaptureKit's errors mean to the person who has to fix them.
std::string capture_error(NSError *error) {
    if (!error)
        return "Screen capture did not start.";
    if ([error.domain isEqualToString:SCStreamErrorDomain] &&
        error.code == SCStreamErrorUserDeclined)
        return "Screen recording is not allowed. Allow the app that started VidVNC in System "
               "Settings, Privacy & Security, Screen & System Audio Recording.";
    return std::string("Screen capture failed: ") +
           (error.localizedDescription.UTF8String ?: "unknown error");
}

// ScreenCaptureKit answers through completion handlers on its own queues (the worker's main
// thread runs a GLib loop, not a run loop). These wait for the answer, for ten seconds at most.
NSError *timed_out(NSString *what) {
    return [NSError
        errorWithDomain:@"VidVNC"
                   code:1
               userInfo:@{
                   NSLocalizedDescriptionKey : [what stringByAppendingString:@" timed out"]
               }];
}

bool wait(dispatch_semaphore_t done) {
    return dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0;
}

SCShareableContent *shareable_content(std::string &error) {
    __block SCShareableContent *content = nil;
    __block NSError *failure = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [SCShareableContent
        getShareableContentExcludingDesktopWindows:NO
                               onScreenWindowsOnly:YES
                                 completionHandler:^(SCShareableContent *found, NSError *problem) {
                                   content = found;
                                   failure = problem;
                                   dispatch_semaphore_signal(done);
                                 }];
    if (!wait(done)) {
        error = capture_error(timed_out(@"Listing displays"));
        return nil;
    }
    if (!content)
        error = capture_error(failure);
    return content;
}

// Starts or stops `stream`; nil on success.
NSError *change_capture(SCStream *stream, bool start) {
    __block NSError *failure = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    void (^finish)(NSError *) = ^(NSError *problem) {
      failure = problem;
      dispatch_semaphore_signal(done);
    };
    if (start)
        [stream startCaptureWithCompletionHandler:finish];
    else
        [stream stopCaptureWithCompletionHandler:finish];
    if (!wait(done))
        return timed_out(start ? @"Starting screen capture" : @"Stopping screen capture");
    return failure;
}

SCDisplay *find_display(SCShareableContent *content, CGDirectDisplayID id) {
    for (SCDisplay *display in content.displays)
        if (display.displayID == id)
            return display;
    return nil;
}

// This process and the ones that started it: the server, and the VidVNC app or the terminal.
// Their sound is VidVNC's own, and stays out of the stream.
std::set<pid_t> own_processes() {
    std::set<pid_t> result;
    for (pid_t pid = getpid(); pid > 1 && result.insert(pid).second;) {
        kinfo_proc info{};
        size_t size = sizeof(info);
        int name[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
        if (sysctl(name, 4, &info, &size, nullptr, 0) != 0 || size == 0)
            break;
        pid = info.kp_eproc.e_ppid;
    }
    return result;
}

} // namespace

// ---- Shared stream plumbing.

struct CaptureQueue;

@interface VidVncStreamOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, assign) CaptureQueue *queue;
@end

struct CaptureQueue {
    std::mutex mutex;
    std::condition_variable changed;
    bool flushing = false;
    std::string error;
    // Video: the newest complete frame not yet sent.
    CVPixelBufferRef latest = nullptr;
    // Audio: interleaved 48 kHz float chunks.
    std::deque<GstBuffer *> audio;
    int channels = 2;
    SCStream *stream = nil;
    VidVncStreamOutput *output = nil;
    dispatch_queue_t callbacks = nil;

    void fail(const std::string &message) {
        std::lock_guard<std::mutex> lock(mutex);
        if (error.empty())
            error = message;
        changed.notify_all();
    }
    void clear() {
        std::lock_guard<std::mutex> lock(mutex);
        if (latest)
            CVPixelBufferRelease(latest);
        latest = nullptr;
        for (auto *buffer : audio)
            gst_buffer_unref(buffer);
        audio.clear();
    }
    // Starts `stream`, which must already have its outputs. Returns false with `error` set.
    bool start(SCStream *candidate) {
        stream = candidate;
        NSError *failure = change_capture(candidate, true);
        if (failure) {
            fail(capture_error(failure));
            stream = nil;
            return false;
        }
        return true;
    }
    void stop() {
        if (stream)
            change_capture(stream, false);
        if (output)
            output.queue = nullptr;
        stream = nil;
        output = nil;
        clear();
    }
};

@implementation VidVncStreamOutput
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    CaptureQueue *queue = self.queue;
    if (!queue || !CMSampleBufferIsValid(sample))
        return;
    if (type == SCStreamOutputTypeScreen)
        [self screen:sample queue:queue];
}

- (void)screen:(CMSampleBufferRef)sample queue:(CaptureQueue *)queue {
    // Only complete frames carry new pixels; idle and blank ones are skipped.
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (!attachments || CFArrayGetCount(attachments) < 1)
        return;
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *status = info[SCStreamFrameInfoStatus];
    if (!status || status.integerValue != SCFrameStatusComplete)
        return;
    CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
    if (!pixels)
        return;
    std::lock_guard<std::mutex> lock(queue->mutex);
    if (queue->latest)
        CVPixelBufferRelease(queue->latest);
    queue->latest = CVPixelBufferRetain(pixels);
    queue->changed.notify_all();
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (CaptureQueue *queue = self.queue)
        queue->fail(capture_error(error));
}
@end

// ---- vidvncscreensrc.

struct ScreenState {
    guint display = 0; // CGDirectDisplayID; 0 is the main display.
    int width = 1280, height = 720, fps = 30;
    bool cursor = true;
    CaptureQueue queue;
    CVPixelBufferRef last = nullptr;
    std::chrono::steady_clock::time_point next;
};

struct VidVncScreenSrc {
    GstPushSrc parent;
    ScreenState *state;
};
struct VidVncScreenSrcClass {
    GstPushSrcClass parent_class;
};

G_DEFINE_TYPE(VidVncScreenSrc, vidvnc_screen_src, GST_TYPE_PUSH_SRC)

enum {
    SCREEN_PROP_0,
    SCREEN_PROP_DISPLAY,
    SCREEN_PROP_WIDTH,
    SCREEN_PROP_HEIGHT,
    SCREEN_PROP_FPS,
    SCREEN_PROP_CURSOR
};

static ScreenState &screen(gpointer self) {
    return *reinterpret_cast<VidVncScreenSrc *>(self)->state;
}

static void screen_set_property(GObject *object, guint id, const GValue *value, GParamSpec *spec) {
    auto &state = screen(object);
    switch (id) {
    case SCREEN_PROP_DISPLAY:
        state.display = g_value_get_uint(value);
        break;
    case SCREEN_PROP_WIDTH:
        state.width = g_value_get_int(value);
        break;
    case SCREEN_PROP_HEIGHT:
        state.height = g_value_get_int(value);
        break;
    case SCREEN_PROP_FPS:
        state.fps = g_value_get_int(value);
        break;
    case SCREEN_PROP_CURSOR:
        state.cursor = g_value_get_boolean(value);
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
    }
}

static void screen_get_property(GObject *object, guint id, GValue *value, GParamSpec *spec) {
    auto &state = screen(object);
    switch (id) {
    case SCREEN_PROP_DISPLAY:
        g_value_set_uint(value, state.display);
        break;
    case SCREEN_PROP_WIDTH:
        g_value_set_int(value, state.width);
        break;
    case SCREEN_PROP_HEIGHT:
        g_value_set_int(value, state.height);
        break;
    case SCREEN_PROP_FPS:
        g_value_set_int(value, state.fps);
        break;
    case SCREEN_PROP_CURSOR:
        g_value_set_boolean(value, state.cursor);
        break;
    default:
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
    }
}

// The capture display reconfigured underneath the stream: unplugged, disabled, moved or given
// a new mode. The session fails, the worker releases held input, and the viewer reconnects to
// a fresh inventory, as on Windows.
static void display_changed(CGDirectDisplayID display, CGDisplayChangeSummaryFlags flags,
                            void *data) {
    auto &state = *static_cast<ScreenState *>(data);
    if (flags & kCGDisplayBeginConfigurationFlag)
        return;
    const auto watched = state.display ? state.display : CGMainDisplayID();
    if (display == watched &&
        (flags & (kCGDisplayRemoveFlag | kCGDisplayDisabledFlag | kCGDisplayMovedFlag |
                  kCGDisplaySetModeFlag | kCGDisplayMirrorFlag)))
        state.queue.fail("Capture display changed. Reconnect.");
}

static gboolean screen_start(GstBaseSrc *source) {
    auto &state = screen(source);
    @autoreleasepool {
        state.queue.error.clear();
        state.queue.flushing = false;
        std::string error;
        auto *content = shareable_content(error);
        const auto id = state.display ? state.display : CGMainDisplayID();
        SCDisplay *display = content ? find_display(content, id) : nil;
        if (!display) {
            GST_ELEMENT_ERROR(
                source, RESOURCE, NOT_FOUND,
                ("%s", error.empty() ? "The capture display is not available." : error.c_str()),
                (nullptr));
            return FALSE;
        }
        auto *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        auto *configuration = [[SCStreamConfiguration alloc] init];
        configuration.width = static_cast<size_t>(state.width);
        configuration.height = static_cast<size_t>(state.height);
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
        configuration.colorMatrix = kCGDisplayStreamYCbCrMatrix_ITU_R_709_2;
        configuration.minimumFrameInterval = CMTimeMake(1, state.fps);
        configuration.showsCursor = state.cursor;
        // Frames held at once: the newest, the one last sent and the one being encoded, with
        // room for ScreenCaptureKit to keep capturing.
        configuration.queueDepth = 6;
        state.queue.output = [[VidVncStreamOutput alloc] init];
        state.queue.output.queue = &state.queue;
        state.queue.callbacks = dispatch_queue_create("vidvnc.screen", DISPATCH_QUEUE_SERIAL);
        auto *stream = [[SCStream alloc] initWithFilter:filter
                                          configuration:configuration
                                               delegate:state.queue.output];
        NSError *failure = nil;
        if (![stream addStreamOutput:state.queue.output
                                type:SCStreamOutputTypeScreen
                  sampleHandlerQueue:state.queue.callbacks
                               error:&failure] ||
            !state.queue.start(stream)) {
            const auto message = failure ? capture_error(failure) : state.queue.error;
            GST_ELEMENT_ERROR(source, RESOURCE, OPEN_READ, ("%s", message.c_str()), (nullptr));
            state.queue.output = nil;
            return FALSE;
        }
    }
    CGDisplayRegisterReconfigurationCallback(display_changed, &state);
    state.next = std::chrono::steady_clock::now();
    return TRUE;
}

static gboolean screen_stop(GstBaseSrc *source) {
    auto &state = screen(source);
    CGDisplayRemoveReconfigurationCallback(display_changed, &state);
    @autoreleasepool {
        state.queue.stop();
    }
    if (state.last)
        CVPixelBufferRelease(state.last);
    state.last = nullptr;
    return TRUE;
}

static gboolean screen_unlock(GstBaseSrc *source) {
    auto &queue = screen(source).queue;
    std::lock_guard<std::mutex> lock(queue.mutex);
    queue.flushing = true;
    queue.changed.notify_all();
    return TRUE;
}

static gboolean screen_unlock_stop(GstBaseSrc *source) {
    auto &queue = screen(source).queue;
    std::lock_guard<std::mutex> lock(queue.mutex);
    queue.flushing = false;
    return TRUE;
}

static GstCaps *screen_get_caps(GstBaseSrc *source, GstCaps *filter) {
    auto &state = screen(source);
    auto *caps = gst_caps_new_simple("video/x-raw", "format", G_TYPE_STRING, "NV12", "width",
                                     G_TYPE_INT, state.width, "height", G_TYPE_INT, state.height,
                                     "framerate", GST_TYPE_FRACTION, state.fps, 1,
                                     "pixel-aspect-ratio", GST_TYPE_FRACTION, 1, 1, nullptr);
    gst_caps_set_features(caps, 0, gst_caps_features_new("memory:CVPixelBuffer", nullptr));
    if (filter) {
        auto *both = gst_caps_intersect_full(filter, caps, GST_CAPS_INTERSECT_FIRST);
        gst_caps_unref(caps);
        return both;
    }
    return caps;
}

static GstFlowReturn screen_create(GstPushSrc *source, GstBuffer **out) {
    auto &state = screen(source);
    auto &queue = state.queue;
    const auto interval = std::chrono::nanoseconds(GST_SECOND / state.fps);
    // How long past its due time a frame waits for new pixels before the last ones repeat:
    // long enough not to race ScreenCaptureKit's own cadence on a moving screen.
    const auto grace = interval / 2;
    CVPixelBufferRef pixels = nullptr;
    {
        std::unique_lock<std::mutex> lock(queue.mutex);
        for (;;) {
            if (queue.flushing)
                return GST_FLOW_FLUSHING;
            if (!queue.error.empty()) {
                const auto message = queue.error;
                lock.unlock();
                GST_ELEMENT_ERROR(source, RESOURCE, READ, ("%s", message.c_str()), (nullptr));
                return GST_FLOW_ERROR;
            }
            const auto now = std::chrono::steady_clock::now();
            // A new frame goes out at once, but never faster than the profile's rate.
            if (queue.latest && now >= state.next) {
                pixels = queue.latest;
                queue.latest = nullptr;
                break;
            }
            // Nothing new by the time the next frame is due: the screen is still.
            if (state.last && now >= state.next + grace) {
                pixels = CVPixelBufferRetain(state.last);
                break;
            }
            if (state.last || queue.latest)
                queue.changed.wait_until(lock, queue.latest ? state.next : state.next + grace);
            else
                queue.changed.wait(lock);
        }
    }
    const auto now = std::chrono::steady_clock::now();
    state.next = std::max(state.next + interval, now - interval);
    if (state.last != pixels) {
        if (state.last)
            CVPixelBufferRelease(state.last);
        state.last = CVPixelBufferRetain(pixels);
    }
    auto *buffer = gst_buffer_new();
    macos::attach_frame_pixels(buffer, pixels);
    CVPixelBufferRelease(pixels);
    GST_BUFFER_DURATION(buffer) = GST_SECOND / state.fps;
    *out = buffer;
    return GST_FLOW_OK;
}

static void screen_finalize(GObject *object) {
    delete reinterpret_cast<VidVncScreenSrc *>(object)->state;
    G_OBJECT_CLASS(vidvnc_screen_src_parent_class)->finalize(object);
}

static GstStaticPadTemplate screen_template =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS,
                            GST_STATIC_CAPS("video/x-raw(memory:CVPixelBuffer), format=NV12"));

static void vidvnc_screen_src_class_init(VidVncScreenSrcClass *klass) {
    auto *object = G_OBJECT_CLASS(klass);
    auto *element = GST_ELEMENT_CLASS(klass);
    auto *base = GST_BASE_SRC_CLASS(klass);
    object->set_property = screen_set_property;
    object->get_property = screen_get_property;
    object->finalize = screen_finalize;
    const auto flags = static_cast<GParamFlags>(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(object, SCREEN_PROP_DISPLAY,
                                    g_param_spec_uint("display", "Display",
                                                      "CGDirectDisplayID; 0 for the main display",
                                                      0, G_MAXUINT32, 0, flags));
    g_object_class_install_property(
        object, SCREEN_PROP_WIDTH,
        g_param_spec_int("width", "Width", "Output width in pixels", 64, 4096, 1280, flags));
    g_object_class_install_property(
        object, SCREEN_PROP_HEIGHT,
        g_param_spec_int("height", "Height", "Output height in pixels", 64, 4096, 720, flags));
    g_object_class_install_property(
        object, SCREEN_PROP_FPS,
        g_param_spec_int("fps", "Frame rate", "Frames per second", 1, 60, 30, flags));
    g_object_class_install_property(
        object, SCREEN_PROP_CURSOR,
        g_param_spec_boolean("show-cursor", "Show cursor", "Draw the cursor", TRUE, flags));
    gst_element_class_add_static_pad_template(element, &screen_template);
    gst_element_class_set_static_metadata(element, "VidVNC screen capture", "Source/Video",
                                          "One display through ScreenCaptureKit", "VidVNC");
    base->start = screen_start;
    base->stop = screen_stop;
    base->unlock = screen_unlock;
    base->unlock_stop = screen_unlock_stop;
    base->get_caps = screen_get_caps;
    GST_PUSH_SRC_CLASS(klass)->create = screen_create;
}

static void vidvnc_screen_src_init(VidVncScreenSrc *self) {
    self->state = new ScreenState;
    gst_base_src_set_live(GST_BASE_SRC(self), TRUE);
    gst_base_src_set_format(GST_BASE_SRC(self), GST_FORMAT_TIME);
    gst_base_src_set_do_timestamp(GST_BASE_SRC(self), TRUE);
}

// ---- vidvncaudiosrc.

// A system-wide stereo tap that leaves out VidVNC's own processes, read through a private
// aggregate device. macOS asks for System Audio Recording for the app that started VidVNC
// the first time; until it is allowed the tap delivers silence.
struct SystemAudioTap {
    AudioObjectID tap = kAudioObjectUnknown;
    AudioObjectID device = kAudioObjectUnknown;
    AudioDeviceIOProcID proc = nullptr;
    dispatch_queue_t callbacks = nil;

    void stop() {
        if (device != kAudioObjectUnknown && proc) {
            AudioDeviceStop(device, proc);
            AudioDeviceDestroyIOProcID(device, proc);
        }
        proc = nullptr;
        if (device != kAudioObjectUnknown)
            AudioHardwareDestroyAggregateDevice(device);
        device = kAudioObjectUnknown;
        if (tap != kAudioObjectUnknown)
            AudioHardwareDestroyProcessTap(tap);
        tap = kAudioObjectUnknown;
        callbacks = nil;
    }
};

struct AudioState {
    CaptureQueue queue;
    SystemAudioTap tap;
    int rate = 48000;
    AudioTimeline timeline;
};

struct VidVncAudioSrc {
    GstPushSrc parent;
    AudioState *state;
};
struct VidVncAudioSrcClass {
    GstPushSrcClass parent_class;
};

G_DEFINE_TYPE(VidVncAudioSrc, vidvnc_audio_src, GST_TYPE_PUSH_SRC)

static AudioState &audio(gpointer self) { return *reinterpret_cast<VidVncAudioSrc *>(self)->state; }

static std::string audio_error(const char *step, OSStatus status) {
    return std::string("System audio capture failed (") + step + ", " + std::to_string(status) +
           ").";
}

// Copies one Core Audio buffer list into an interleaved stereo float chunk on the queue.
static void push_audio(CaptureQueue &queue, const AudioStreamBasicDescription &format,
                       const AudioBufferList *list) {
    if (!list || list->mNumberBuffers == 0 || format.mBytesPerFrame == 0)
        return;
    const bool planar = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
    const auto in_channels = static_cast<int>(format.mChannelsPerFrame);
    const auto frames = planar ? list->mBuffers[0].mDataByteSize / sizeof(float)
                               : list->mBuffers[0].mDataByteSize / (in_channels * sizeof(float));
    if (!frames || in_channels < 1)
        return;
    const int out_channels = queue.channels;
    auto *buffer = gst_buffer_new_allocate(nullptr, frames * out_channels * sizeof(float), nullptr);
    GstMapInfo map{};
    gst_buffer_map(buffer, &map, GST_MAP_WRITE);
    auto *out = reinterpret_cast<float *>(map.data);
    for (size_t frame = 0; frame < frames; ++frame)
        for (int channel = 0; channel < out_channels; ++channel) {
            const int source = channel < in_channels ? channel : in_channels - 1;
            float value = 0;
            if (planar && static_cast<UInt32>(source) < list->mNumberBuffers &&
                list->mBuffers[source].mDataByteSize >= (frame + 1) * sizeof(float))
                value = static_cast<const float *>(list->mBuffers[source].mData)[frame];
            else if (!planar && list->mBuffers[0].mDataByteSize >=
                                    (frame * in_channels + source + 1) * sizeof(float))
                value = static_cast<const float *>(
                    list->mBuffers[0].mData)[frame * in_channels + source];
            out[frame * out_channels + channel] = value;
        }
    gst_buffer_unmap(buffer, &map);
    std::lock_guard<std::mutex> lock(queue.mutex);
    // Half a second at most: an audio source that stopped being read drops its oldest sound
    // rather than growing.
    while (queue.audio.size() >= 50) {
        gst_buffer_unref(queue.audio.front());
        queue.audio.pop_front();
    }
    queue.audio.push_back(buffer);
    queue.changed.notify_all();
}

// The Core Audio process objects of VidVNC's own processes, whose sound stays out.
static NSArray<NSNumber *> *own_audio_processes() {
    NSMutableArray<NSNumber *> *result = [NSMutableArray array];
    for (pid_t pid : own_processes()) {
        AudioObjectPropertyAddress address{kAudioHardwarePropertyTranslatePIDToProcessObject,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
        AudioObjectID object = kAudioObjectUnknown;
        UInt32 size = sizeof(object);
        if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(pid), &pid, &size,
                                       &object) == noErr &&
            object != kAudioObjectUnknown)
            [result addObject:@(object)];
    }
    return result;
}

static bool start_tap(AudioState &state, std::string &error) {
    auto &tap = state.tap;
    auto *description =
        [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:own_audio_processes()];
    description.name = @"VidVNC system audio";
    description.privateTap = YES;
    description.muteBehavior = CATapUnmuted;
    OSStatus status = AudioHardwareCreateProcessTap(description, &tap.tap);
    if (status != noErr) {
        error = audio_error("tap", status);
        return false;
    }
    AudioObjectPropertyAddress format_address{
        kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioStreamBasicDescription format{};
    UInt32 size = sizeof(format);
    status = AudioObjectGetPropertyData(tap.tap, &format_address, 0, nullptr, &size, &format);
    if (status != noErr || format.mFormatID != kAudioFormatLinearPCM ||
        !(format.mFormatFlags & kAudioFormatFlagIsFloat) || format.mBitsPerChannel != 32 ||
        format.mSampleRate < 8000) {
        error = status != noErr ? audio_error("format", status)
                                : "System audio capture failed: unexpected sample format.";
        tap.stop();
        return false;
    }
    state.rate = static_cast<int>(format.mSampleRate);
    NSDictionary *aggregate = @{
        @kAudioAggregateDeviceNameKey : @"VidVNC system audio",
        @kAudioAggregateDeviceUIDKey : NSUUID.UUID.UUIDString,
        @kAudioAggregateDeviceIsPrivateKey : @YES,
        @kAudioAggregateDeviceIsStackedKey : @NO,
        @kAudioAggregateDeviceTapAutoStartKey : @YES,
        @kAudioAggregateDeviceTapListKey : @[ @{
            @kAudioSubTapUIDKey : description.UUID.UUIDString,
            @kAudioSubTapDriftCompensationKey : @YES,
        } ],
    };
    status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &tap.device);
    if (status != noErr) {
        error = audio_error("device", status);
        tap.stop();
        return false;
    }
    tap.callbacks = dispatch_queue_create("vidvnc.audio", DISPATCH_QUEUE_SERIAL);
    CaptureQueue *queue = &state.queue;
    const auto stream_format = format;
    status = AudioDeviceCreateIOProcIDWithBlock(
        &tap.proc, tap.device, tap.callbacks,
        ^(const AudioTimeStamp *, const AudioBufferList *input, const AudioTimeStamp *,
          AudioBufferList *, const AudioTimeStamp *) {
          push_audio(*queue, stream_format, input);
        });
    if (status == noErr)
        status = AudioDeviceStart(tap.device, tap.proc);
    if (status != noErr) {
        error = audio_error("start", status);
        tap.stop();
        return false;
    }
    return true;
}

static gboolean audio_start(GstBaseSrc *source) {
    auto &state = audio(source);
    {
        std::lock_guard<std::mutex> lock(state.queue.mutex);
        state.queue.error.clear();
        state.queue.flushing = false;
    }
    std::string error;
    @autoreleasepool {
        if (!start_tap(state, error)) {
            GST_ELEMENT_ERROR(source, RESOURCE, OPEN_READ, ("%s", error.c_str()), (nullptr));
            return FALSE;
        }
    }
    state.timeline = AudioTimeline(state.rate);
    return TRUE;
}

static gboolean audio_stop(GstBaseSrc *source) {
    auto &state = audio(source);
    @autoreleasepool {
        state.tap.stop();
    }
    state.queue.clear();
    return TRUE;
}

static GstCaps *audio_get_caps(GstBaseSrc *source, GstCaps *filter) {
    auto *caps = gst_caps_new_simple("audio/x-raw", "format", G_TYPE_STRING, "F32LE", "layout",
                                     G_TYPE_STRING, "interleaved", "rate", G_TYPE_INT,
                                     audio(source).rate, "channels", G_TYPE_INT, 2, "channel-mask",
                                     GST_TYPE_BITMASK, static_cast<guint64>(0x3), nullptr);
    if (filter) {
        auto *both = gst_caps_intersect_full(filter, caps, GST_CAPS_INTERSECT_FIRST);
        gst_caps_unref(caps);
        return both;
    }
    return caps;
}

static gboolean audio_unlock(GstBaseSrc *source) {
    auto &queue = audio(source).queue;
    std::lock_guard<std::mutex> lock(queue.mutex);
    queue.flushing = true;
    queue.changed.notify_all();
    return TRUE;
}

static gboolean audio_unlock_stop(GstBaseSrc *source) {
    auto &queue = audio(source).queue;
    std::lock_guard<std::mutex> lock(queue.mutex);
    queue.flushing = false;
    return TRUE;
}

static GstFlowReturn audio_create(GstPushSrc *source, GstBuffer **out) {
    auto &queue = audio(source).queue;
    std::unique_lock<std::mutex> lock(queue.mutex);
    queue.changed.wait(
        lock, [&] { return queue.flushing || !queue.error.empty() || !queue.audio.empty(); });
    if (queue.flushing)
        return GST_FLOW_FLUSHING;
    if (!queue.error.empty()) {
        const auto message = queue.error;
        lock.unlock();
        GST_ELEMENT_ERROR(source, RESOURCE, READ, ("%s", message.c_str()), (nullptr));
        return GST_FLOW_ERROR;
    }
    auto *buffer = queue.audio.front();
    queue.audio.pop_front();
    lock.unlock();
    // Timestamps from the sample count (audio-timeline.hpp), anchored to the running time.
    std::int64_t now = 0;
    if (GstClock *clock = gst_element_get_clock(GST_ELEMENT(source))) {
        const auto time = gst_clock_get_time(clock);
        const auto base = gst_element_get_base_time(GST_ELEMENT(source));
        now = time > base ? static_cast<std::int64_t>(time - base) : 0;
        gst_object_unref(clock);
    }
    const auto frames =
        static_cast<std::int64_t>(gst_buffer_get_size(buffer) / (queue.channels * sizeof(float)));
    const auto stamp = audio(source).timeline.next(now, frames);
    GST_BUFFER_PTS(buffer) = static_cast<GstClockTime>(stamp.pts_ns);
    GST_BUFFER_DTS(buffer) = GST_CLOCK_TIME_NONE;
    GST_BUFFER_DURATION(buffer) = static_cast<GstClockTime>(stamp.duration_ns);
    if (stamp.discont)
        GST_BUFFER_FLAG_SET(buffer, GST_BUFFER_FLAG_DISCONT);
    *out = buffer;
    return GST_FLOW_OK;
}

static void audio_finalize(GObject *object) {
    delete reinterpret_cast<VidVncAudioSrc *>(object)->state;
    G_OBJECT_CLASS(vidvnc_audio_src_parent_class)->finalize(object);
}

static GstStaticPadTemplate audio_template = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("audio/x-raw, format=F32LE, layout=interleaved, rate=[ 8000, 192000 ], "
                    "channels=2, channel-mask=(bitmask)0x3"));

static void vidvnc_audio_src_class_init(VidVncAudioSrcClass *klass) {
    auto *element = GST_ELEMENT_CLASS(klass);
    auto *base = GST_BASE_SRC_CLASS(klass);
    G_OBJECT_CLASS(klass)->finalize = audio_finalize;
    gst_element_class_add_static_pad_template(element, &audio_template);
    gst_element_class_set_static_metadata(element, "VidVNC system audio capture", "Source/Audio",
                                          "System audio through a Core Audio process tap",
                                          "VidVNC");
    base->start = audio_start;
    base->stop = audio_stop;
    base->get_caps = audio_get_caps;
    base->unlock = audio_unlock;
    base->unlock_stop = audio_unlock_stop;
    GST_PUSH_SRC_CLASS(klass)->create = audio_create;
}

static void vidvnc_audio_src_init(VidVncAudioSrc *self) {
    self->state = new AudioState;
    gst_base_src_set_live(GST_BASE_SRC(self), TRUE);
    gst_base_src_set_format(GST_BASE_SRC(self), GST_FORMAT_TIME);
    // audio_create stamps buffers itself, from their sample counts.
    gst_base_src_set_do_timestamp(GST_BASE_SRC(self), FALSE);
}

// ---- Registration and frame hand-over.

namespace macos {

void register_elements() {
    static const bool registered = [] {
        return gst_element_register(nullptr, "vidvncscreensrc", GST_RANK_NONE,
                                    vidvnc_screen_src_get_type()) &&
               gst_element_register(nullptr, "vidvncaudiosrc", GST_RANK_NONE,
                                    vidvnc_audio_src_get_type()) &&
               gst_element_register(nullptr, "vidvncvtenc", GST_RANK_NONE, vt_encoder_type());
    }();
    if (!registered)
        throw std::runtime_error("Unable to register the macOS capture and encode elements.");
}

CVPixelBufferRef frame_pixels(GstBuffer *buffer) {
    return static_cast<CVPixelBufferRef>(
        gst_mini_object_get_qdata(GST_MINI_OBJECT(buffer), pixels_quark()));
}

void attach_frame_pixels(GstBuffer *buffer, CVPixelBufferRef pixels) {
    gst_mini_object_set_qdata(GST_MINI_OBJECT(buffer), pixels_quark(), CVPixelBufferRetain(pixels),
                              reinterpret_cast<GDestroyNotify>(CVPixelBufferRelease));
}

} // namespace macos
