using System.Globalization;
using System.Text.RegularExpressions;

namespace VidVnc.Host;

// One entry of the Output size dropdown. Label is the edit-box text, Ratio the dim text beside it in the list.
sealed record SizeChoice(int Width, int Height)
{
    public string Label => ProfileInputs.FormatSize(Width, Height);
    public string Ratio => ProfileInputs.AspectRatio(Width, Height);
    public override string ToString() => Label;
}

// Pure parsing and formatting for the profile editor's editable size and frame rate boxes.
static partial class ProfileInputs
{
    // Grouped by aspect family, largest first within a family.
    public static readonly (int Width, int Height)[] SizePresets =
    [
        (3840, 2160), (2560, 1440), (1920, 1080), (1600, 900), (1366, 768), (1280, 720), (960, 540), (854, 480), // 16:9
        (2560, 1600), (1920, 1200), (1680, 1050),                                                              // 16:10
        (2560, 1080), (3440, 1440),                                                                            // 21:9
        (1024, 768),                                                                                           // 4:3
    ];

    public static readonly int[] FrameRatePresets = [15, 24, 30, 60];

    static readonly (string Name, double Value)[] CommonRatios =
        [("16:9", 16.0 / 9), ("16:10", 16.0 / 10), ("4:3", 4.0 / 3), ("21:9", 21.0 / 9), ("3:2", 3.0 / 2), ("5:4", 5.0 / 4), ("1:1", 1), ("9:16", 9.0 / 16), ("3:4", 3.0 / 4)];

    // Ratios that reduce to something other than the name people know them by.
    static readonly Dictionary<string, string> ReducedNames = new() { ["8:5"] = "16:10", ["7:3"] = "21:9" };

    [GeneratedRegex(@"^\s*(\d{1,9})\s*[x×*]\s*(\d{1,9})\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SizePattern();

    public static string FormatSize(int width, int height) => $"{width} × {height}";

    // Accepts W×H, WxH, W x H, W*H and W X H with any spacing. Range and parity are the caller's job.
    public static bool TryParseSize(string? text, out int width, out int height)
    {
        width = height = 0;
        var match = SizePattern().Match(text ?? "");
        return match.Success
            && int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out width)
            && int.TryParse(match.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out height);
    }

    // Whole number only; the 1 to 60 range is the caller's job.
    public static bool TryParseFrameRate(string? text, out int fps) =>
        int.TryParse(text?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out fps);

    // A:B when it reduces to small terms, else the nearest common ratio within 1% (prefixed with ≈), else N.NN:1.
    public static string AspectRatio(int width, int height)
    {
        if (width <= 0 || height <= 0) return "";
        var divisor = Gcd(width, height);
        int a = width / divisor, b = height / divisor;
        if (a <= 32 && b <= 32) return ReducedNames.GetValueOrDefault($"{a}:{b}", $"{a}:{b}");
        var ratio = (double)width / height;
        var (name, value) = CommonRatios.MinBy(r => Math.Abs(ratio / r.Value - 1));
        return Math.Abs(ratio / value - 1) <= 0.01 ? "≈ " + name : ratio.ToString("0.00", CultureInfo.InvariantCulture) + ":1";
    }

    static int Gcd(int a, int b) { while (b != 0) (a, b) = (b, a % b); return a; }
}
