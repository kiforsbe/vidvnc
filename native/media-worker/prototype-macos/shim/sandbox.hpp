#pragma once
// MG1 prototype only: the part of sandbox.hpp that net-pipes.hpp uses (an owning handle).
#include <windows.h>

namespace sandbox {
class Handle {
    HANDLE handle_ = nullptr;

  public:
    Handle() = default;
    explicit Handle(HANDLE handle) : handle_(handle) {}
    Handle(const Handle &) = delete;
    Handle &operator=(const Handle &) = delete;
    Handle(Handle &&other) noexcept : handle_(other.handle_) { other.handle_ = nullptr; }
    Handle &operator=(Handle &&other) noexcept {
        if (this != &other) {
            reset();
            handle_ = other.handle_;
            other.handle_ = nullptr;
        }
        return *this;
    }
    ~Handle() { reset(); }
    HANDLE get() const { return handle_; }
    explicit operator bool() const { return handle_ != nullptr; }
    void reset() {
        if (handle_)
            CloseHandle(handle_);
        handle_ = nullptr;
    }
};
} // namespace sandbox
