#pragma once
#include "net-pipes.hpp"

// The network process's entry point (media-net.cpp), reached through
// `media-worker --network <control-in> <control-out> <frames> <input>`: four inherited pipe
// ends (handles on Windows, descriptors on macOS), as the worker passed them.
int network_main(net_pipes::Native control_in, net_pipes::Native control_out,
                 net_pipes::Native frames, net_pipes::Native input);
