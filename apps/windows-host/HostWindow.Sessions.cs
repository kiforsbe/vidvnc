using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    readonly TextBlock deviceTotal = Label("0", 28);
    readonly TextBlock streamTotal = Label("0", 28);
    readonly Grid sessionTotals = new() { ColumnSpacing = 12 };
    readonly FontIcon sharingDot = new() { Glyph = "\uEA3B", FontSize = 12 };

    static Brush ThemeStatusBrush(FrameworkElement element, string state)
    {
        // System semantic colors retain readable contrast in both application themes.
        var dark = element.ActualTheme == ElementTheme.Dark;
        var color = state switch
        {
            "success" => dark ? Windows.UI.Color.FromArgb(255, 108, 203, 95) : Windows.UI.Color.FromArgb(255, 15, 123, 15),
            "warning" => dark ? Windows.UI.Color.FromArgb(255, 252, 225, 0) : Windows.UI.Color.FromArgb(255, 157, 93, 0),
            _ => dark ? Windows.UI.Color.FromArgb(255, 180, 180, 180) : Windows.UI.Color.FromArgb(255, 95, 95, 95)
        };
        return new SolidColorBrush(color);
    }

    sealed class SessionVisual
    {
        public readonly TextBlock Title = Label("", 18);
        public readonly TextBlock Detail = Label("", 12);
        public readonly TextBlock Health = Label("", 12);
        public readonly TextBlock Audio = Label("", 12);
        public readonly TextBlock Control = Label("View only", 12);
        public readonly Button Permission = new() { Content = "Grant control", IsEnabled = false };
        public readonly FontIcon Icon = new() { Glyph = "\uE7F4", FontSize = 28 };
        public readonly StackPanel Actions = new() { Orientation = Orientation.Horizontal, Spacing = 12, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
        public readonly Expander Card;
        readonly StackPanel streams = new() { Spacing = 12 };
        readonly Dictionary<string, StreamVisual> streamRows = new();
        readonly Func<string, string?, Task> command;
        bool pending;

        public SessionVisual(Func<string, string?, Task> command)
        {
            this.command = command;
            Title.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
            var identity = new StackPanel { Spacing = HostSpacing.Small };
            identity.Children.Add(Title); identity.Children.Add(Detail);
            var badges = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 16 };
            badges.Children.Add(Health); badges.Children.Add(Audio); badges.Children.Add(Control); identity.Children.Add(badges);
            var header = new Grid { ColumnSpacing = 16, Padding = new Thickness(0, 8, 0, 8) };
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            header.Children.Add(Icon); Grid.SetColumn(identity, 1); header.Children.Add(identity);
            var body = new StackPanel { Spacing = HostSpacing.Row };
            Actions.Children.Add(Permission);
            Grid.SetColumn(Actions, 2); header.Children.Add(Actions);
            body.Children.Add(streams);
            Permission.Click += async (_, _) => {
                if (pending) return;
                pending = true; Permission.IsEnabled = false;
                try { await command(Control.Text == "Granted" ? "revoke" : "grant", null); }
                finally { pending = false; }
            };
            Card = new Expander { Header = header, Content = body, HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch, IsExpanded = true };
            Health.ActualThemeChanged += (_, _) => UpdateHealthBrush();
        }

        public void UpdateHealthBrush() => Health.Foreground = ThemeStatusBrush(Health,
            Health.Text == "Smooth" ? "success" : Health.Text is "Connection unstable" or "Playback struggling" ? "warning" : "neutral");

        public void UpdatePermission(JsonElement row, bool supported)
        {
            Control.Text = row.TryGetProperty("control", out var control) ? control.GetString() ?? "View only" : "View only";
            Permission.Content = Control.Text == "Granted" ? "Revoke control" : "Grant control";
            Permission.IsEnabled = supported && !pending && (Control.Text == "Granted" ||
                row.TryGetProperty("selectedStreamId", out var selected) && selected.ValueKind == JsonValueKind.String);
        }

        public void UpdateStreams(JsonElement rows)
        {
            var order = new List<StreamVisual>();
            int index = 0;
            foreach (var row in rows.EnumerateArray())
            {
                var id = row.TryGetProperty("id", out var streamId) ? streamId.GetString() : null;
                var key = id ?? $"legacy-{index}"; index++;
                if (!streamRows.TryGetValue(key, out var visual)) {
                    visual = new StreamVisual(id, command); streamRows.Add(key, visual);
                }
                visual.Update(row); order.Add(visual);
            }
            foreach (var key in streamRows.Keys.Where(key => !order.Contains(streamRows[key])).ToArray()) streamRows.Remove(key);
            if (!streams.Children.SequenceEqual(order.Select(row => row.Root))) {
                streams.Children.Clear(); foreach (var row in order) streams.Children.Add(row.Root);
            }
            if (streams.Children.Count == 0) streams.Children.Add(Label("Waiting for a display stream."));
        }
    }

    sealed class StreamVisual
    {
        public readonly Grid Root = new() { ColumnSpacing = 20, Padding = new Thickness(0, 8, 0, 8) };
        readonly TextBlock name = Label("", 16), resolution = Label(""), fps = Label(""), profile = Label(""), codec = Label(""), encoder = Label(""), mediaPath = Label("");
        readonly TextBlock shared = new() { FontSize = 12, Visibility = Visibility.Collapsed };
        readonly SessionGraph graph = new();
        public StreamVisual(string? id, Func<string, string?, Task> command)
        {
            Root.ColumnDefinitions.Add(new() { Width = new(1.35, GridUnitType.Star) });
            Root.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) });
            Root.RowDefinitions.Add(new() { Height = GridLength.Auto }); Root.RowDefinitions.Add(new() { Height = GridLength.Auto });
            var content = new StackPanel { Spacing = HostSpacing.Related };
            var header = new Grid { ColumnSpacing = HostSpacing.Related };
            header.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) }); header.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            header.Children.Add(name);
            var stop = new Button { Content = new FontIcon { Glyph = "\uE71A", FontSize = 14 }, IsEnabled = id is not null };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(stop, "Stop stream"); ToolTipService.SetToolTip(stop, "Stop stream");
            stop.Click += async (_, _) => { stop.IsEnabled = false; try { await command("stop-stream", id); } finally { stop.IsEnabled = id is not null; } };
            Grid.SetColumn(stop, 1); header.Children.Add(stop); content.Children.Add(header); content.Children.Add(shared);
            // One grid, so the rows share columns: Profile, then Resolution, Target FPS and Codec,
            // which size to their content while the profile name gets the rest. Beneath, Encoder
            // sits under Profile and Media from under Resolution, spanning to the end. The media
            // cell is capped at the width of those three columns, so a long (IPv6) address wraps
            // instead of widening them.
            static StackPanel Cell(string label, TextBlock value)
            {
                value.TextWrapping = TextWrapping.Wrap;
                var cell = new StackPanel { Spacing = HostSpacing.Small };
                cell.Children.Add(Label(label, 12)); cell.Children.Add(value);
                return cell;
            }
            const double valueSpacing = 16;
            var values = new Grid { ColumnSpacing = valueSpacing, RowSpacing = HostSpacing.Related };
            values.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) });
            for (var column = 1; column < 4; column++) values.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            values.RowDefinitions.Add(new() { Height = GridLength.Auto }); values.RowDefinitions.Add(new() { Height = GridLength.Auto });
            var media = Cell("Media from", mediaPath);
            media.MaxWidth = 160;
            foreach (var (cell, row, column, span) in new[] {
                (Cell("Profile", profile), 0, 0, 1), (Cell("Resolution", resolution), 0, 1, 1),
                (Cell("Target FPS", fps), 0, 2, 1), (Cell("Codec", codec), 0, 3, 1),
                (Cell("Encoder", encoder), 1, 0, 1), (media, 1, 1, 3) })
            {
                Grid.SetRow(cell, row); Grid.SetColumn(cell, column); Grid.SetColumnSpan(cell, span);
                values.Children.Add(cell);
            }
            // After any layout pass: the columns change when their values do, not only when the
            // card resizes. The cap never widens the columns, so this settles after one pass.
            values.LayoutUpdated += (_, _) =>
            {
                var width = values.ColumnDefinitions.Skip(1).Sum(column => column.ActualWidth) + 2 * valueSpacing;
                if (width > 0 && Math.Abs(media.MaxWidth - width) > 0.5) media.MaxWidth = width;
            };
            content.Children.Add(values);
            Root.Children.Add(content); Grid.SetColumn(graph, 1); Root.Children.Add(graph);
            Root.SizeChanged += (_, _) => {
                var narrow = Root.ActualWidth < 580;
                Grid.SetColumn(graph, narrow ? 0 : 1); Grid.SetRow(graph, narrow ? 1 : 0);
                Grid.SetColumnSpan(graph, narrow ? 2 : 1); Grid.SetColumnSpan(content, narrow ? 2 : 1);
                graph.Margin = new Thickness(0, narrow ? 12 : 0, 0, 0);
            };
        }
        // Rows without bitrateMode (or with null) render exactly as before.
        static string VariableSuffix(JsonElement row)
        {
            if (!row.TryGetProperty("bitrateMode", out var mode) || mode.ValueKind != JsonValueKind.String || mode.GetString() != "vbr") return "";
            var quality = row.TryGetProperty("quality", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            return string.IsNullOrEmpty(quality) ? " · Variable" : $" · Variable ({char.ToUpperInvariant(quality[0])}{quality[1..]})";
        }
        // Tooltip for the Profile value: the description, then W × H · N fps · bitrate · rate mode.
        // Members that are missing or null are skipped; null when nothing is known.
        static string? ProfileTooltip(JsonElement row)
        {
            static double? Number(JsonElement row, string key) =>
                row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;
            var lines = new List<string>();
            if (row.TryGetProperty("profileDescription", out var description) && description.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(description.GetString())) lines.Add(description.GetString()!);
            var details = new List<string>();
            if (Number(row, "width") is { } width && Number(row, "height") is { } height) details.Add($"{width} × {height}");
            if (Number(row, "targetFps") is { } targetFps) details.Add($"{targetFps} fps");
            var variable = VariableSuffix(row);
            if (Number(row, "targetBitrateKbps") is { } kbps) details.Add($"{(variable.Length > 0 ? "up to " : "")}{kbps / 1000.0:0.###} Mbit/s");
            if (variable.Length > 0) details.Add(variable[3..]);
            else if (row.TryGetProperty("bitrateMode", out var mode) && mode.ValueKind == JsonValueKind.String && mode.GetString() == "cbr") details.Add("Constant");
            if (details.Count > 0) lines.Add(string.Join(" · ", details));
            return lines.Count > 0 ? string.Join("\n", lines) : null;
        }
        public void Update(JsonElement row) {
            name.Text = row.GetProperty("name").GetString();
            resolution.Text = $"{row.GetProperty("width")} × {row.GetProperty("height")}";
            fps.Text = $"{row.GetProperty("targetFps")} fps"; profile.Text = row.GetProperty("profile").GetString() + VariableSuffix(row);
            ToolTipService.SetToolTip(profile, ProfileTooltip(row));
            codec.Text = CodecLabel(row.TryGetProperty("codec", out var codecValue) ? codecValue.GetString()! : "h264");
            var encoderLabel = row.TryGetProperty("encoder", out var encoderValue) && encoderValue.ValueKind == JsonValueKind.Object
                ? (encoderValue.TryGetProperty("label", out var label) ? label.GetString() : null) ?? "Unknown"
                : "Waiting for worker";
            encoder.Text = encoderLabel;
            // The authenticated media path through the relay; it can differ from the HTTPS address
            // (iCloud Private Relay, carrier-grade NAT), which is allowed but shown.
            var media = row.TryGetProperty("mediaAddress", out var mediaValue) && mediaValue.ValueKind == JsonValueKind.String
                ? mediaValue.GetString() : null;
            var differs = row.TryGetProperty("mediaDiffers", out var differsValue) && differsValue.ValueKind == JsonValueKind.True;
            mediaPath.Text = media is null ? "Waiting for the device" : differs ? $"{media} (differs from the sign-in address)" : media;
            // One capture/encode serves every device on the same display and profile.
            var viewers = row.TryGetProperty("viewers", out var count) && count.ValueKind == JsonValueKind.Number ? count.GetInt32() : 1;
            shared.Text = viewers > 1 ? $"Shared · {viewers} devices" : "";
            shared.Visibility = viewers > 1 ? Visibility.Visible : Visibility.Collapsed;
            graph.Update(row);
        }
    }
}
