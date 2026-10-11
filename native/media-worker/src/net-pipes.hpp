#pragma once
// Pipes between the media worker and media-net, and the threads that use them. Anonymous
// pipes: they have no name, so nothing else can open or squat them, and media-net receives
// only its ends. On Windows those go through an explicit inherited-handle list (sandbox.hpp);
// on macOS every descriptor is close-on-exec and the launcher maps exactly the four child ends
// into media-net (design D2). All I/O is blocking on dedicated threads; the worker's GLib main
// loop only queues, and never waits on a pipe.
#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#endif
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include "net-records.hpp"
#ifdef _WIN32
#include "sandbox.hpp"
#endif

namespace net_pipes {

#ifdef _WIN32
// A pipe end as the operating system names it: a handle on Windows, a descriptor elsewhere.
using Native = HANDLE;
using Handle = sandbox::Handle;
inline Native from_number(std::uint64_t value) {
    return reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(value));
}
inline std::uint64_t to_number(Native value) {
    return static_cast<std::uint64_t>(reinterpret_cast<ULONG_PTR>(value));
}
#else
using Native = int;
class Handle {
    int value_ = -1;

  public:
    Handle() = default;
    explicit Handle(int value) : value_(value) {}
    Handle(const Handle &) = delete;
    Handle &operator=(const Handle &) = delete;
    Handle(Handle &&other) noexcept : value_(other.value_) { other.value_ = -1; }
    Handle &operator=(Handle &&other) noexcept {
        if (this != &other) {
            reset();
            value_ = other.value_;
            other.value_ = -1;
        }
        return *this;
    }
    ~Handle() { reset(); }
    void reset() {
        if (value_ >= 0)
            close(value_);
        value_ = -1;
    }
    int get() const { return value_; }
    explicit operator bool() const { return value_ >= 0; }
};
inline Native from_number(std::uint64_t value) {
    return value <= 0x7fffffff ? static_cast<int>(value) : -1;
}
inline std::uint64_t to_number(Native value) { return static_cast<std::uint64_t>(value); }
#endif

// One direction. `parent` stays with the worker; `child` goes to media-net.
struct Pipe {
    Handle parent, child;
};
#ifdef _WIN32
// `to_child`: the worker writes, media-net reads. Otherwise the reverse.
inline bool make_pipe(Pipe &pipe, bool to_child, DWORD buffer = 1 << 20) {
    SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
    HANDLE read = nullptr, write = nullptr;
    if (!CreatePipe(&read, &write, &inheritable, buffer))
        return false;
    pipe.parent = sandbox::Handle(to_child ? write : read);
    pipe.child = sandbox::Handle(to_child ? read : write);
    return SetHandleInformation(pipe.parent.get(), HANDLE_FLAG_INHERIT, 0) != FALSE;
}
#else
// `to_child`: the worker writes, media-net reads. Otherwise the reverse. Both ends are
// close-on-exec; the launcher maps the child's end into media-net explicitly. A write to a
// pipe whose reader is gone fails with EPIPE instead of raising SIGPIPE. macOS pipes have a
// fixed buffer, so `buffer` is accepted for the same call sites and otherwise unused.
inline bool make_pipe(Pipe &pipe, bool to_child, std::size_t buffer = 1 << 20) {
    (void)buffer;
    int fds[2];
    if (::pipe(fds) != 0)
        return false;
    pipe.parent = Handle(to_child ? fds[1] : fds[0]);
    pipe.child = Handle(to_child ? fds[0] : fds[1]);
    // The no-SIGPIPE flag belongs to the open pipe, so it holds in media-net too.
    return fcntl(fds[0], F_SETFD, FD_CLOEXEC) == 0 && fcntl(fds[1], F_SETFD, FD_CLOEXEC) == 0 &&
           fcntl(fds[1], F_SETNOSIGPIPE, 1) == 0;
}
#endif

// One read or write of at most `size` bytes: the count, 0 at the end of the pipe, or -1.
#ifdef _WIN32
inline long long write_some(Native handle, const void *data, std::size_t size) {
    DWORD written = 0;
    const auto chunk = static_cast<DWORD>(size > (1u << 30) ? (1u << 30) : size);
    if (!WriteFile(handle, data, chunk, &written, nullptr))
        return -1;
    return written;
}
inline long long read_some(Native handle, void *data, std::size_t size) {
    DWORD received = 0;
    const auto chunk = static_cast<DWORD>(size > (1u << 30) ? (1u << 30) : size);
    if (!ReadFile(handle, data, chunk, &received, nullptr))
        return -1;
    return received;
}
#else
inline long long write_some(Native fd, const void *data, std::size_t size) {
    for (;;) {
        const auto written = ::write(fd, data, size > (1u << 30) ? (1u << 30) : size);
        if (written < 0 && errno == EINTR)
            continue;
        return written;
    }
}
inline long long read_some(Native fd, void *data, std::size_t size) {
    for (;;) {
        const auto received = ::read(fd, data, size > (1u << 30) ? (1u << 30) : size);
        if (received < 0 && errno == EINTR)
            continue;
        return received;
    }
}
#endif

inline bool write_all(Native handle, const void *data, std::size_t size) {
    auto bytes = static_cast<const char *>(data);
    while (size) {
        const auto written = write_some(handle, bytes, size);
        if (written <= 0)
            return false;
        bytes += written;
        size -= static_cast<std::size_t>(written);
    }
    return true;
}

inline bool read_exact(Native handle, void *data, std::size_t size) {
    auto bytes = static_cast<char *>(data);
    while (size) {
        const auto received = read_some(handle, bytes, size);
        if (received <= 0)
            return false;
        bytes += received;
        size -= static_cast<std::size_t>(received);
    }
    return true;
}

// Reads newline-terminated lines until the pipe ends or a line is too long; returns false in
// the second case, so the caller can treat it as a protocol violation.
inline bool read_lines(Native handle, const std::function<void(std::string)> &line,
                       std::size_t max_line = net_records::max_control_line) {
    std::string buffered;
    char chunk[8192];
    for (;;) {
        const auto received = read_some(handle, chunk, sizeof(chunk));
        if (received <= 0)
            return true;
        buffered.append(chunk, static_cast<std::size_t>(received));
        std::size_t start = 0, newline;
        while ((newline = buffered.find('\n', start)) != std::string::npos) {
            line(buffered.substr(start, newline - start));
            start = newline + 1;
        }
        buffered.erase(0, start);
        if (buffered.size() > max_line)
            return false;
    }
}

// A writer thread with a bounded queue. `push` never blocks; it returns false when the queue
// would exceed its byte budget, and the caller decides what that means.
class QueuedWriter {
    Native handle_;
    std::size_t budget_;
    std::mutex mutex_;
    std::condition_variable ready_;
    std::deque<std::string> queue_;
    std::size_t queued_ = 0;
    bool closing_ = false, broken_ = false;
    std::function<void()> on_broken_;
    std::thread thread_;

    void run() {
        for (;;) {
            std::string record;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                ready_.wait(lock, [&] { return closing_ || !queue_.empty(); });
                if (queue_.empty())
                    return;
                record = std::move(queue_.front());
                queue_.pop_front();
                queued_ -= record.size();
            }
            if (!write_all(handle_, record.data(), record.size())) {
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    broken_ = true;
                    queue_.clear();
                    queued_ = 0;
                }
                if (on_broken_)
                    on_broken_();
                return;
            }
        }
    }

  public:
    QueuedWriter(Native handle, std::size_t budget, std::function<void()> on_broken)
        : handle_(handle), budget_(budget), on_broken_(std::move(on_broken)),
          thread_([this] { run(); }) {}
    QueuedWriter(const QueuedWriter &) = delete;
    QueuedWriter &operator=(const QueuedWriter &) = delete;
    ~QueuedWriter() { close(); }

    bool push(std::string record) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (closing_ || broken_ || queued_ + record.size() > budget_)
                return false;
            queued_ += record.size();
            queue_.push_back(std::move(record));
        }
        ready_.notify_one();
        return true;
    }
    std::size_t queued() {
        std::lock_guard<std::mutex> lock(mutex_);
        return queued_;
    }
    // Drops everything not yet written; used to skip to the next keyframe on overflow.
    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        queue_.clear();
        queued_ = 0;
    }
    // Writes what is queued, then stops. A blocked write ends when the other side closes.
    void close() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            closing_ = true;
        }
        ready_.notify_one();
        if (thread_.joinable()) {
            if (thread_.get_id() == std::this_thread::get_id())
                thread_.detach();
            else
                thread_.join();
        }
    }
};

} // namespace net_pipes
