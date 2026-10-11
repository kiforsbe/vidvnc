using System.Text.Json;

namespace VidVnc.Host;

// Host window preferences. Presentation only: the server never reads this file.
internal sealed class HostPreferencesStore(string filename)
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    // KeepSharingOnClose: closing the window leaves sharing running behind the notification-area
    // icon. Off, closing the window stops sharing; VidVNC stays in the notification area either way.
    public sealed record Values(bool KeepSharingOnClose = true);

    public Values Load()
    {
        if (!File.Exists(filename)) return new();
        using var file = File.OpenRead(filename);
        if (file.Length > 4096) throw new InvalidDataException("Host settings file is too large.");
        return JsonSerializer.Deserialize<Values>(file, Json) ?? throw new InvalidDataException("Invalid host settings.");
    }

    public void Save(Values values)
    {
        var target = Path.GetFullPath(filename);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        var temporary = target + "." + Guid.NewGuid() + ".tmp";
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(file, values, Json); file.Flush(true);
            }
            File.Move(temporary, target, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
