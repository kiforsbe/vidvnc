#!/usr/bin/env python3
# MG8 prototype only: the GStreamer plugins the worker and media-net use, and every GStreamer
# dylib they reach through @rpath, so the bundle carries only those. Prints one path per line:
# plugins first (prefixed "plugin "), then libraries ("lib ").
import os, subprocess, sys

PLUGINS = ["app", "audioconvert", "audioresample", "audiotestsrc", "coreelements", "dtls", "nice",
           "opus", "rtp", "rtpmanager", "sctp", "srtp", "videoparsersbad", "webrtc"]
lib = sys.argv[1]
binaries = sys.argv[2:]
plugins = [os.path.join(lib, "gstreamer-1.0", f"libgst{p}.dylib") for p in PLUGINS]
todo, seen, libs = binaries + plugins, set(), set()
while todo:
    path = todo.pop()
    if path in seen:
        continue
    seen.add(path)
    for line in subprocess.run(["otool", "-L", path], capture_output=True, text=True).stdout.splitlines()[1:]:
        name = line.strip().split(" ")[0]
        if name.startswith("@rpath/"):
            candidate = os.path.join(lib, name[len("@rpath/"):])
            if os.path.exists(candidate) and name not in libs:
                libs.add(name)
                todo.append(candidate)
for path in plugins:
    print("plugin", path)
for name in sorted(libs):
    print("lib", os.path.join(lib, name[len("@rpath/"):]))
