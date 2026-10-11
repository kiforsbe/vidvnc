// The process, media-net's launch and attestation, and the relay's launcher on Windows: the
// tier T1 sandbox in sandbox.hpp, and Windows' UDP table for port ownership.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winsock2.h>
#include <iphlpapi.h>
#include <shellapi.h>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>
#include "../platform.hpp"

namespace platform {

void init_process() { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }

unsigned long process_id() { return GetCurrentProcessId(); }

void exit_now(int code) {
    TerminateProcess(GetCurrentProcess(), static_cast<UINT>(code));
    ExitProcess(static_cast<UINT>(code)); // not reached
}

// The worker ends when its owner pipe closes, and the Windows host's kill-on-close job ends the
// whole tree; there is no parent watch.
void watch_parent(void (*)()) {}

bool launch_network(const NetEnds &ends, NetLaunch &out, std::string &error) {
    wchar_t executable[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) {
        error = "the media worker executable was not found";
        return false;
    }
    const auto handle_text = [](HANDLE handle) {
        return std::to_wstring(reinterpret_cast<ULONG_PTR>(handle));
    };
    const std::wstring command_line = L"\"" + std::wstring(executable) + L"\" --network " +
                                      handle_text(ends.control_in) + L" " +
                                      handle_text(ends.control_out) + L" " +
                                      handle_text(ends.frames) + L" " + handle_text(ends.input);
    // media-net must never rebuild the plugin registry: that would start gst-plugin-scanner,
    // which its job forbids.
    SetEnvironmentVariableW(L"GST_REGISTRY_UPDATE", L"no");
    SetEnvironmentVariableW(L"GST_REGISTRY_FORK", L"no");
    // Standard handles: without them, Windows copies the worker's handle values into media-net,
    // where they are invalid, and strict handle checks turn the first write to stderr (a GLib
    // warning, say) into a crash. The NUL device gives it real ones that go nowhere.
    SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
    sandbox::Handle null_device(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
                                            FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable,
                                            OPEN_EXISTING, 0, nullptr));
    if (!null_device) {
        error = "the null device could not be opened";
        return false;
    }
    sandbox::Options options;
    options.std_input = options.std_output = options.std_error = null_device.get();
    const auto launched = sandbox::launch(
        executable, command_line,
        {ends.control_in, ends.control_out, ends.frames, ends.input, null_device.get()}, out,
        options);
    if (!launched.ok)
        error = launched.error;
    return launched.ok;
}

// Says how media-net ended: a crash code (for example 0xC0000005) points at the cause, where
// "stopped" alone does not.
std::string network_exit(NetLaunch &launched) {
    if (!launched.process)
        return {};
    DWORD code = STILL_ACTIVE;
    WaitForSingleObject(launched.process.get(), 500);
    GetExitCodeProcess(launched.process.get(), &code);
    if (code == STILL_ACTIVE)
        return "still running";
    char hex[16];
    snprintf(hex, sizeof(hex), "0x%08lX", static_cast<unsigned long>(code));
    return hex;
}

void terminate_network(NetLaunch &launched) {
    if (launched.process)
        TerminateProcess(launched.process.get(), 0);
}

// Answer attestation (design, "Signaling changes", step 2): the loopback port in an answer
// from media-net must belong to this source's own media-net, per Windows' UDP table, so a
// compromised media-net cannot point the relay at another process's socket.
bool port_owned(const NetLaunch &launched, unsigned port) {
    if (!launched.pid)
        return false;
    ULONG size = 0;
    GetExtendedUdpTable(nullptr, &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0);
    std::vector<unsigned char> buffer(size);
    if (!size || GetExtendedUdpTable(buffer.data(), &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID,
                                     0) != NO_ERROR)
        return false;
    const auto table = reinterpret_cast<const MIB_UDPTABLE_OWNER_PID *>(buffer.data());
    for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        const auto &row = table->table[i];
        if (row.dwLocalAddr == htonl(INADDR_LOOPBACK) &&
            ntohs(static_cast<u_short>(row.dwLocalPort)) == port)
            return row.dwOwningPid == launched.pid;
    }
    return false;
}

// Tier T1 keeps media-net off every address but loopback; there is nothing to audit.
std::string network_socket_violation(const NetLaunch &) { return {}; }

// Quotes one argument the way CommandLineToArgvW reads it back.
static std::wstring quote_argument(const std::wstring &argument) {
    if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos)
        return argument;
    std::wstring quoted = L"\"";
    for (auto it = argument.begin();; ++it) {
        std::size_t backslashes = 0;
        while (it != argument.end() && *it == L'\\') {
            ++it;
            ++backslashes;
        }
        if (it == argument.end()) {
            quoted.append(backslashes * 2, L'\\');
            break;
        }
        if (*it == L'"')
            quoted.append(backslashes * 2 + 1, L'\\');
        else
            quoted.append(backslashes, L'\\');
        quoted.push_back(*it);
    }
    quoted.push_back(L'"');
    return quoted;
}

// `media-worker.exe --sandbox -- <program> [arguments]`: runs the program under the tier T1
// token that media-net uses (the user SID and most groups deny-only, restricting SIDs, no
// privileges, low integrity) in its own job and desktop, with the mitigations and no child
// processes. So it cannot open anything that grants access to the user alone: the profile,
// VidVNC's settings and TLS key. It gets no initial impersonation token: the program (the media
// relay, Node running a bundle from its command line) never drops one, so it would keep the
// user's rights on its main thread. Its image is mapped by this process; it must need no other
// file it cannot read. Its standard handles are this process's; the exit code is the
// program's.
int run_sandboxed(int, char **) {
    int count = 0;
    const auto arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments || count < 4 || std::wstring(arguments[2]) != L"--")
        return 2;
    const std::wstring program = arguments[3];
    std::wstring command_line;
    for (int i = 3; i < count; ++i)
        command_line += (i > 3 ? L" " : L"") + quote_argument(arguments[i]);
    LocalFree(arguments);
    // Inheritable copies of the standard handles, for the explicit handle list.
    HANDLE handles[3] = {};
    const DWORD kinds[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
    for (int i = 0; i < 3; ++i)
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(kinds[i]), GetCurrentProcess(),
                             &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) {
            std::cerr << "Unable to pass the standard handles to the sandbox" << std::endl;
            return 2;
        }
    sandbox::Options options;
    options.initial_token = false; // never impersonate: see above
    options.std_input = handles[0];
    options.std_output = handles[1];
    options.std_error = handles[2];
    sandbox::Launched launched;
    const auto result = sandbox::launch(program, command_line, {handles[0], handles[1], handles[2]},
                                        launched, options);
    for (auto handle : handles)
        CloseHandle(handle);
    if (!result.ok) {
        std::cerr << "Unable to start the sandboxed program: " << result.error << std::endl;
        return 2;
    }
    WaitForSingleObject(launched.process.get(), INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(launched.process.get(), &code);
    return static_cast<int>(code);
}

// media-net starts impersonating a same-access token (set by the worker on its suspended main
// thread), so it can still start Winsock and load every plugin and library it needs.
bool network_before_load() {
    WSADATA winsock;
    return WSAStartup(MAKEWORD(2, 2), &winsock) == 0;
}

// Drops to the restricted primary token before any socket or peer data.
bool network_drop_privileges() {
    if (!RevertToSelf())
        return false;
    HANDLE thread_token = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread_token)) {
        CloseHandle(thread_token);
        return false;
    }
    return true;
}

// Gate P4: code generated at run time is refused from here on.
bool network_code_guard() {
    PROCESS_MITIGATION_DYNAMIC_CODE_POLICY acg{};
    acg.ProhibitDynamicCode = 1;
    return SetProcessMitigationPolicy(ProcessDynamicCodePolicy, &acg, sizeof(acg)) != FALSE;
}

const char *network_tier() { return "T1"; }

void end_network_process(int code) { ExitProcess(static_cast<UINT>(code)); }

// The server lists Windows adapters with PowerShell (windows-lan-adapters.mjs).
int list_adapters() {
    std::cerr << "--adapters is not used on Windows" << std::endl;
    return 2;
}

} // namespace platform
