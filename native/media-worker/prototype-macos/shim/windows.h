#pragma once
// MG1 prototype only: just enough of the Win32 surface that media-net.cpp and net-pipes.hpp use,
// over POSIX file descriptors, so both compile unmodified with Clang on macOS. A HANDLE carries
// fd + 1, so nullptr stays "no handle". The sandbox calls are no-ops that report the truth:
// there is no restricted token and no dynamic-code guard here.
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <fcntl.h>
#include <unistd.h>

typedef void *HANDLE;
typedef std::uint32_t DWORD;
typedef std::uint16_t WORD;
#include <objc/objc.h> // BOOL, the same type in C++ and Objective-C++ translation units
#ifndef TRUE
#define TRUE 1
#define FALSE 0
#endif
#define HANDLE_FLAG_INHERIT 0x1
#define TOKEN_QUERY 0x8
#define MAKEWORD(a, b) static_cast<WORD>((a) | ((b) << 8))

inline int shim_fd(HANDLE handle) { return static_cast<int>(reinterpret_cast<intptr_t>(handle)) - 1; }
inline HANDLE shim_handle(int fd) { return reinterpret_cast<HANDLE>(static_cast<intptr_t>(fd) + 1); }

struct SECURITY_ATTRIBUTES {
    DWORD nLength;
    void *lpSecurityDescriptor;
    BOOL bInheritHandle;
};
inline BOOL CreatePipe(HANDLE *read, HANDLE *write, SECURITY_ATTRIBUTES *attributes, DWORD) {
    int fds[2];
    if (pipe(fds) != 0)
        return FALSE;
    if (!attributes || !attributes->bInheritHandle) {
        fcntl(fds[0], F_SETFD, FD_CLOEXEC);
        fcntl(fds[1], F_SETFD, FD_CLOEXEC);
    }
    *read = shim_handle(fds[0]);
    *write = shim_handle(fds[1]);
    return TRUE;
}
inline BOOL SetHandleInformation(HANDLE handle, DWORD mask, DWORD flags) {
    if (!(mask & HANDLE_FLAG_INHERIT))
        return TRUE;
    return fcntl(shim_fd(handle), F_SETFD, (flags & HANDLE_FLAG_INHERIT) ? 0 : FD_CLOEXEC) == 0;
}
inline BOOL ReadFile(HANDLE handle, void *data, DWORD size, DWORD *received, void *) {
    for (;;) {
        const auto n = read(shim_fd(handle), data, size);
        if (n < 0 && errno == EINTR)
            continue;
        *received = n > 0 ? static_cast<DWORD>(n) : 0;
        return n >= 0;
    }
}
inline BOOL WriteFile(HANDLE handle, const void *data, DWORD size, DWORD *written, void *) {
    for (;;) {
        const auto n = write(shim_fd(handle), data, size);
        if (n < 0 && errno == EINTR)
            continue;
        *written = n > 0 ? static_cast<DWORD>(n) : 0;
        return n >= 0;
    }
}
inline BOOL CloseHandle(HANDLE handle) { return close(shim_fd(handle)) == 0; }
inline void Sleep(DWORD ms) { usleep(ms * 1000); }
[[noreturn]] inline void ExitProcess(unsigned code) { _exit(static_cast<int>(code)); }

struct WSADATA {
    int unused;
};
inline int WSAStartup(WORD, WSADATA *) { return 0; }
inline BOOL RevertToSelf() { return TRUE; }
inline HANDLE GetCurrentThread() { return nullptr; }
inline BOOL OpenThreadToken(HANDLE, DWORD, BOOL, HANDLE *) { return FALSE; }
struct PROCESS_MITIGATION_DYNAMIC_CODE_POLICY {
    unsigned ProhibitDynamicCode : 1;
};
enum { ProcessDynamicCodePolicy = 2 };
inline BOOL SetProcessMitigationPolicy(int, void *, std::size_t) { return FALSE; }
