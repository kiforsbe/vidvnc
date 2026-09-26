#pragma once
// Launching a process in the media-net sandbox: design Part B, "Token for media-net"
// (docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-split-design.md).
//
// Tier T1: a restricted primary token (the user SID and most groups deny-only; restricting
// SIDs Everyone, Users, RESTRICTED and the logon SID; no privileges but change-notify; low
// integrity), a job with no child processes and UI limits, an alternate desktop labelled low,
// an explicit inherited-handle list and process mitigations. The child starts impersonating a
// same-access restricted token at low integrity so it can load its libraries, then calls
// RevertToSelf before touching any untrusted input. Needs no administrator rights.
//
// The child is started without a console (DETACHED_PROCESS): a hidden console would need a
// conhost.exe, which the job's one-process limit and the child-process policy are expected to
// refuse; the child then fails to initialise with STATUS_DLL_INIT_FAILED (0xC0000142).
#include <windows.h>
#include <sddl.h>
#include <string>
#include <vector>

namespace sandbox {

class Handle {
    HANDLE value_ = nullptr;

  public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    Handle(const Handle &) = delete;
    Handle &operator=(const Handle &) = delete;
    Handle(Handle &&other) noexcept : value_(other.value_) { other.value_ = nullptr; }
    Handle &operator=(Handle &&other) noexcept {
        if (this != &other) {
            reset();
            value_ = other.value_;
            other.value_ = nullptr;
        }
        return *this;
    }
    ~Handle() { reset(); }
    void reset() {
        if (value_ && value_ != INVALID_HANDLE_VALUE)
            CloseHandle(value_);
        value_ = nullptr;
    }
    HANDLE get() const { return value_; }
    explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
};

struct Result {
    bool ok = true;
    std::string error;
};

inline Result failure(const char *what) {
    return {false, std::string(what) + " failed (error " + std::to_string(GetLastError()) + ")"};
}

inline std::vector<BYTE> token_information(HANDLE token, TOKEN_INFORMATION_CLASS type) {
    DWORD size = 0;
    GetTokenInformation(token, type, nullptr, 0, &size);
    std::vector<BYTE> buffer(size);
    if (!size || !GetTokenInformation(token, type, buffer.data(), size, &size))
        buffer.clear();
    return buffer;
}

inline std::wstring sid_text(PSID sid) {
    LPWSTR text = nullptr;
    std::wstring out;
    if (ConvertSidToStringSidW(sid, &text)) {
        out = text;
        LocalFree(text);
    }
    return out;
}

struct WellKnownSid {
    BYTE bytes[SECURITY_MAX_SID_SIZE] = {};
    PSID sid() { return bytes; }
    bool make(WELL_KNOWN_SID_TYPE type) {
        DWORD size = sizeof(bytes);
        return CreateWellKnownSid(type, nullptr, bytes, &size) != FALSE;
    }
};

inline bool set_low_integrity(HANDLE token) {
    WellKnownSid low;
    if (!low.make(WinLowLabelSid))
        return false;
    TOKEN_MANDATORY_LABEL label{};
    label.Label.Attributes = SE_GROUP_INTEGRITY;
    label.Label.Sid = low.sid();
    return SetTokenInformation(token, TokenIntegrityLevel, &label,
                               sizeof(label) + GetLengthSid(low.sid())) != FALSE;
}

// A security descriptor from SDDL, freed with LocalFree.
class Descriptor {
    PSECURITY_DESCRIPTOR value_ = nullptr;

  public:
    explicit Descriptor(const std::wstring &sddl) {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                                  &value_, nullptr))
            value_ = nullptr;
    }
    Descriptor(const Descriptor &) = delete;
    Descriptor &operator=(const Descriptor &) = delete;
    ~Descriptor() {
        if (value_)
            LocalFree(value_);
    }
    PSECURITY_DESCRIPTOR get() const { return value_; }
};

struct Tokens {
    Handle primary; // what the process runs as after RevertToSelf
    Handle initial; // impersonated while loading libraries
    std::wstring user_sid;
    std::wstring logon_sid;
};

// Switches that turn off one part of the sandbox, for diagnosing a launch that fails
// (sandbox-probe --relax). Production uses the defaults.
struct Options {
    bool restricted = true;        // deny-only and restricting SIDs; false: low integrity only
    bool initial_token = true;     // start impersonating the same-access token
    bool job = true;               // the job and its limits
    bool alternate_desktop = true; // false: the caller's desktop
    bool mitigations = true;       // process mitigation policies
    bool object_security = true;   // the process and thread security descriptors
    bool detached = true;          // no console; false: CREATE_NO_WINDOW (a hidden console)
    // Standard handles for the child (all or none); they must also be in the inherit list.
    HANDLE std_input = nullptr, std_output = nullptr, std_error = nullptr;
};

inline Result make_tokens(Tokens &out, bool restricted = true) {
    HANDLE raw = nullptr;
    if (!OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &raw))
        return failure("OpenProcessToken");
    Handle self(raw);
    auto user_buffer = token_information(self.get(), TokenUser);
    auto group_buffer = token_information(self.get(), TokenGroups);
    if (user_buffer.empty() || group_buffer.empty())
        return failure("GetTokenInformation");
    const auto user = reinterpret_cast<TOKEN_USER *>(user_buffer.data());
    const auto groups = reinterpret_cast<TOKEN_GROUPS *>(group_buffer.data());
    out.user_sid = sid_text(user->User.Sid);

    // Deny-only: the user and every group except Everyone, Users, Interactive and the logon
    // SID. Files that grant access to the user alone (the whole profile) then stay closed.
    std::vector<SID_AND_ATTRIBUTES> deny_only{{user->User.Sid, 0}};
    std::vector<SID_AND_ATTRIBUTES> same_access{{user->User.Sid, 0}};
    PSID logon = nullptr;
    for (DWORD i = 0; i < groups->GroupCount; i++) {
        const auto &group = groups->Groups[i];
        if (group.Attributes & SE_GROUP_INTEGRITY)
            continue;
        if (group.Attributes & SE_GROUP_ENABLED)
            same_access.push_back({group.Sid, 0});
        if (group.Attributes & SE_GROUP_LOGON_ID) {
            logon = group.Sid;
            continue;
        }
        if (IsWellKnownSid(group.Sid, WinWorldSid) ||
            IsWellKnownSid(group.Sid, WinBuiltinUsersSid) ||
            IsWellKnownSid(group.Sid, WinInteractiveSid))
            continue;
        deny_only.push_back({group.Sid, 0});
    }
    if (!logon)
        return {false, "The process token has no logon SID"};
    out.logon_sid = sid_text(logon);

    WellKnownSid world, users, restricted_code;
    if (!world.make(WinWorldSid) || !users.make(WinBuiltinUsersSid) ||
        !restricted_code.make(WinRestrictedCodeSid))
        return failure("CreateWellKnownSid");
    SID_AND_ATTRIBUTES restricting[] = {
        {world.sid(), 0}, {users.sid(), 0}, {restricted_code.sid(), 0}, {logon, 0}};
    HANDLE primary = nullptr;
    if (!CreateRestrictedToken(self.get(), DISABLE_MAX_PRIVILEGE,
                               restricted ? static_cast<DWORD>(deny_only.size()) : 0,
                               restricted ? deny_only.data() : nullptr, 0, nullptr,
                               restricted ? 4 : 0, restricted ? restricting : nullptr, &primary))
        return failure("CreateRestrictedToken (primary)");
    out.primary = Handle(primary);
    if (!set_low_integrity(primary))
        return failure("SetTokenInformation (primary integrity)");
    // Objects the child creates: SYSTEM, the logon session and restricted code only.
    Descriptor default_dacl(L"D:(A;;GA;;;SY)(A;;GA;;;" + out.logon_sid + L")(A;;GA;;;RC)");
    BOOL present = FALSE, defaulted = FALSE;
    PACL dacl = nullptr;
    if (!default_dacl.get() ||
        !GetSecurityDescriptorDacl(default_dacl.get(), &present, &dacl, &defaulted))
        return failure("Building the default DACL");
    TOKEN_DEFAULT_DACL token_dacl{dacl};
    if (!SetTokenInformation(primary, TokenDefaultDacl, &token_dacl, sizeof(token_dacl)))
        return failure("SetTokenInformation (default DACL)");

    HANDLE same = nullptr;
    if (!CreateRestrictedToken(self.get(), 0, 0, nullptr, 0, nullptr,
                               static_cast<DWORD>(same_access.size()), same_access.data(), &same))
        return failure("CreateRestrictedToken (initial)");
    Handle same_primary(same);
    HANDLE impersonation = nullptr;
    if (!DuplicateTokenEx(same_primary.get(),
                          TOKEN_IMPERSONATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, nullptr,
                          SecurityImpersonation, TokenImpersonation, &impersonation))
        return failure("DuplicateTokenEx (initial)");
    out.initial = Handle(impersonation);
    if (!set_low_integrity(impersonation))
        return failure("SetTokenInformation (initial integrity)");
    return {};
}

inline Result make_job(Handle &job) {
    job = Handle(CreateJobObjectW(nullptr, nullptr));
    if (!job)
        return failure("CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.JobMemoryLimit = static_cast<SIZE_T>(2) << 30;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits,
                                 sizeof(limits)))
        return failure("SetInformationJobObject (limits)");
    JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
    ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                             JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS |
                             JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD |
                             JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS |
                             JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
    if (!SetInformationJobObject(job.get(), JobObjectBasicUIRestrictions, &ui, sizeof(ui)))
        return failure("SetInformationJobObject (UI)");
    return {};
}

struct Launched {
    Handle process;
    Handle thread;
    Handle job;
    HDESK desktop = nullptr;
    DWORD pid = 0;
    std::wstring desktop_name;
    Launched() = default;
    Launched(const Launched &) = delete;
    Launched &operator=(const Launched &) = delete;
    ~Launched() {
        if (desktop)
            CloseDesktop(desktop);
    }
};

// Starts `executable` with `command_line` in the sandbox, inheriting exactly `inherit`.
inline Result launch(const std::wstring &executable, std::wstring command_line,
                     std::vector<HANDLE> inherit, Launched &out, const Options &options = {}) {
    Tokens tokens;
    if (auto result = make_tokens(tokens, options.restricted); !result.ok)
        return result;
    if (options.job)
        if (auto result = make_job(out.job); !result.ok)
            return result;

    // An alternate desktop, labelled low, that only this user's logon session can use.
    out.desktop_name = L"vidvnc-sandbox-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
                       std::to_wstring(GetTickCount64());
    Descriptor desktop_sd(L"D:(A;;GA;;;SY)(A;;GA;;;" + tokens.user_sid + L")(A;;GA;;;" +
                          tokens.logon_sid + L")S:(ML;;NW;;;LW)");
    if (!desktop_sd.get())
        return failure("Building the desktop security descriptor");
    SECURITY_ATTRIBUTES desktop_attributes{sizeof(desktop_attributes), desktop_sd.get(), FALSE};
    out.desktop = CreateDesktopW(out.desktop_name.c_str(), nullptr, nullptr, 0, GENERIC_ALL,
                                 &desktop_attributes);
    if (!out.desktop)
        return failure("CreateDesktop");
    std::wstring desktop = L"WinSta0\\" + out.desktop_name;
    if (!options.alternate_desktop) {
        CloseDesktop(out.desktop);
        out.desktop = nullptr;
        out.desktop_name = L"(the caller's)";
    }

    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 3, 0, &size);
    std::vector<BYTE> attribute_buffer(size);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_buffer.data());
    if (!InitializeProcThreadAttributeList(attributes, 3, 0, &size))
        return failure("InitializeProcThreadAttributeList");
    struct AttributeList {
        LPPROC_THREAD_ATTRIBUTE_LIST list;
        ~AttributeList() { DeleteProcThreadAttributeList(list); }
    } attribute_guard{attributes};
    DWORD child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    DWORD64 mitigations = PROCESS_CREATION_MITIGATION_POLICY_STRICT_HANDLE_CHECKS_ALWAYS_ON |
                          PROCESS_CREATION_MITIGATION_POLICY_EXTENSION_POINT_DISABLE_ALWAYS_ON |
                          PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_NO_REMOTE_ALWAYS_ON |
                          PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_NO_LOW_LABEL_ALWAYS_ON |
                          PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_PREFER_SYSTEM32_ALWAYS_ON;
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit.data(),
                                   inherit.size() * sizeof(HANDLE), nullptr, nullptr) ||
        !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,
                                   &child_policy, sizeof(child_policy), nullptr, nullptr) ||
        (options.mitigations &&
         !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
                                    &mitigations, sizeof(mitigations), nullptr, nullptr)))
        return failure("UpdateProcThreadAttribute");

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.lpDesktop = options.alternate_desktop ? desktop.data() : nullptr;
    if (options.std_input && options.std_output && options.std_error) {
        startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = options.std_input;
        startup.StartupInfo.hStdOutput = options.std_output;
        startup.StartupInfo.hStdError = options.std_error;
    }
    startup.lpAttributeList = attributes;
    // Only SYSTEM and the unrestricted user (this worker) may open the process and its
    // threads; another sandboxed process, whose user SID is deny-only, cannot.
    Descriptor object_sd(L"D:(A;;GA;;;SY)(A;;GA;;;" + tokens.user_sid + L")");
    if (!object_sd.get())
        return failure("Building the process security descriptor");
    SECURITY_ATTRIBUTES object_attributes{sizeof(object_attributes), object_sd.get(), FALSE};
    const auto security = options.object_security ? &object_attributes : nullptr;
    PROCESS_INFORMATION info{};
    if (!CreateProcessAsUserW(tokens.primary.get(), executable.c_str(), command_line.data(),
                              security, security, TRUE,
                              CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
                                  (options.detached ? DETACHED_PROCESS : CREATE_NO_WINDOW),
                              nullptr, nullptr, &startup.StartupInfo, &info))
        return failure("CreateProcessAsUser");
    out.process = Handle(info.hProcess);
    out.thread = Handle(info.hThread);
    out.pid = info.dwProcessId;
    HANDLE thread = info.hThread;
    const auto abandon = [&](const char *what) {
        auto result = failure(what);
        TerminateProcess(info.hProcess, 1);
        return result;
    };
    if (options.job && !AssignProcessToJobObject(out.job.get(), info.hProcess))
        return abandon("AssignProcessToJobObject");
    if (options.initial_token && !SetThreadToken(&thread, tokens.initial.get()))
        return abandon("SetThreadToken");
    if (ResumeThread(info.hThread) == static_cast<DWORD>(-1))
        return abandon("ResumeThread");
    return {};
}

} // namespace sandbox
