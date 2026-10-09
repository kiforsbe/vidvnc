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
    let entry = "=== \(stamp) app pid \(getpid())\n\(text)\n"
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
