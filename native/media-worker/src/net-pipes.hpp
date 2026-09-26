#pragma once
// Pipes between the media worker and media-net, and the threads that use them. Anonymous
// pipes: they have no name, so nothing else can open or squat them, and media-net receives
// only its ends, through an explicit inherited-handle list (sandbox.hpp). All I/O is blocking
// on dedicated threads; the worker's GLib main loop only queues, and never waits on a pipe.
#include <windows.h>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include "net-records.hpp"
#include "sandbox.hpp"

namespace net_pipes {

// One direction. `parent` stays with the worker; `child` is inheritable and goes to media-net.
struct Pipe {
    sandbox::Handle parent, child;
};
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

inline bool write_all(HANDLE handle, const void *data, std::size_t size) {
    auto bytes = static_cast<const char *>(data);
    while (size) {
        DWORD written = 0;
        const auto chunk = static_cast<DWORD>(size > (1u << 30) ? (1u << 30) : size);
        if (!WriteFile(handle, bytes, chunk, &written, nullptr) || !written)
            return false;
        bytes += written;
        size -= written;
    }
    return true;
}

inline bool read_exact(HANDLE handle, void *data, std::size_t size) {
    auto bytes = static_cast<char *>(data);
    while (size) {
        DWORD received = 0;
        const auto chunk = static_cast<DWORD>(size > (1u << 30) ? (1u << 30) : size);
        if (!ReadFile(handle, bytes, chunk, &received, nullptr) || !received)
            return false;
        bytes += received;
        size -= received;
    }
    return true;
}

// Reads newline-terminated lines until the pipe ends or a line is too long; returns false in
// the second case, so the caller can treat it as a protocol violation.
inline bool read_lines(HANDLE handle, const std::function<void(std::string)> &line,
                       std::size_t max_line = net_records::max_control_line) {
    std::string buffered;
    char chunk[8192];
    for (;;) {
        DWORD received = 0;
        if (!ReadFile(handle, chunk, sizeof(chunk), &received, nullptr) || !received)
            return true;
        buffered.append(chunk, received);
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
    HANDLE handle_ = nullptr;
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
    QueuedWriter(HANDLE handle, std::size_t budget, std::function<void()> on_broken)
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
