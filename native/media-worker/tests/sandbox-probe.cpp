// Prototype gate P3 of docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-split-
// design.md: can the network process run webrtcbin under the tier T1 sandbox?
//
// Run without arguments (sandbox-check.mjs does, with the worker's environment). The parent
// creates a secret file in the user's profile, a UDP echo socket on loopback and a result
// pipe, then starts itself in the sandbox. The child loads GStreamer while impersonating the
// initial token, calls RevertToSelf, and reports each check as a PASS, FAIL or INFO line.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <gst/gst.h>
#include <gst/webrtc/webrtc.h>
#include <gst/sdp/sdp.h>
#include <filesystem>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include "../src/sandbox.hpp"

namespace {

std::string utf8(const std::wstring &text) {
    if (text.empty())
        return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()),
                                         nullptr, 0, nullptr, nullptr);
    std::string out(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), size,
                        nullptr, nullptr);
    return out;
}

// ---- Child: runs inside the sandbox.

HANDLE results = nullptr;
int failures = 0;

void line(const std::string &text) {
    const std::string row = text + "\n";
    DWORD written = 0;
    WriteFile(results, row.data(), static_cast<DWORD>(row.size()), &written, nullptr);
}
void check(const std::string &name, bool ok, const std::string &detail = {}) {
    if (!ok)
        failures++;
    line((ok ? "PASS: " : "FAIL: ") + name + (detail.empty() ? "" : " - " + detail));
}
void info(const std::string &text) { line("INFO: " + text); }
std::string error_text(DWORD error) { return "error " + std::to_string(error); }

bool udp_echo(unsigned short port, std::string &detail) {
    const SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET) {
        detail = "socket: " + error_text(WSAGetLastError());
        return false;
    }
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sockaddr_in echo = local;
    echo.sin_port = htons(port);
    bool ok = false;
    if (bind(s, reinterpret_cast<sockaddr *>(&local), sizeof(local)) != 0)
        detail = "bind: " + error_text(WSAGetLastError());
    else if (sendto(s, "ping", 4, 0, reinterpret_cast<sockaddr *>(&echo), sizeof(echo)) != 4)
        detail = "sendto: " + error_text(WSAGetLastError());
    else {
        fd_set readable;
        FD_ZERO(&readable);
        FD_SET(s, &readable);
        timeval timeout{2, 0};
        char buffer[16] = {};
        if (select(0, &readable, nullptr, nullptr, &timeout) != 1)
            detail = "no echo within 2 s";
        else if (recv(s, buffer, sizeof(buffer), 0) != 4 || std::string(buffer, 4) != "ping")
            detail = "unexpected echo";
        else
            ok = true;
    }
    closesocket(s);
    return ok;
}

// Offer from a webrtcbin gathering on 127.0.0.1 only: exercises socket creation, ICE gathering
// and DTLS certificate generation under the lowered token.
bool gather(std::string &detail) {
    GstElement *pipeline = gst_pipeline_new("probe");
    GstElement *webrtc = gst_element_factory_make("webrtcbin", "webrtc");
    if (!webrtc) {
        detail = "webrtcbin could not be created";
        gst_object_unref(pipeline);
        return false;
    }
    gst_bin_add(GST_BIN(pipeline), webrtc);
    GstWebRTCICE *ice = nullptr;
    g_object_get(webrtc, "ice-agent", &ice, nullptr);
    gboolean added = FALSE;
    if (ice) {
        g_signal_emit_by_name(ice, "add-local-ip-address", "127.0.0.1", &added);
        gst_object_unref(ice);
    }
    GstCaps *caps = gst_caps_from_string(
        "application/x-rtp,media=audio,encoding-name=OPUS,payload=96,clock-rate=48000");
    GstWebRTCRTPTransceiver *transceiver = nullptr;
    g_signal_emit_by_name(webrtc, "add-transceiver", GST_WEBRTC_RTP_TRANSCEIVER_DIRECTION_SENDONLY,
                          caps, &transceiver);
    gst_caps_unref(caps);
    if (transceiver)
        gst_object_unref(transceiver);
    gst_element_set_state(pipeline, GST_STATE_PLAYING);

    GstPromise *promise = gst_promise_new();
    g_signal_emit_by_name(webrtc, "create-offer", nullptr, promise);
    gst_promise_wait(promise);
    GstWebRTCSessionDescription *offer = nullptr;
    if (const GstStructure *reply = gst_promise_get_reply(promise))
        gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr);
    gst_promise_unref(promise);
    bool ok = false;
    if (!added)
        detail = "the ICE agent refused 127.0.0.1";
    else if (!offer)
        detail = "no offer";
    else {
        GstPromise *set = gst_promise_new();
        g_signal_emit_by_name(webrtc, "set-local-description", offer, set);
        gst_promise_wait(set);
        gst_promise_unref(set);
        gst_webrtc_session_description_free(offer);
        GstWebRTCICEGatheringState state = GST_WEBRTC_ICE_GATHERING_STATE_NEW;
        for (int i = 0; i < 100 && state != GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE; i++) {
            g_usleep(100000);
            g_object_get(webrtc, "ice-gathering-state", &state, nullptr);
        }
        GstWebRTCSessionDescription *local = nullptr;
        g_object_get(webrtc, "local-description", &local, nullptr);
        gchar *text = local ? gst_sdp_message_as_text(local->sdp) : nullptr;
        const std::string sdp = text ? text : "";
        g_free(text);
        if (local)
            gst_webrtc_session_description_free(local);
        const bool candidate = sdp.find(" 127.0.0.1 ") != std::string::npos;
        const bool fingerprint = sdp.find("a=fingerprint:") != std::string::npos;
        ok = state == GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE && candidate && fingerprint;
        detail = std::string("gathering ") +
                 (state == GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE ? "complete" : "incomplete") +
                 ", loopback candidate " + (candidate ? "yes" : "no") + ", DTLS fingerprint " +
                 (fingerprint ? "yes" : "no");
    }
    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(pipeline);
    return ok;
}

int child(HANDLE pipe, unsigned short echo_port, const std::wstring &secret) {
    results = pipe;
    // Before lowering: prove the impersonation token is in effect, start Winsock and load every
    // library the network process needs.
    TOKEN_TYPE type = TokenPrimary;
    DWORD size = 0;
    GetTokenInformation(GetCurrentThreadEffectiveToken(), TokenType, &type, sizeof(type), &size);
    check("started impersonating the initial token", type == TokenImpersonation);
    WSADATA winsock;
    check("Winsock started", WSAStartup(MAKEWORD(2, 2), &winsock) == 0);
    GError *error = nullptr;
    const bool initialised = gst_init_check(nullptr, nullptr, &error);
    check("GStreamer initialised", initialised, error ? error->message : "");
    if (error)
        g_error_free(error);
    if (!initialised)
        return 1;
    for (const char *name :
         {"coreelements", "app", "rtp", "rtpmanager", "webrtc", "nice", "dtls", "srtp", "sctp"}) {
        GstPlugin *plugin = gst_plugin_load_by_name(name);
        check(std::string("preloaded plugin ") + name, plugin != nullptr);
        if (plugin)
            gst_object_unref(plugin);
    }

    check("RevertToSelf", RevertToSelf() != FALSE);
    GetTokenInformation(GetCurrentThreadEffectiveToken(), TokenType, &type, sizeof(type), &size);
    check("now running on the primary token", type == TokenPrimary);

    // The token itself.
    const HANDLE token = GetCurrentProcessToken();
    auto label = sandbox::token_information(token, TokenIntegrityLevel);
    DWORD rid = 0;
    if (!label.empty()) {
        const PSID sid = reinterpret_cast<TOKEN_MANDATORY_LABEL *>(label.data())->Label.Sid;
        rid = *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
    }
    check("integrity level is Low", rid == SECURITY_MANDATORY_LOW_RID,
          "RID 0x" + std::to_string(rid));
    check("token is restricted", IsTokenRestricted(token) != FALSE);
    auto user = sandbox::token_information(token, TokenUser);
    check("user SID is deny-only",
          !user.empty() && (reinterpret_cast<TOKEN_USER *>(user.data())->User.Attributes &
                            SE_GROUP_USE_FOR_DENY_ONLY));

    // What it must not be able to do.
    HANDLE file = CreateFileW(secret.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              0, nullptr);
    const DWORD file_error = GetLastError();
    check("a file in the user's profile cannot be read", file == INVALID_HANDLE_VALUE,
          file == INVALID_HANDLE_VALUE ? error_text(file_error) : "it was opened");
    if (file != INVALID_HANDLE_VALUE)
        CloseHandle(file);
    HANDLE self = OpenProcess(PROCESS_VM_READ, FALSE, GetCurrentProcessId());
    check("another sandboxed process could not open this one", self == nullptr,
          self ? "it was opened" : error_text(GetLastError()));
    if (self)
        CloseHandle(self);
    wchar_t system[MAX_PATH] = {};
    GetSystemDirectoryW(system, MAX_PATH);
    std::wstring command = L"\"" + std::wstring(system) + L"\\cmd.exe\" /c exit 0";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION launched{};
    const BOOL started = CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                                        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &launched);
    check("no child process can be started", !started,
          started ? "cmd.exe started" : error_text(GetLastError()));
    if (started) {
        TerminateProcess(launched.hProcess, 0);
        CloseHandle(launched.hProcess);
        CloseHandle(launched.hThread);
    }
    wchar_t name[256] = {};
    DWORD needed = 0;
    GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, name, sizeof(name),
                              &needed);
    check("runs on an alternate desktop", std::wstring(name) != L"Default", utf8(name));
    wchar_t own[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, own, MAX_PATH);
    HANDLE exe =
        CreateFileW(own, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    info(std::string("its own executable is ") +
         (exe == INVALID_HANDLE_VALUE
              ? "not readable after lowering (" + error_text(GetLastError()) + ")"
              : "readable after lowering"));
    if (exe != INVALID_HANDLE_VALUE)
        CloseHandle(exe);

    // What it must still be able to do.
    std::string detail;
    check("UDP on loopback works after lowering", udp_echo(echo_port, detail), detail);
    check("webrtcbin gathers on loopback after lowering", gather(detail), detail);
    line(failures ? "RESULT: FAIL" : "RESULT: PASS");
    return failures ? 1 : 0;
}

// ---- Parent: prepares the probe and reports what the child found.

int parent(const std::wstring &executable) {
    WSADATA winsock;
    if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
        std::cerr << "WSAStartup failed" << std::endl;
        return 2;
    }
    // A UDP echo on loopback for the child's socket check.
    const SOCKET echo = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int length = sizeof(address);
    if (echo == INVALID_SOCKET ||
        bind(echo, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 ||
        getsockname(echo, reinterpret_cast<sockaddr *>(&address), &length) != 0) {
        std::cerr << "Unable to open the echo socket" << std::endl;
        return 2;
    }
    std::thread echo_thread([echo] {
        char buffer[64];
        sockaddr_in from{};
        int from_length = sizeof(from);
        int received;
        while ((received = recvfrom(echo, buffer, sizeof(buffer), 0,
                                    reinterpret_cast<sockaddr *>(&from), &from_length)) > 0) {
            sendto(echo, buffer, received, 0, reinterpret_cast<sockaddr *>(&from), from_length);
            from_length = sizeof(from);
        }
    });

    // A secret in the user's profile, readable by the user but not the sandbox.
    wchar_t local_app_data[MAX_PATH] = {};
    GetEnvironmentVariableW(L"LOCALAPPDATA", local_app_data, MAX_PATH);
    const std::filesystem::path folder = std::filesystem::path(local_app_data) / L"VidVNC";
    std::filesystem::create_directories(folder);
    const std::filesystem::path secret = folder / L"sandbox-probe-secret.txt";
    {
        HANDLE file =
            CreateFileW(secret.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
        DWORD written = 0;
        if (file != INVALID_HANDLE_VALUE) {
            WriteFile(file, "secret", 6, &written, nullptr);
            CloseHandle(file);
        }
    }

    // The child must never rebuild the registry: that would start gst-plugin-scanner.
    SetEnvironmentVariableW(L"GST_REGISTRY_UPDATE", L"no");
    SetEnvironmentVariableW(L"GST_REGISTRY_FORK", L"no");

    SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
    HANDLE read = nullptr, write = nullptr;
    if (!CreatePipe(&read, &write, &inheritable, 0)) {
        std::cerr << "CreatePipe failed" << std::endl;
        return 2;
    }
    SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
    const std::wstring command =
        L"\"" + executable + L"\" --child " + std::to_wstring(reinterpret_cast<ULONG_PTR>(write)) +
        L" " + std::to_wstring(ntohs(address.sin_port)) + L" \"" + secret.wstring() + L"\"";
    sandbox::Launched launched;
    const auto result = sandbox::launch(executable, command, {write}, launched);
    CloseHandle(write);
    int status = 1;
    if (!result.ok) {
        std::cout << "FAIL: launching the sandboxed probe - " << result.error << std::endl;
    } else {
        std::cout << "INFO: sandboxed probe started as process " << launched.pid << " on desktop "
                  << utf8(launched.desktop_name) << std::endl;
        char buffer[4096];
        DWORD received = 0;
        while (ReadFile(read, buffer, sizeof(buffer), &received, nullptr) && received)
            std::cout.write(buffer, received);
        std::cout.flush();
        if (WaitForSingleObject(launched.process.get(), 60000) != WAIT_OBJECT_0) {
            std::cout << "FAIL: the probe did not exit within 60 s" << std::endl;
            TerminateProcess(launched.process.get(), 1);
        } else {
            DWORD exit_code = 1;
            GetExitCodeProcess(launched.process.get(), &exit_code);
            std::cout << "INFO: the probe exited with code " << exit_code << std::endl;
            status = exit_code == 0 ? 0 : 1;
        }
    }
    CloseHandle(read);
    closesocket(echo);
    echo_thread.join();
    std::error_code ignored;
    std::filesystem::remove(secret, ignored);
    return status;
}

} // namespace

int wmain(int argc, wchar_t **argv) {
    if (argc == 5 && std::wstring(argv[1]) == L"--child")
        return child(reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(std::stoull(argv[2]))),
                     static_cast<unsigned short>(std::stoul(argv[3])), argv[4]);
    wchar_t executable[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, executable, MAX_PATH);
    return parent(executable);
}
