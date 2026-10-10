// MG3 prototype only (throwaway): a host-like app. It spawns the bundled Node.js running
// mg3-chain.mjs, which spawns the worker's --mg3 probe, so the process chain is the product's:
// app -> node -> media-worker. The result goes to ~/Library/Logs/VidVNC-MG3/run.log and an alert.
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let bundle = Bundle.main
let node = bundle.url(forAuxiliaryExecutable: "node")!
let worker = bundle.url(forAuxiliaryExecutable: "media-worker")!
let script = bundle.url(forResource: "mg3-chain", withExtension: "mjs")!
let logs = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/VidVNC-MG3")
try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)

// MG6: with MG_APP_LAN=<host>, the app process itself sends UDP to <host>:9 and connects TCP to
// <host>:80 before starting Node, and the result goes into the log.
var appLan = ""
if let host = ProcessInfo.processInfo.environment["MG_APP_LAN"] {
    func attempt(_ type: Int32, _ port: UInt16) -> String {
        let fd = socket(AF_INET, type, 0)
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        inet_pton(AF_INET, host, &address.sin_addr)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                type == SOCK_DGRAM
                    ? Int32(sendto(fd, "mg6", 3, 0, pointer, socklen_t(MemoryLayout<sockaddr_in>.size)))
                    : connect(fd, pointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result >= 0 ? (type == SOCK_DGRAM ? "sent" : "connected") : String(cString: strerror(errno))
    }
    appLan = "{\"test\":\"lan-app-process\",\"udp\":\"\(attempt(SOCK_DGRAM, 9))\",\"tcp\":\"\(attempt(SOCK_STREAM, 80))\"}\n"
}

let process = Process()
process.executableURL = node
process.arguments = [script.path]
var environment = ProcessInfo.processInfo.environment
environment["VIDVNC_MEDIA_WORKER"] = worker.path
process.environment = environment
let output = Pipe()
process.standardOutput = output
process.standardError = output
process.terminationHandler = { _ in
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let stamp = ISO8601DateFormatter().string(from: Date())
    let entry = "=== \(stamp) app pid \(getpid())\n\(appLan)\(text)\n"
    let file = logs.appendingPathComponent("run.log")
    if let handle = try? FileHandle(forWritingTo: file) {
        handle.seekToEndOfFile()
        handle.write(Data(entry.utf8))
        try? handle.close()
    } else {
        try? Data(entry.utf8).write(to: file)
    }
    DispatchQueue.main.async {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "VidVNC MG3 probe finished"
        alert.informativeText = text
        alert.runModal()
        NSApp.terminate(nil)
    }
}
try! process.run()
app.run()
