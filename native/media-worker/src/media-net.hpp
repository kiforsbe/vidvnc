#pragma once
#include <windows.h>

// The network process's entry point (media-net.cpp), reached through
// `media-worker.exe --network <control-in> <control-out> <frames> <input>`: four inherited
// pipe handles, as the worker passed them.
int network_main(HANDLE control_in, HANDLE control_out, HANDLE frames, HANDLE input);
