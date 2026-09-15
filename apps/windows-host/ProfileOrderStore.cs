using System.Text.Json;

namespace VidVnc.Host;

// Presentation only: never written into the server's stream-policy document.
internal sealed class ProfileOrderStore(string filename)
{
    public string[] Apply(IEnumerable<string> source)
    {
        var current = source.ToArray();
        if (!File.Exists(filename)) return current;
        using var file = File.OpenRead(filename);
        if (file.Length > 16384) throw new InvalidDataException("Profile ordering file is too large.");
        var saved = JsonSerializer.Deserialize<string[]>(file) ?? throw new InvalidDataException("Invalid profile ordering.");
        Validate(saved);
        var available = current.ToHashSet(StringComparer.Ordinal);
        return saved.Where(available.Contains).Concat(current.Where(id => !saved.Contains(id, StringComparer.Ordinal))).ToArray();
    }

    public void Save(IEnumerable<string> order)
    {
        var ids = order.ToArray(); Validate(ids);
        var target = Path.GetFullPath(filename);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        var temporary = target + "." + Guid.NewGuid() + ".tmp";
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(file, ids); file.Flush(true);
            }
            File.Move(temporary, target, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    static void Validate(string[] ids)
    {
        if (ids.Length > 64 || ids.Distinct(StringComparer.Ordinal).Count() != ids.Length ||
            ids.Any(id => string.IsNullOrEmpty(id) || id.Length > 64 || id.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-')))
            throw new InvalidDataException("Invalid profile ordering.");
    }
}
