using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    // Owned by one session card. No timers, WebView, or retained disconnected sessions.
    sealed class SessionGraph : StackPanel
    {
        readonly Canvas plot = new() { Height = 52, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        readonly TextBlock state = Label("Last 60 s", 11);
        readonly TextBlock empty = Label("Waiting for telemetry", 12);
        readonly TextBlock scale = Label("30 fps", 10);
        JsonElement data;
        double target = 30;
        static SolidColorBrush Color(byte r, byte g, byte b) => new(Windows.UI.Color.FromArgb(255, r, g, b));
        readonly Brush capture = Color(124, 184, 255), encode = Color(114, 222, 192), decode = Color(220, 170, 255);
        readonly Brush drop = Color(245, 180, 55), freeze = Color(245, 85, 85), recovery = Color(85, 160, 255);

        public SessionGraph()
        {
            Spacing = 3;
            HorizontalAlignment = HorizontalAlignment.Stretch;
            var header = new Grid();
            header.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            header.Children.Add(Label("Connection stability", 13));
            Grid.SetColumn(state, 1); header.Children.Add(state); Children.Add(header);
            var legend = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            foreach (var (text, brush) in new[] { ("━ Capture", capture), ("┄ Encode", encode), ("·· Decode", decode) })
            {
                var label = Label(text, 11); label.Foreground = brush; legend.Children.Add(label);
            }
            Children.Add(legend);
            var surface = new Grid(); surface.Children.Add(plot);
            empty.HorizontalAlignment = HorizontalAlignment.Center; empty.VerticalAlignment = VerticalAlignment.Center;
            surface.Children.Add(empty); Children.Add(surface);
            var axis = new Grid(); axis.ColumnDefinitions.Add(new() { Width = new(1, GridUnitType.Star) });
            axis.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            axis.Children.Add(Label("−60 s", 10)); var now = Label("now", 10); Grid.SetColumn(now, 1); axis.Children.Add(now);
            Children.Add(axis);
            var events = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
            foreach (var (text, brush) in new[] { ("▲ Drop", drop), ("■ Freeze", freeze), ("◆ Recovery", recovery) })
            { var label = Label(text, 10); label.Foreground = brush; events.Children.Add(label); }
            Children.Add(events);
            plot.SizeChanged += (_, _) => Draw();
            ActualThemeChanged += (_, _) => { ApplyTheme(); Draw(); };
            Loaded += (_, _) => { ApplyTheme(); Draw(); };
            ToolTipService.SetToolTip(legend, "Frames per second: server capture and encode versus browser decode. Same measurements as Diagnostics.");
            ToolTipService.SetToolTip(events, "Reported frame drops, freezes, and PLI/FIR recovery requests. A request is not proof of successful recovery.");
            plot.PointerMoved += (_, e) => Describe(e.GetCurrentPoint(plot).Position.X);
            plot.Tapped += (_, e) => {
                Describe(e.GetPosition(plot).X);
                var text = ToolTipService.GetToolTip(plot) as string;
                if (text is not null) new Flyout { Content = Label(text, 12) }.ShowAt(plot);
            };
        }

        void ApplyTheme()
        {
            bool dark = ActualTheme == ElementTheme.Dark;
            foreach (var (brush, darkColor, lightColor) in new[] {
                (capture, 0x7cb8ff, 0x0067c0), (encode, 0x72dec0, 0x007c65), (decode, 0xdcaaff, 0x7a35a8),
                (drop, 0xf5b437, 0x9d5d00), (freeze, 0xf55555, 0xc42b1c), (recovery, 0x55a0ff, 0x005fb8) })
            {
                int rgb = dark ? darkColor : lightColor;
                ((SolidColorBrush)brush).Color = Windows.UI.Color.FromArgb(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);
            }
        }

        static double? Number(JsonElement row, string name) => row.ValueKind == JsonValueKind.Object &&
            row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number &&
            value.TryGetDouble(out var number) && double.IsFinite(number) && number >= 0 ? number : null;
        JsonElement[] Rows(string key) => data.ValueKind == JsonValueKind.Object && data.TryGetProperty(key, out var rows) &&
            rows.ValueKind == JsonValueKind.Array ? rows.EnumerateArray().TakeLast(76).ToArray() : [];
        public void Update(JsonElement row)
        {
            data = row.ValueKind == JsonValueKind.Object && row.TryGetProperty("stability", out var graph) ? graph.Clone() : default;
            target = Number(row, "targetFps") ?? 30;
            Draw();
        }
        void Draw()
        {
            plot.Children.Clear();
            var generated = Rows("generated"); var received = Rows("points");
            var at = Number(data, "at") ?? 0;
            bool any = generated.Any(p => Number(p, "captureFps") is not null || Number(p, "encodeFps") is not null) || received.Any(p => Number(p, "fps") is not null);
            empty.Visibility = any ? Visibility.Collapsed : Visibility.Visible;
            var stale = data.ValueKind != JsonValueKind.Object ||
                (data.TryGetProperty("stale", out var c) && c.ValueKind == JsonValueKind.True) ||
                (data.TryGetProperty("serverStale", out var s) && s.ValueKind == JsonValueKind.True);
            state.Text = any && stale ? "Samples stale" : "Last 60 s";
            var width = Math.Max(1, plot.ActualWidth);
            var max = Math.Max(1, Math.Max(target, generated.SelectMany(p => new[] { Number(p, "captureFps") ?? 0, Number(p, "encodeFps") ?? 0 })
                .Concat(received.Select(p => Number(p, "fps") ?? 0)).DefaultIfEmpty(0).Max()) * 1.1);
            double X(double time) => Math.Clamp((time - at + 60000) / 60000, 0, 1) * width;
            double Y(double fps) => 50 - Math.Clamp(fps / max, 0, 1) * 40;
            var baseline = new Line { X1 = 0, X2 = width, Y1 = 50, Y2 = 50, Stroke = ResourceBrush("CardStrokeColorDefaultBrush"), StrokeThickness = 1 };
            plot.Children.Add(baseline);
            plot.Children.Add(new Line { X1 = 0, X2 = width, Y1 = Y(target), Y2 = Y(target), Stroke = ResourceBrush("TextFillColorTertiaryBrush"),
                StrokeThickness = 1, StrokeDashArray = new DoubleCollection { 3, 4 } });
            scale.Text = $"{target:0} fps"; Canvas.SetTop(scale, Math.Max(0, Y(target) - 13)); plot.Children.Add(scale);
            foreach (var (rows, key, brush, dash) in new[] {
                (generated, "captureFps", capture, new double[0]), (generated, "encodeFps", encode, new[] { 4.0, 2.0 }),
                (received, "fps", decode, new[] { 1.0, 2.0 }) })
            {
                JsonElement previous = default;
                foreach (var row in rows)
                {
                    var value = Number(row, key); var time = Number(row, "at");
                    if (value is null || time is null) { previous = default; continue; }
                    var oldTime = Number(previous, "at"); var oldValue = Number(previous, key);
                    if (oldTime is double t && oldValue is double v && time > t && time - t < 5000)
                    {
                        var line = new Line { X1 = X(t), X2 = X(time.Value), Y1 = Y(v), Y2 = Y(value.Value), Stroke = brush, StrokeThickness = 1.6 };
                        foreach (var d in dash) line.StrokeDashArray.Add(d);
                        plot.Children.Add(line);
                    }
                    else { var dot = new Ellipse { Width = 3, Height = 3, Fill = brush }; Canvas.SetLeft(dot, X(time.Value) - 1.5); Canvas.SetTop(dot, Y(value.Value) - 1.5); plot.Children.Add(dot); }
                    previous = row;
                }
            }
            foreach (var row in received)
            {
                var time = Number(row, "at"); if (time is null) continue;
                foreach (var (key, symbol, brush, y) in new[] { ("drops", "▲", drop, 0.0), ("freezes", "■", freeze, 12.0), ("recovery", "◆", recovery, 24.0) })
                {
                    if (!(Number(row, key) > 0)) continue;
                    var text = DescribeSample(row, at);
                    var button = new Button { Content = symbol, Foreground = brush, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                        BorderThickness = new Thickness(0), Padding = new Thickness(0), MinWidth = 0, MinHeight = 0, Width = 16, Height = 16, FontSize = 11 };
                    Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, text);
                    ToolTipService.SetToolTip(button, text);
                    button.Click += (_, _) => new Flyout { Content = Label(text, 12) }.ShowAt(button);
                    Canvas.SetLeft(button, Math.Clamp(X(time.Value) - 8, 0, Math.Max(0, width - 16))); Canvas.SetTop(button, y); plot.Children.Add(button);
                }
            }
        }
        static string F(double? n) => n is double v ? v.ToString("0.#") : "—";
        static string DescribeSample(JsonElement row, double now) => row.ValueKind != JsonValueKind.Object ? "No browser sample near this time." :
            $"Reported {Math.Max(0, (now - (Number(row, "at") ?? now)) / 1000):0} s ago · interval {F(Number(row, "intervalMs") / 1000)} s\nDecode: {F(Number(row, "fps"))} fps\n" +
            $"Frame drops: {F(Number(row, "drops"))} · Freezes: {F(Number(row, "freezes"))}\nRecovery requests: {F(Number(row, "recovery"))}\n" +
            $"Packets lost: {F(Number(row, "lost"))} · RTT: {F(Number(row, "rttMs"))} ms · Jitter: {F(Number(row, "jitterMs"))} ms";
        void Describe(double x)
        {
            var now = Number(data, "at") ?? 0;
            var time = now - 60000 + Math.Clamp(x / Math.Max(1, plot.ActualWidth), 0, 1) * 60000;
            JsonElement Near(string key) => Rows(key).Where(p => Math.Abs((Number(p, "at") ?? 0) - time) < 2500)
                .OrderBy(p => Math.Abs((Number(p, "at") ?? 0) - time)).FirstOrDefault();
            var source = Near("generated"); var receiver = Near("points");
            ToolTipService.SetToolTip(plot, $"Capture: {F(Number(source, "captureFps"))} fps · Encode: {F(Number(source, "encodeFps"))} fps\n" + DescribeSample(receiver, now));
        }
    }
}
