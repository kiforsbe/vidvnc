using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    sealed record DisplayInfo(string Id, string Name, bool Primary, int X, int Y, int Width, int Height, int? Refresh, bool Persistent);
    DisplayInfo[] displayInventory = [];
    string? selectedDisplay;
    JsonObject? displayDraft;
    Button? applyDisplays;

    JsonObject DisplayDraft() => displayDraft ??= streamPolicy!.DeepClone().AsObject();
    void DisplayChanged() { if (applyDisplays is not null) applyDisplays.IsEnabled = !policySaving; }
    ComboBox DisplayProfileChoice(string? displayId)
    {
        var draft = DisplayDraft();
        var combo = new ComboBox { MinWidth = 190, HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center, IsEnabled = !policySaving };
        combo.Items.Add(new ComboBoxItem { Content = displayId is null ? "Automatic" : "Use host default", Tag = "auto" });
        foreach (var profile in draft["profiles"]!.AsArray().Where(p => p!["enabled"]!.GetValue<bool>()))
            combo.Items.Add(new ComboBoxItem { Content = profile!["name"]!.GetValue<string>(), Tag = profile["id"]!.GetValue<string>() });
        var selected = displayId is null ? draft["defaultProfileId"]!.GetValue<string>() : draft["displayDefaults"]?[displayId]?.GetValue<string>() ?? "auto";
        combo.SelectedItem = combo.Items.Cast<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == selected) ?? combo.Items[0];
        combo.SelectionChanged += (_, _) => {
            var id = (string)((ComboBoxItem)combo.SelectedItem).Tag;
            if (displayId is null) draft["defaultProfileId"] = id;
            else if (id == "auto") draft["displayDefaults"]!.AsObject().Remove(displayId);
            else draft["displayDefaults"]![displayId] = id;
            DisplayChanged();
        };
        return combo;
    }
    static Grid DisplaySetting(string title, FrameworkElement editor, string? subtitle = null)
    {
        var row = new Grid { ColumnSpacing = HostSpacing.Card,
            Padding = new Thickness(HostSpacing.Card, HostSpacing.Row, HostSpacing.Card, HostSpacing.Row) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var label = new StackPanel { Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        label.Children.Add(Label(title, 18));
        if (subtitle is not null) label.Children.Add(Secondary(subtitle));
        row.Children.Add(label);
        editor.HorizontalAlignment = HorizontalAlignment.Right; editor.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(editor, 1); row.Children.Add(editor);
        return row;
    }
    static Border DisplaySeparator() => new() { Height = 1, Background = ResourceBrush("CardStrokeColorDefaultBrush") };
    async Task ApplyDisplaySettings()
    {
        if (displayDraft is null || policySaving || !await ConfirmProfileApply("Apply display settings?")) return;
        var candidate = displayDraft;
        try { await SavePolicy(candidate, true); displayDraft = null; }
        catch (Exception error) { displayDraft = candidate; policyError = error.Message; }
        finally { RenderPage(); }
    }

    void UpdateDisplays(JsonElement inventory)
    {
        CloseIdentify();
        displayInventory = inventory.EnumerateArray().Select(d => new DisplayInfo(
            d.GetProperty("id").GetString()!, d.GetProperty("name").GetString()!, d.GetProperty("primary").GetBoolean(),
            d.GetProperty("x").GetInt32(), d.GetProperty("y").GetInt32(), d.GetProperty("width").GetInt32(),
            d.GetProperty("height").GetInt32(), d.TryGetProperty("refreshHz", out var hz) && hz.ValueKind == JsonValueKind.Number ? hz.GetInt32() : null,
            d.TryGetProperty("persistent", out var persistent) && persistent.GetBoolean()))
            .Where(d => d.Width > 0 && d.Height > 0).OrderByDescending(d => d.Primary).ThenBy(d => d.X).ToArray();
        if (!displayInventory.Any(d => d.Id == selectedDisplay)) selectedDisplay = displayInventory.FirstOrDefault()?.Id;
        if (currentPage is "Displays" or "Overview") RenderPage();
    }

    void RenderDisplays(bool overview = false)
    {
        if (displayInventory.Length == 0)
        {
            page.Children.Add(Card(Label("Display inventory appears when the server starts.")));
            return;
        }
        page.Children.Add(Secondary("Your screens, arranged as they are on your desktop.", 16));
        if (streamPolicy is null) { page.Children.Add(Label("Waiting for host settings…")); return; }
        var draft = DisplayDraft();
        if (policyError is not null) page.Children.Add(new InfoBar { IsOpen = true, IsClosable = false,
            Severity = InfoBarSeverity.Error, Message = policyError });
        pageAction.Content = Command("Identify displays", IdentifyDisplays);
        var map = new Canvas { Height = 160, HorizontalAlignment = HorizontalAlignment.Stretch };
        var tiles = new List<Button>();
        var rows = new List<Expander>();
        void Select(string id)
        {
            selectedDisplay = id;
            for (var i = 0; i < tiles.Count; i++)
            {
                bool selected = displayInventory[i].Id == id;
                tiles[i].BorderThickness = new Thickness(selected ? 2 : 1);
                tiles[i].BorderBrush = ResourceBrush(selected ? "AccentFillColorDefaultBrush" : "CardStrokeColorDefaultBrush");
                rows[i].IsExpanded = selected;
            }
        }
        for (var i = 0; i < displayInventory.Length; i++)
        {
            var display = displayInventory[i];
            var number = i + 1;
            var tile = new Button { Content = MonitorArt(display, number, false), Padding = new Thickness(2),
                HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(tile, $"Display {number}, {display.Name}, {display.Width} by {display.Height}");
            ToolTipService.SetToolTip(tile, $"{display.Name} · {display.Width} × {display.Height}");
            tile.Click += (_, _) =>
            {
                Select(display.Id);
                if (overview) OpenDisplays();
            };
            tiles.Add(tile); map.Children.Add(tile);
            var identity = new StackPanel { Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
            var nameRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, VerticalAlignment = VerticalAlignment.Center };
            nameRow.Children.Add(Label(display.Primary ? "Main display" : display.Height > display.Width ? "Portrait display" : display.Name, 18));
            if (display.Primary)
            {
                var badge = Label("Primary", 12);
                badge.Foreground = ResourceBrush("AccentTextFillColorPrimaryBrush");
                nameRow.Children.Add(new Border { Child = badge, Padding = new Thickness(8, 2, 8, 2),
                    CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1),
                    BorderBrush = ResourceBrush("AccentFillColorDefaultBrush"), VerticalAlignment = VerticalAlignment.Center });
            }
            identity.Children.Add(nameRow);
            identity.Children.Add(Secondary($"{display.Width} × {display.Height} · {(display.Refresh is int hz ? $"{hz} Hz" : "Refresh rate unavailable")}"));
            var details = new StackPanel { Spacing = 0 };
            details.Children.Add(DisplaySetting("Default profile", DisplayProfileChoice(display.Id)));
            details.Children.Add(DisplaySeparator());
            details.Children.Add(DisplaySetting("Allowed profiles", new ComboBox { IsEnabled = false, MinWidth = 190,
                Items = { "All host-approved profiles" }, SelectedIndex = 0 }));
            var rowHeader = new Grid { ColumnSpacing = HostSpacing.Card, VerticalAlignment = VerticalAlignment.Center,
                Padding = new Thickness(0, HostSpacing.Row, 0, HostSpacing.Row) };
            rowHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            rowHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var displayIdentity = IconRow("\uE7F4", identity);
            displayIdentity.VerticalAlignment = VerticalAlignment.Center;
            rowHeader.Children.Add(displayIdentity);
            var permission = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12,
                HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            permission.Children.Add(new TextBlock { Text = "Sharing", VerticalAlignment = VerticalAlignment.Center });
            var sharingSwitch = new ToggleSwitch { IsOn = draft["displaySharing"]?[display.Id]?.GetValue<bool>() == true,
                OnContent = "", OffContent = "", MinWidth = 0, HorizontalAlignment = HorizontalAlignment.Right,
                IsEnabled = !policySaving && display.Persistent, VerticalAlignment = VerticalAlignment.Center };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(sharingSwitch, $"Sharing for display {number}");
            sharingSwitch.Toggled += (_, _) => { draft["displaySharing"] ??= new JsonObject();
                draft["displaySharing"]![display.Id] = sharingSwitch.IsOn; DisplayChanged(); };
            permission.Children.Add(sharingSwitch);
            Grid.SetColumn(permission, 1); rowHeader.Children.Add(permission);
            var row = new Expander { Header = rowHeader, Content = details, HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Center };
            row.Expanding += (_, _) => Select(display.Id);
            rows.Add(row);
        }
        void Arrange()
        {
            var left = displayInventory.Min(d => (double)d.X); var top = displayInventory.Min(d => (double)d.Y);
            var width = displayInventory.Max(d => (double)d.X + d.Width) - left;
            var height = displayInventory.Max(d => (double)d.Y + d.Height) - top;
            // Cap the artwork, not an empty container. The surrounding card
            // supplies the only inset, including for portrait/negative layouts.
            var scale = Math.Min(Math.Max(1, map.ActualWidth) / width, 160 / height);
            var contentHeight = height * scale;
            if (Math.Abs(map.Height - contentHeight) > .01) map.Height = contentHeight;
            var offsetX = (map.ActualWidth - width * scale) / 2;
            for (var i = 0; i < tiles.Count; i++)
            {
                var display = displayInventory[i];
                tiles[i].Width = Math.Max(1, display.Width * scale - 4);
                tiles[i].Height = Math.Max(1, display.Height * scale - 4);
                Canvas.SetLeft(tiles[i], offsetX + (display.X - left) * scale);
                Canvas.SetTop(tiles[i], (display.Y - top) * scale);
            }
        }
        map.SizeChanged += (_, _) => Arrange();
        page.Children.Add(Card(map));
        Select(selectedDisplay ?? displayInventory[0].Id);
        if (overview)
        {
            page.Children.Add(Command("Manage displays", OpenDisplays));
            return;
        }
        foreach (var row in rows) page.Children.Add(row);
        page.Children.Add(Label("Host defaults", 20));
        var settings = new StackPanel { Spacing = 0 };
        settings.Children.Add(DisplaySetting("Default profile", DisplayProfileChoice(null)));
        settings.Children.Add(DisplaySeparator());
        var audio = new ToggleSwitch { IsOn = draft["allowAudio"]!.GetValue<bool>(),
            OnContent = "On", OffContent = "Off", MinWidth = 0, IsEnabled = !policySaving };
        audio.Toggled += (_, _) => { draft["allowAudio"] = audio.IsOn; DisplayChanged(); };
        settings.Children.Add(DisplaySetting("Desktop audio", audio, "Allow system audio to be shared"));
        page.Children.Add(Card(settings, inset: 0));
        page.Children.Add(Command("Manage streaming profiles", () => navigation.SelectedItem =
            navigation.MenuItems.OfType<NavigationViewItem>().Single(item => item.Tag as string == "Streaming profiles")));
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = HostSpacing.Related };
        actions.Children.Add(Command("Cancel", () => { displayDraft = null; policyError = null; RenderPage(); }));
        applyDisplays = Command("Apply", async () => await ApplyDisplaySettings());
        applyDisplays.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        applyDisplays.IsEnabled = !policySaving && !JsonNode.DeepEquals(displayDraft, streamPolicy);
        actions.Children.Add(applyDisplays);
        displayActions.Content = actions;
    }

    void OpenDisplays() => navigation.SelectedItem = navigation.MenuItems.OfType<NavigationViewItem>()
        .Single(item => item.Tag as string == "Displays");
}
