using System.Reflection;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Win32;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    // From the server's `ready` message: its own version and what it runs on (Node.js,
    // GStreamer). Kept after sharing stops; the installed components do not change meanwhile.
    Dictionary<string, string>? serverVersions;

    // The host's version as built: the csproj <Version>, plus the source commit when the build
    // recorded one ("0.10.0+1a2b3c4d..." becomes "0.10.0 (1a2b3c4)").
    static string HostVersion()
    {
        var informational = typeof(HostWindow).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(informational))
            return typeof(HostWindow).Assembly.GetName().Version?.ToString(3) ?? "unknown";
        var parts = informational.Split('+', 2);
        return parts.Length == 2 && parts[1].Length >= 7 ? $"{parts[0]} ({parts[1][..7]})" : parts[0];
    }

    // "25H2 (build 26200.1234)", from the registry values Settings → System → About shows.
    static string WindowsVersion()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            var display = key?.GetValue("DisplayVersion") as string;
            var build = key?.GetValue("CurrentBuildNumber") as string ?? Environment.OSVersion.Version.Build.ToString();
            var revision = key?.GetValue("UBR") is int ubr ? $".{ubr}" : "";
            return $"{(string.IsNullOrEmpty(display) ? "" : display + " ")}(build {build}{revision})";
        }
        catch (Exception error) when (error is System.Security.SecurityException or IOException or UnauthorizedAccessException)
        {
            return Environment.OSVersion.Version.ToString();
        }
    }

    // The last card of Settings: every component's version, and a button to copy them all for a
    // bug report.
    void RenderVersions()
    {
        string Server(string key) => serverVersions?.GetValueOrDefault(key) ?? (server is null ? "Start sharing to see" : "Not reported");
        var rows = new (string Name, string Value)[]
        {
            ("VidVNC", HostVersion()),
            ("Server", Server("server")),
            ("Node.js", Server("node")),
            ("GStreamer", Server("gstreamer")),
            (".NET", Environment.Version.ToString()),
            ("Windows", WindowsVersion()),
        };
        var content = new StackPanel { Spacing = HostSpacing.Related };
        content.Children.Add(Label("Versions", 16));
        var grid = new Grid { ColumnSpacing = 16, RowSpacing = HostSpacing.Small };
        grid.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        foreach (var (name, value) in rows)
        {
            grid.RowDefinitions.Add(new() { Height = GridLength.Auto });
            var label = Secondary(name);
            var text = Label(value);
            text.IsTextSelectionEnabled = true;
            Grid.SetRow(label, grid.RowDefinitions.Count - 1);
            Grid.SetRow(text, grid.RowDefinitions.Count - 1);
            Grid.SetColumn(text, 1);
            grid.Children.Add(label);
            grid.Children.Add(text);
        }
        content.Children.Add(grid);
        var copy = Command("Copy versions", () => Copy(string.Join(Environment.NewLine, rows.Select(row => $"{row.Name}: {row.Value}"))));
        copy.Tag = "copy-versions";
        content.Children.Add(copy);
        content.Children.Add(Secondary("Windows 11 25H2 or later · hardware video encoding"));
        page.Children.Add(Card(content));
    }
}
