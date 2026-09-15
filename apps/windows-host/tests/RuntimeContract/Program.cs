using System.Text.Json;
using VidVnc.Host;

try { if (await JobTests.RunMode(args)) return; }
catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; return; }
var root = Path.Combine(Path.GetTempPath(), "VidVNC host å " + Guid.NewGuid());
Directory.CreateDirectory(Path.Combine(root, "bin"));
Directory.CreateDirectory(Path.Combine(root, "plugins"));
try
{
    foreach (var file in new[] { "node.exe", "server.mjs", "worker.exe" })
        File.WriteAllText(Path.Combine(root, "bin", file), "fixture");
    var data = new Dictionary<string, object> {
        ["schemaVersion"] = 1, ["mode"] = "packaged", ["configuration"] = "Release", ["architecture"] = "x64",
        ["node"] = "bin/node.exe", ["server"] = "bin/server.mjs", ["worker"] = "bin/worker.exe",
        ["mediaBin"] = "bin", ["plugins"] = "plugins"
    };
    string Save() { var filename = Path.Combine(root, "runtime.json"); File.WriteAllText(filename, JsonSerializer.Serialize(data)); return filename; }
    void Check(bool condition, string label) { if (!condition) throw new Exception(label); Console.WriteLine("PASS " + label); }
    var orderFile = Path.Combine(root, "preferences", "profile-order.json");
    var orderStore = new ProfileOrderStore(orderFile);
    var sourceOrder = new[] { "mobile", "balanced", "desktop" };
    Check(orderStore.Apply(sourceOrder).SequenceEqual(sourceOrder), "missing cosmetic order preserves backend order");
    orderStore.Save(new[] { "desktop", "mobile", "balanced" });
    Check(new ProfileOrderStore(orderFile).Apply(sourceOrder).SequenceEqual(new[] { "desktop", "mobile", "balanced" }), "cosmetic order survives reopening");
    Check(sourceOrder.SequenceEqual(new[] { "mobile", "balanced", "desktop" }), "cosmetic order does not mutate backend order");
    Check(orderStore.Apply(new[] { "mobile", "desktop", "new-profile" }).SequenceEqual(new[] { "desktop", "mobile", "new-profile" }), "deleted profiles disappear and new profiles append");
    var savedOrder = File.ReadAllText(orderFile);
    bool duplicateRejected = false;
    try { orderStore.Save(new[] { "mobile", "mobile" }); } catch (InvalidDataException) { duplicateRejected = true; }
    Check(duplicateRejected && File.ReadAllText(orderFile) == savedOrder, "invalid reorder leaves saved preferences unchanged");
    var runtime = RuntimeManifest.Load(Save());
    Check(runtime.Worker == Path.Combine(root, "bin", "worker.exe"), "absolute Unicode/space worker path");
    var start = runtime.ServerStartInfo(inspect: true);
    Check(start.FileName == Path.Combine(root, "bin", "node.exe"), "bundled Node, not PATH lookup");
    Check(start.ArgumentList.SequenceEqual(new[] { Path.Combine(root, "bin", "server.mjs"), "--desktop" }), "packaged ignores inspector request");
    Check(start.Environment["VIDVNC_RUNTIME_MANIFEST"] == Path.Combine(root, "runtime.json"), "server inherits explicit manifest");
    foreach (var (field, value) in new (string, object)[] {
        ("schemaVersion", 2), ("configuration", "debug"), ("architecture", "arm64"), ("mode", "other"),
        ("worker", "../outside.exe"), ("worker", "C:\\outside.exe"), ("worker", "bin/missing.exe"),
        ("worker", "plugins"), ("plugins", "bin/node.exe"), ("node", "") })
    {
        var original = data[field]; data[field] = value;
        bool rejected = false;
        try { RuntimeManifest.Load(Save()); } catch (InvalidDataException e) { rejected = e.Message.Contains(field); }
        Check(rejected, "reject " + field + "=" + value); data[field] = original;
    }
    data["mode"] = "development"; data["configuration"] = "Debug";
    runtime = RuntimeManifest.Load(Save());
    Check(runtime.ServerStartInfo(inspect: true).ArgumentList[0] == "--inspect=127.0.0.1:9229", "development inspector is loopback only");
    Environment.SetEnvironmentVariable("NODE_OPTIONS", "--require foreign.js");
    data["mode"] = "packaged";
    Check(!RuntimeManifest.Load(Save()).ServerStartInfo().Environment.ContainsKey("NODE_OPTIONS"), "packaged strips Node injection");

    // Without a bundled node, the installed Node.js prerequisite runs the server.
    data.Remove("node");
    var installed = Path.Combine(root, "installed node");
    Directory.CreateDirectory(installed);
    File.Copy(Environment.ProcessPath!, Path.Combine(installed, "node.exe")); // version resource 1.0.0.0
    bool Rejects(Action action, string text) { try { action(); return false; } catch (PrerequisiteException e) { return e.Message.Contains(text); } }
    data["prerequisites"] = new Dictionary<string, object> { ["nodejs"] = new Dictionary<string, string> { ["name"] = "Node.js", ["minimumVersion"] = "1", ["download"] = "https://nodejs.org/" } };
    runtime = RuntimeManifest.Load(Save());
    Check(runtime.Node is null, "packaged manifest may omit node");
    Check(runtime.NodeExecutable(installed) == Path.Combine(installed, "node.exe"), "installed Node.js found on PATH");
    Check(Rejects(() => runtime.NodeExecutable(Path.GetRelativePath(Environment.CurrentDirectory, installed)), "Node.js 1 or newer"), "relative PATH entries are ignored");
    Check(Rejects(() => runtime.NodeExecutable(Path.Combine(root, "plugins")), "Install it from https://nodejs.org/"), "missing Node.js names the download");
    data["prerequisites"] = new Dictionary<string, object> { ["nodejs"] = new Dictionary<string, string> { ["name"] = "Node.js", ["minimumVersion"] = "24", ["download"] = "https://nodejs.org/" } };
    Check(Rejects(() => RuntimeManifest.Load(Save()).NodeExecutable(installed), "Node.js 24 or newer"), "too old Node.js is rejected");
    var vc = new Dictionary<string, string> { ["name"] = "Microsoft Visual C++ Redistributable (x64)", ["minimumVersion"] = "14.9999", ["download"] = "https://aka.ms/vc14/vc_redist.x64.exe" };
    data["prerequisites"] = new Dictionary<string, object> { ["vc-redist-x64"] = vc };
    Check(Rejects(() => RuntimeManifest.Load(Save()).CheckVisualCppRuntime(), "Redistributable (x64) 14.9999 or newer"), "newer VC++ runtime requirement is reported");
    vc["minimumVersion"] = "14.0";
    RuntimeManifest.Load(Save()).CheckVisualCppRuntime();
    Check(true, "installed VC++ runtime satisfies its minimum");
    data["prerequisites"] = new Dictionary<string, object> { ["nodejs"] = "Node.js" };
    bool invalid = false;
    try { RuntimeManifest.Load(Save()); } catch (InvalidDataException e) { invalid = e.Message.Contains("prerequisites"); }
    Check(invalid, "reject malformed prerequisites");
    await JobTests.VerifyCleanup();
}
catch (Exception error)
{
    Console.Error.WriteLine("FAIL RuntimeContract: " + error);
    Environment.ExitCode = 1;
}
finally { Directory.Delete(root, recursive: true); }
