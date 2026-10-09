# MG1/MG2 prototype only (throwaway): media-net.cpp, unmodified, built with Clang against
# GStreamer.framework, with a stand-in worker. See mac-worker.mm.
cmake_minimum_required(VERSION 3.24)
project(vidvnc_mg1 CXX OBJCXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(GSTREAMER_FRAMEWORK "$ENV{GSTREAMER_FRAMEWORK}" CACHE PATH "GStreamer.framework")
if(NOT GSTREAMER_FRAMEWORK)
  foreach(candidate "/Library/Frameworks/GStreamer.framework" "$ENV{HOME}/Library/Frameworks/GStreamer.framework")
    if(EXISTS "${candidate}/Headers/gst/gst.h")
      set(GSTREAMER_FRAMEWORK "${candidate}")
      break()
    endif()
  endforeach()
endif()
if(NOT EXISTS "${GSTREAMER_FRAMEWORK}/Headers/gst/gst.h")
  message(FATAL_ERROR "GStreamer.framework not found; set GSTREAMER_FRAMEWORK.")
endif()
get_filename_component(GSTREAMER_FRAMEWORK_DIR "${GSTREAMER_FRAMEWORK}" DIRECTORY)
set(GST_LIB "${GSTREAMER_FRAMEWORK}/Versions/Current/lib")

# media-net.cpp and net-pipes.hpp include "sandbox.hpp" from their own directory, so the sources
# are staged next to the shim's sandbox.hpp rather than compiled in place.
set(STAGE "${CMAKE_BINARY_DIR}/stage")
set(SRC "${CMAKE_CURRENT_SOURCE_DIR}/../src")
file(GLOB SHARED_HEADERS "${SRC}/*.hpp")
foreach(file ${SHARED_HEADERS} "${SRC}/media-net.cpp")
  get_filename_component(name "${file}" NAME)
  if(NOT name STREQUAL "sandbox.hpp")
    configure_file("${file}" "${STAGE}/${name}" COPYONLY)
  endif()
endforeach()
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/shim/sandbox.hpp" "${STAGE}/sandbox.hpp" COPYONLY)

add_executable(media-worker mac-worker.mm screen-encoder.mm "${STAGE}/media-net.cpp")
target_include_directories(media-worker PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/shim" "${STAGE}" "${GSTREAMER_FRAMEWORK}/Headers")
target_compile_options(media-worker PRIVATE -F "${GSTREAMER_FRAMEWORK_DIR}" $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_directories(media-worker PRIVATE "${GST_LIB}")
target_link_libraries(media-worker PRIVATE gstreamer-1.0 gobject-2.0 glib-2.0 json-glib-1.0
  gstapp-1.0 gstvideo-1.0 gstwebrtc-1.0 gstsdp-1.0 gstrtp-1.0
  "-framework ScreenCaptureKit" "-framework VideoToolbox" "-framework CoreMedia"
  "-framework CoreVideo" "-framework CoreGraphics" "-framework Foundation")
set_target_properties(media-worker PROPERTIES BUILD_RPATH "${GST_LIB}")
