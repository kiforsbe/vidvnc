# The media worker: one binary with two roles, the worker (capture, encode, input broker) and,
# started by it with --network under the media-net sandbox, media-net (WebRTC). The shared
# code is the same on both platforms; src/platform/<platform>/ holds what differs.
if(WIN32 AND MSVC)
  set(VIDVNC_PLATFORM windows)
elseif(APPLE)
  # macOS 27 on Apple Silicon only (macOS design, Q6). CMakePresets.json sets both.
  if(NOT CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
    message(FATAL_ERROR "The macOS media worker builds for arm64 only; use the macos-arm64 preset.")
  endif()
  enable_language(OBJCXX)
  set(VIDVNC_PLATFORM macos)
else()
  message(FATAL_ERROR "The media worker builds on Windows with MSVC, or on macOS with Apple clang.")
endif()

if(VIDVNC_PLATFORM STREQUAL "windows")
  set(GSTREAMER_ROOT "$ENV{GSTREAMER_ROOT}" CACHE PATH "GStreamer MSVC development SDK")
  if(NOT GSTREAMER_ROOT)
    set(GSTREAMER_ROOT "${PROJECT_SOURCE_DIR}/.deps/gstreamer")
  endif()
  if(NOT EXISTS "${GSTREAMER_ROOT}/include/gstreamer-1.0/gst/gst.h")
    message(FATAL_ERROR "Install the GStreamer MSVC development SDK and set GSTREAMER_ROOT.")
  endif()
else()
  # The GStreamer framework the user installed, per user or for the whole Mac, with its
  # development files: one copy for every checkout (tools/deps.mjs checks it).
  set(GSTREAMER_ROOT "$ENV{GSTREAMER_ROOT}" CACHE PATH "GStreamer.framework/Versions/1.0")
  if(NOT GSTREAMER_ROOT)
    set(GSTREAMER_ROOT "$ENV{HOME}/Library/Frameworks/GStreamer.framework/Versions/1.0")
    if(NOT EXISTS "${GSTREAMER_ROOT}/include/gstreamer-1.0/gst/gst.h")
      set(GSTREAMER_ROOT "/Library/Frameworks/GStreamer.framework/Versions/1.0")
    endif()
  endif()
  if(NOT EXISTS "${GSTREAMER_ROOT}/include/gstreamer-1.0/gst/gst.h")
    message(FATAL_ERROR "Install the GStreamer framework with its development package (npm run deps says which), or set GSTREAMER_ROOT.")
  endif()
endif()
add_library(gstreamer_sdk INTERFACE)
target_include_directories(gstreamer_sdk INTERFACE
  "${GSTREAMER_ROOT}/include/gstreamer-1.0"
  "${GSTREAMER_ROOT}/include/glib-2.0"
  "${GSTREAMER_ROOT}/lib/glib-2.0/include"
  "${GSTREAMER_ROOT}/include/json-glib-1.0")
if(VIDVNC_PLATFORM STREQUAL "windows")
  target_link_directories(gstreamer_sdk INTERFACE "${GSTREAMER_ROOT}/lib")
else()
  # By full path: Xcode would add the configuration to a link directory, and the framework
  # also has static archives with the same names.
  foreach(library gstreamer-1.0 gobject-2.0 glib-2.0 json-glib-1.0 gstapp-1.0 gstbase-1.0 gstvideo-1.0 gstwebrtc-1.0 gstsdp-1.0)
    add_library(${library} SHARED IMPORTED)
    set_target_properties(${library} PROPERTIES IMPORTED_LOCATION "${GSTREAMER_ROOT}/lib/lib${library}.dylib")
  endforeach()
endif()
target_link_libraries(gstreamer_sdk INTERFACE gstreamer-1.0 gobject-2.0 glib-2.0 json-glib-1.0)
function(configure_worker_target target)
  target_compile_features(${target} PRIVATE cxx_std_17)
  if(VIDVNC_PLATFORM STREQUAL "windows")
    target_compile_options(${target} PRIVATE /W4 /EHsc)
    set_target_properties(${target} PROPERTIES MSVC_RUNTIME_LIBRARY "MultiThreadedDLL" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wno-missing-field-initializers $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
    # The framework's libraries are found through its own folder in development builds;
    # packaging rewrites this to the bundle.
    # The Xcode generator ignores per-language compile options, so ARC is also set as Xcode's
    # own build setting; elements.hpp refuses to compile without it.
    set_target_properties(${target} PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}" BUILD_RPATH "${GSTREAMER_ROOT}/lib" XCODE_ATTRIBUTE_CLANG_ENABLE_OBJC_ARC YES)
  endif()
endfunction()
if(VIDVNC_PLATFORM STREQUAL "windows")
  set(platform_sources src/platform/windows/displays.cpp src/platform/windows/input.cpp
    src/platform/windows/media.cpp src/platform/windows/process.cpp)
else()
  set(platform_sources src/platform/macos/adapters.mm src/platform/macos/displays.mm
    src/platform/macos/input.mm src/platform/macos/media.mm src/platform/macos/process.cpp
    src/platform/macos/screen-capture.mm src/platform/macos/vt-encoder.mm)
endif()
add_executable(media-worker src/media-worker.cpp src/media-net.cpp ${platform_sources})
configure_worker_target(media-worker)
target_compile_definitions(media-worker PRIVATE GST_USE_UNSTABLE_API)
target_link_libraries(media-worker PRIVATE gstreamer_sdk gstapp-1.0 gstvideo-1.0 gstwebrtc-1.0 gstsdp-1.0)
if(VIDVNC_PLATFORM STREQUAL "windows")
  target_link_libraries(media-worker PRIVATE user32 dxgi ws2_32 advapi32 iphlpapi shell32)
else()
  target_link_libraries(media-worker PRIVATE gstbase-1.0 "-framework AppKit"
    "-framework ApplicationServices" "-framework CoreFoundation" "-framework CoreGraphics"
    "-framework CoreMedia" "-framework CoreVideo" "-framework Foundation" "-framework IOKit"
    "-framework ScreenCaptureKit" "-framework SystemConfiguration" "-framework VideoToolbox")
endif()
if(BUILD_TESTING)
  foreach(name net-records input-policy transport-telemetry display-coordinates stream-profile peer-permission keyframe-limiter sdp-payload video-codec rate-control encoder-backend encoder-properties encoder-selection)
    add_executable(${name}-test tests/${name}.cpp)
    configure_worker_target(${name}-test)
    # Existing tests use assert(); retain assertions in Release.
    if(VIDVNC_PLATFORM STREQUAL "windows")
      target_compile_options(${name}-test PRIVATE /UNDEBUG)
    else()
      target_compile_options(${name}-test PRIVATE -UNDEBUG)
    endif()
    add_test(NAME media-worker.${name} COMMAND ${name}-test)
    if(VIDVNC_PLATFORM STREQUAL "windows")
      set_tests_properties(media-worker.${name} PROPERTIES ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${GSTREAMER_ROOT}/bin")
    endif()
  endforeach()
  target_link_libraries(transport-telemetry-test PRIVATE gstreamer_sdk)
  target_link_libraries(stream-profile-test PRIVATE gstreamer_sdk)
  target_link_libraries(rate-control-test PRIVATE gstreamer_sdk)
  target_link_libraries(encoder-properties-test PRIVATE gstreamer_sdk)
  target_link_libraries(sdp-payload-test PRIVATE gstreamer_sdk gstsdp-1.0)
  if(VIDVNC_PLATFORM STREQUAL "windows")
    # Prototype gate P3 (sandbox for the network process). Run through tests/sandbox-check.mjs,
    # not CTest: it needs the GStreamer registry and an interactive session.
    add_executable(sandbox-probe tests/sandbox-probe.cpp)
    configure_worker_target(sandbox-probe)
    target_compile_definitions(sandbox-probe PRIVATE GST_USE_UNSTABLE_API)
    target_link_libraries(sandbox-probe PRIVATE gstreamer_sdk gstwebrtc-1.0 gstsdp-1.0 ws2_32 user32 advapi32)
  else()
    # Answer attestation on macOS: ports owned by this process, by another one and by nobody.
    add_executable(udp-ports-test tests/udp-ports.cpp)
    configure_worker_target(udp-ports-test)
    target_compile_options(udp-ports-test PRIVATE -UNDEBUG)
    add_test(NAME media-worker.udp-ports COMMAND udp-ports-test)
    # The sandbox profiles and the start-up image walk they are built from.
    add_executable(sandbox-profile-test tests/sandbox-profile.cpp)
    configure_worker_target(sandbox-profile-test)
    target_compile_options(sandbox-profile-test PRIVATE -UNDEBUG)
    target_link_libraries(sandbox-profile-test PRIVATE gstreamer_sdk)
    add_test(NAME media-worker.sandbox-profile COMMAND sandbox-profile-test)
    # Gate MG4's checks against the media-net profile. Run through tests/sandbox-check.mjs,
    # not CTest: it needs the owner's session.
    add_executable(sandbox-probe tests/sandbox-probe-macos.mm)
    configure_worker_target(sandbox-probe)
    target_link_libraries(sandbox-probe PRIVATE "-framework CoreGraphics" "-framework Foundation"
      "-framework ScreenCaptureKit")
    # VideoToolbox rate control from the same intents as encoder-properties.
    add_executable(vt-rate-control-test tests/vt-rate-control.cpp)
    configure_worker_target(vt-rate-control-test)
    target_compile_options(vt-rate-control-test PRIVATE -UNDEBUG)
    target_link_libraries(vt-rate-control-test PRIVATE gstreamer_sdk)
    add_test(NAME media-worker.vt-rate-control COMMAND vt-rate-control-test)
    # Sample-count timestamps for ScreenCaptureKit audio.
    add_executable(audio-timeline-test tests/audio-timeline.cpp)
    configure_worker_target(audio-timeline-test)
    target_compile_options(audio-timeline-test PRIVATE -UNDEBUG)
    add_test(NAME media-worker.audio-timeline COMMAND audio-timeline-test)
  endif()
endif()
