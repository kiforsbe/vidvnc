using System.Diagnostics;
using System.Text.Json;
using Microsoft.Win32;

namespace VidVnc.Host;

public sealed record Prerequisite(string Name, string MinimumVersion, string Download);

// Thrown when a declared prerequisite is missing; the message tells the user what to install.
public sealed class PrerequisiteException(string message) : InvalidOperationException(message);

public sealed record RuntimeManifest(string Filename, string Root, string Mode, string Configuration,
    string? Node, string Server, string Worker, string MediaBin, string Plugins, string? Scanner,
    IReadOnlyDictionary<string, Prerequisite> Prerequisites)
{
    public static RuntimeManifest Load(string filename)
    {
        filename = Path.GetFullPath(filename);
        try
        {
            var root = ResolvePhysical(Path.GetDirectoryName(filename)!);
            using var document = JsonDocument.Parse(File.ReadAllText(filename));
            var data = document.RootElement;
            string Text(string field, JsonElement? parent = null)
            {
                if (!(parent ?? data).TryGetProperty(field, out var value) || value.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(value.GetString())) throw new InvalidDataException($"Invalid runtime manifest {field}");
                return value.GetString()!;
            }
            string Choice(string field, params string[] choices)
            {
                var value = Text(field);
                if (!choices.Contains(value)) throw new InvalidDataException($"Invalid runtime manifest {field}");
                return value;
            }
            if (data.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Runtime manifest must be an object");
            if (!data.TryGetProperty("schemaVersion", out var schema) || !schema.TryGetInt32(out var version) || version != 1)
                throw new InvalidDataException("Invalid runtime manifest schemaVersion");
            var mode = Choice("mode", "packaged", "development");
            var configuration = Choice("configuration", "Debug", "Release");
            Choice("architecture", "x64");
            string Location(string field, bool directory = false)
            {
                try
                {
                    var value = Text(field);
                    if (mode == "packaged" && (Path.IsPathRooted(value) || value.Contains(':')))
                        throw new InvalidDataException("absolute paths are not permitted");
                    var full = Path.GetFullPath(value, root);
                    if (mode == "packaged" && !Contains(root, full)) throw new InvalidDataException("path escapes package");
                    var resolved = ResolvePhysical(full);
                    if (mode == "packaged" && !Contains(root, resolved)) throw new InvalidDataException("resolved path escapes package");
                    if (directory ? !Directory.Exists(resolved) : !File.Exists(resolved))
                        throw new InvalidDataException($"expected an existing {(directory ? "directory" : "file")}");
                    return resolved;
                }
                catch (Exception error) when (error is IOException or InvalidDataException or ArgumentException or UnauthorizedAccessException)
                { throw new InvalidDataException($"Invalid runtime manifest {field}: {error.Message}", error); }
            }
            var prerequisites = new Dictionary<string, Prerequisite>();
            if (data.TryGetProperty("prerequisites", out var declared))
            {
                if (declared.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Invalid runtime manifest prerequisites");
                foreach (var item in declared.EnumerateObject())
                {
                    if (item.Value.ValueKind != JsonValueKind.Object) throw new InvalidDataException($"Invalid runtime manifest prerequisites {item.Name}");
                    prerequisites[item.Name] = new(Text("name", item.Value), Text("minimumVersion", item.Value), Text("download", item.Value));
                }
            }
            // No node means the installed Node.js prerequisite runs the server.
            return new(filename, root, mode, configuration, data.TryGetProperty("node", out _) ? Location("node") : null,
                Location("server"), Location("worker"), Location("mediaBin", true), Location("plugins", true),
                data.TryGetProperty("scanner", out _) ? Location("scanner") : null, prerequisites);
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        { throw new InvalidDataException($"Cannot load runtime manifest {filename}: {error.Message}", error); }
    }

    static bool Contains(string root, string candidate)
    {
        var relative = Path.GetRelativePath(root, candidate);
        return relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar) && !Path.IsPathRooted(relative);
    }

    // Resolve every ancestor, not just the final file: a parent directory can be a junction.
    static string ResolvePhysical(string full)
    {
        var current = Path.GetPathRoot(full)!;
        foreach (var part in full[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (info.LinkTarget is not null) current = info.ResolveLinkTarget(true)!.FullName;
        }
        return current;
    }

    static string Missing(Prerequisite prerequisite) =>
        $"VidVNC needs {prerequisite.Name} {prerequisite.MinimumVersion} or newer. Install it from {prerequisite.Download}, then try again.";

    // The bundled Node.js, else node.exe from absolute PATH entries only (never the current directory).
    public string NodeExecutable(string? searchPath = null)
    {
        if (Node is not null) return Node;
        var declared = Prerequisites.GetValueOrDefault("nodejs") ?? new Prerequisite("Node.js", "24", "https://nodejs.org/");
        var node = (searchPath ?? Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(Path.IsPathFullyQualified)
            .Select(directory => Path.Combine(directory, "node.exe"))
            .FirstOrDefault(File.Exists) ?? throw new PrerequisiteException(Missing(declared));
        if (FileVersionInfo.GetVersionInfo(node).FileMajorPart < int.Parse(declared.MinimumVersion.Split('.')[0]))
            throw new PrerequisiteException(Missing(declared));
        return node;
    }

    public void CheckVisualCppRuntime()
    {
        if (!OperatingSystem.IsWindows() || Prerequisites.GetValueOrDefault("vc-redist-x64") is not { } declared) return;
        var minimum = int.Parse(declared.MinimumVersion.Split('.')[1]);
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var runtime = machine.OpenSubKey(@"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64");
            if (runtime?.GetValue("Minor") is int minor && minor >= minimum) return;
        }
        throw new PrerequisiteException(Missing(declared));
    }

    public ProcessStartInfo ServerStartInfo(bool inspect = false)
    {
        CheckVisualCppRuntime();
        var start = new ProcessStartInfo(NodeExecutable()) { WorkingDirectory = Root, UseShellExecute = false,
            CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        if (Mode == "packaged")
        {
            foreach (var key in start.Environment.Keys.ToArray())
                if (key.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase) ||
                    key.StartsWith("GST", StringComparison.OrdinalIgnoreCase) ||
                    key.Equals("VIDVNC_MEDIA_WORKER", StringComparison.OrdinalIgnoreCase) ||
                    key.Equals("VIDVNC_LOG_DIR", StringComparison.OrdinalIgnoreCase)) start.Environment.Remove(key);
        }
        else if (inspect) start.ArgumentList.Add("--inspect=127.0.0.1:9229");
        start.Environment["VIDVNC_RUNTIME_MANIFEST"] = Filename;
        start.ArgumentList.Add(Server);
        start.ArgumentList.Add("--desktop");
        return start;
    }

    // The server's offline settings command (`main.mjs config …`), with the same Node and
    // environment as the server. It edits the saved settings while sharing is off and refuses
    // while a server is running.
    public ProcessStartInfo ConfigStartInfo(IEnumerable<string> arguments)
    {
        var start = ServerStartInfo();
        start.ArgumentList.Remove("--desktop");
        start.ArgumentList.Add("config");
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        return start;
    }
}
