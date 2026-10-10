// MG8 prototype only (throwaway): the host stub of a notarizable bundle. It runs the bundled
// server Node on Resources/mg8-check.mjs, which checks every bundled component, and shows the
// result (also in ~/Library/Logs/VidVNC-MG8/run.log).
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let bundle = Bundle.main
let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/VidVNC-MG8")
try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)

let process = Process()
process.executableURL = bundle.url(forAuxiliaryExecutable: "node")!
process.arguments = [bundle.url(forResource: "mg8-check", withExtension: "mjs")!.path]
process.currentDirectoryURL = URL(fileURLWithPath: "/")
let output = Pipe()
process.standardOutput = output
process.standardError = output
process.terminationHandler = { _ in
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let entry = "=== \(ISO8601DateFormatter().string(from: Date())) \(bundle.bundlePath)\n\(text)\n"
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
        alert.messageText = "VidVNC MG8 check finished"
        alert.informativeText = text
        alert.runModal()
        NSApp.terminate(nil)
    }
}
try! process.run()
app.run()
