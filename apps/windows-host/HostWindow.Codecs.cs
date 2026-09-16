using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    // Duplicated from apps/server/src/video-codecs.mjs VIDEO_CODECS/CODEC_LABELS: this is a
    // language boundary (C# vs. JS), so the two tables are kept in sync by hand.
    static readonly string[] KnownVideoCodecs = ["av1", "h265", "h264"];

    // Missing/non-array "videoCodecs" (an older payload) falls back to the default order.
    static string[] VideoCodecOrder(JsonObject policy) =>
        policy["videoCodecs"] is JsonArray array
            ? array.Select(c => c!.GetValue<string>()).ToArray()
            : KnownVideoCodecs;

    static string CodecLabel(string codec) => codec switch
    {
        "av1" => "AV1",
        "h265" => "H.265",
        "h264" => "H.264",
        _ => codec,
    };

    async Task ChangeVideoCodec(string codec, bool? enabled, int move = 0)
    {
        try
        {
            if (streamPolicy is null || policySaving) return;
            var candidate = streamPolicy.DeepClone().AsObject();
            var codecs = VideoCodecOrder(candidate).ToList();
            if (move != 0)
            {
                int from = codecs.IndexOf(codec), to = from + move;
                if (from < 0 || to < 0 || to >= codecs.Count) return;
                (codecs[from], codecs[to]) = (codecs[to], codecs[from]);
            }
            else if (enabled is bool state)
            {
                if (state) { if (!codecs.Contains(codec)) { var index = codecs.IndexOf("h264"); codecs.Insert(index >= 0 ? index : codecs.Count, codec); } }
                else codecs.Remove(codec);
            }
            if (sessionCards.Count > 0 && !await ConfirmProfileApply("Apply codec change?")) return;
            candidate["videoCodecs"] = new JsonArray(codecs.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray());
            await SavePolicy(candidate, true);
        }
        catch (Exception error) { policyError = error.Message; }
        finally { if (currentPage == "Streaming profiles") RenderPage(); }
    }

    Grid VideoCodecRow(string codec, string[] enabledCodecs, bool separator)
    {
        bool isEnabled = enabledCodecs.Contains(codec);
        bool supported = hostCodecs.Contains(codec);
        bool isH264 = codec == "h264";
        var row = new Grid { Tag = "codec-row", ColumnSpacing = HostSpacing.Row,
            Padding = new Thickness(HostSpacing.Card, HostSpacing.Row, HostSpacing.Card, HostSpacing.Row) };
        if (separator) { row.BorderThickness = new Thickness(0, 1, 0, 0); row.BorderBrush = ResourceBrush("CardStrokeColorDefaultBrush"); }
        row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        var toggle = new ToggleSwitch { IsOn = isEnabled, OnContent = "", OffContent = "", MinWidth = 0,
            VerticalAlignment = VerticalAlignment.Center,
            IsEnabled = server is not null && !policySaving && !isH264 && (supported || isEnabled) };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(toggle, $"Use {CodecLabel(codec)}");
        toggle.Toggled += async (_, _) => await ChangeVideoCodec(codec, toggle.IsOn);
        row.Children.Add(toggle);
        var identity = new StackPanel { Spacing = HostSpacing.Small, VerticalAlignment = VerticalAlignment.Center };
        var name = Label(CodecLabel(codec), 16); name.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
        identity.Children.Add(name);
        identity.Children.Add(Secondary(!supported ? "Not supported by this GPU" : isH264 ? "Always on" : ""));
        Grid.SetColumn(identity, 1); row.Children.Add(identity);
        var menu = new MenuFlyout();
        foreach (var (text, delta) in new[] { ("Move up", -1), ("Move down", 1) })
        {
            var move = new MenuFlyoutItem { Text = text };
            menu.Opening += (_, _) =>
            {
                var current = streamPolicy!["videoCodecs"]!.AsArray().Select(c => c!.GetValue<string>()).ToArray();
                var from = Array.IndexOf(current, codec);
                move.IsEnabled = from >= 0 && from + delta >= 0 && from + delta < current.Length;
            };
            move.Click += async (_, _) => await ChangeVideoCodec(codec, null, delta);
            menu.Items.Add(move);
        }
        var more = new Button { Content = new FontIcon { Glyph = "\uE712", FontSize = 16 }, Flyout = menu,
            VerticalAlignment = VerticalAlignment.Center, IsEnabled = server is not null && !policySaving };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(more, $"Options for {CodecLabel(codec)}");
        Grid.SetColumn(more, 2); row.Children.Add(more);
        return row;
    }

    void RenderVideoCodecs()
    {
        if (streamPolicy is null) return;
        var content = new StackPanel { Spacing = HostSpacing.Related };
        content.Children.Add(Label("Video codecs", 20));
        content.Children.Add(Secondary("Each device uses the first enabled codec its browser can decode in hardware. H.264 is always available as the fallback."));
        var enabledCodecs = VideoCodecOrder(streamPolicy);
        var order = enabledCodecs.Concat(KnownVideoCodecs.Where(codec => !enabledCodecs.Contains(codec))).ToArray();
        var rows = new StackPanel { Spacing = 0 };
        for (int i = 0; i < order.Length; i++) rows.Children.Add(VideoCodecRow(order[i], enabledCodecs, i > 0));
        content.Children.Add(rows);
        var card = Card(content); card.Tag = "codec-card";
        page.Children.Add(card);
    }
}
