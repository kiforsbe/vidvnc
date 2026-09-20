using System.Text.Json;
using System.Text.Json.Nodes;
using System.Collections.ObjectModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    JsonObject? streamPolicy;
    string? policyRequestId;
    TaskCompletionSource<JsonElement>? policyReply;
    bool policySaving;
    string? policyError;
    ProfileOrderStore profileOrder = new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VidVNC", "profile-order.json"));

    void SaveProfileOrder(IEnumerable<string> ids)
    {
        try { profileOrder.Save(ids); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            policyError = "Couldn't save profile display order: " + error.Message;
            if (currentPage == "Streaming profiles") RenderPage();
        }
    }

    void UpdatePolicy(JsonElement value)
    {
        streamPolicy = JsonNode.Parse(value.GetRawText())!.AsObject();
        displayDraft = null;
        if (currentPage is "Streaming profiles" or "Displays") RenderPage();
    }

    void ReceivePolicyResult(JsonElement value)
    {
        if (value.GetProperty("requestId").GetString() != policyRequestId) return;
        policyReply?.TrySetResult(value.Clone());
    }

    async Task SavePolicy(JsonObject candidate, bool confirmed)
    {
        var child = server;
        if (child is null || child.HasExited || streamPolicy is null) throw new InvalidOperationException("Start sharing before changing profiles.");
        if (policySaving) throw new InvalidOperationException("Another profile change is in progress.");
        policySaving = true; policyError = null;
        policyRequestId = Guid.NewGuid().ToString();
        policyReply = new(TaskCreationOptions.RunContinuationsAsynchronously);
        if (currentPage == "Streaming profiles") RenderPage();
        try
        {
            var message = new JsonObject { ["type"] = "policy-set", ["requestId"] = policyRequestId,
                ["revision"] = candidate["revision"]!.GetValue<long>(), ["policy"] = candidate.DeepClone(), ["disconnect"] = confirmed };
            await child.StandardInput.WriteLineAsync(message.ToJsonString());
            await child.StandardInput.FlushAsync();
            var reply = await policyReply.Task.WaitAsync(TimeSpan.FromSeconds(15));
            UpdatePolicy(reply.GetProperty("policy"));
            if (!reply.GetProperty("ok").GetBoolean()) throw new InvalidOperationException(reply.GetProperty("error").GetString());
        }
        finally
        {
            policySaving = false; policyReply = null; policyRequestId = null;
            if (currentPage == "Streaming profiles") RenderPage();
        }
    }

    async Task<bool> ConfirmProfileApply(string title)
    {
        if (dialogOpen) return false;
        dialogOpen = true;
        try
        {
            return await new ContentDialog { Title = title,
                Content = sessionCards.Count > 0 ? "Applying this change disconnects connected clients. They can reconnect with the updated settings." : "Apply these settings?",
                PrimaryButtonText = "Apply", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close,
                XamlRoot = navigation.XamlRoot }.ShowAsync() == ContentDialogResult.Primary;
        }
        finally { dialogOpen = false; }
    }

    async Task ChangeProfile(string id, bool? enabled)
    {
        try
        {
            if (streamPolicy is null || policySaving) return;
            var candidate = streamPolicy.DeepClone().AsObject();
            var rows = candidate["profiles"]!.AsArray();
            var profile = rows.Single(p => p!["id"]!.GetValue<string>() == id)!;
            if (enabled is null || sessionCards.Count > 0)
                if (!await ConfirmProfileApply(enabled is null ? "Remove profile?" : "Apply availability change?")) return;
            if (enabled is bool state) profile["enabled"] = state; else rows.Remove(profile);
            await SavePolicy(candidate, true);
        }
        catch (Exception error) { policyError = error.Message; }
        finally { if (currentPage == "Streaming profiles") RenderPage(); }
    }

    void RenderProfiles()
    {
        page.Children.Add(Secondary("Manage the profiles available to your clients."));
        var add = Command("＋ New profile", async () => await EditProfile(null, false));
        add.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        add.IsEnabled = streamPolicy is not null && server is not null && !policySaving;
        pageAction.Content = add;
        if (policyError is not null) page.Children.Add(new InfoBar { IsOpen = true, Severity = InfoBarSeverity.Error,
            IsClosable = false, Message = policyError });
        if (streamPolicy is null) { page.Children.Add(Card(Label("Profiles appear when the server is ready."))); return; }
        var list = new StackPanel();
        var sourceProfiles = streamPolicy["profiles"]!.AsArray().Select(p => p!.AsObject()).ToArray();
        var orderedIds = sourceProfiles.Select(p => p["id"]!.GetValue<string>()).ToArray();
        try { orderedIds = profileOrder.Apply(orderedIds); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidDataException)
        {
            page.Children.Add(new InfoBar { IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Warning,
                Message = "Couldn't load saved profile order. Using the original order. " + error.Message });
        }
        var rows = new ObservableCollection<Grid>();
        var rowIds = new Dictionary<Grid, string>();
        var profilesList = new ListView { Tag = "profile-list", ItemsSource = rows, CanDragItems = true,
            CanReorderItems = true, AllowDrop = true, SelectionMode = ListViewSelectionMode.None,
            HorizontalContentAlignment = HorizontalAlignment.Stretch };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(profilesList, "Streaming profiles. Drag rows to reorder.");
        var containerStyle = new Style(typeof(ListViewItem));
        containerStyle.Setters.Add(new Setter(Control.HorizontalContentAlignmentProperty, HorizontalAlignment.Stretch));
        containerStyle.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(0)));
        containerStyle.Setters.Add(new Setter(FrameworkElement.MarginProperty, new Thickness(0)));
        profilesList.ItemContainerStyle = containerStyle;
        profilesList.DragItemsCompleted += (_, _) => SaveProfileOrder(rows.Select(row => rowIds[row]));
        var headings = ProfileTableRow();
        foreach (var (text, column) in new[] { ("Profile", 1), ("Output size", 2), ("Frame rate", 3), ("Video bitrate", 4) })
        {
            var label = Secondary(text); label.TextWrapping = TextWrapping.NoWrap;
            Grid.SetColumn(label, column); headings.Children.Add(label);
        }
        list.Children.Add(headings);
        foreach (var orderedId in orderedIds)
        {
            var profile = sourceProfiles.Single(p => p["id"]!.GetValue<string>() == orderedId); var id = orderedId;
            var row = ProfileTableRow(); row.Tag = "profile-row";
            row.BorderThickness = new Thickness(0, 1, 0, 0); row.BorderBrush = ResourceBrush("CardStrokeColorDefaultBrush");
            var toggle = new ToggleSwitch { IsOn = profile["enabled"]!.GetValue<bool>(), OnContent = "", OffContent = "", MinWidth = 0,
                VerticalAlignment = VerticalAlignment.Center, IsEnabled = server is not null && !policySaving };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(toggle, $"Allow {profile["name"]!.GetValue<string>()}");
            toggle.Toggled += async (_, _) => await ChangeProfile(id, toggle.IsOn);
            row.Children.Add(toggle);
            var identity = new StackPanel { Spacing = HostSpacing.Small, VerticalAlignment = VerticalAlignment.Center };
            ToolTipService.SetToolTip(identity, "Drag to reorder profiles");
            var name = Label(profile["name"]!.GetValue<string>(), 16); name.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
            identity.Children.Add(name); identity.Children.Add(Secondary(profile["description"]!.GetValue<string>()));
            Grid.SetColumn(identity, 1); row.Children.Add(identity);
            var megabits = profile["bitrateKbps"]!.GetValue<int>() / 1000.0;
            var variableRate = ProfileBitrateMode(profile) == "vbr";
            var labels = new[] { $"{profile["width"]} × {profile["height"]}", $"{profile["fps"]} fps" };
            for (int i = 0; i < labels.Length; i++) {
                var label = Label(labels[i]); label.TextWrapping = TextWrapping.NoWrap; label.VerticalAlignment = VerticalAlignment.Center;
                Grid.SetColumn(label, i + 2); row.Children.Add(label);
            }
            // Two short lines instead of one long one: the rate, then the mode under it.
            var bitrateCell = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            var rateLine = Label(variableRate ? $"up to {megabits:0.###} Mbit/s" : $"{megabits:0.###} Mbit/s"); rateLine.TextWrapping = TextWrapping.NoWrap;
            var modeLine = Secondary(variableRate ? "Variable" : "Constant"); modeLine.TextWrapping = TextWrapping.NoWrap;
            bitrateCell.Children.Add(rateLine); bitrateCell.Children.Add(modeLine);
            Grid.SetColumn(bitrateCell, 4); row.Children.Add(bitrateCell);
            var menu = new MenuFlyout();
            foreach (var (text, glyph) in new[] { ("Edit", "\uE70F"), ("Duplicate", "\uE8C8"), ("Remove", "\uE74D") }) {
                if (text == "Remove") menu.Items.Add(new MenuFlyoutSeparator());
                var action = new MenuFlyoutItem { Text = text, Icon = new FontIcon { Glyph = glyph } };
                action.Click += async (_, _) => { if (text == "Remove") await ChangeProfile(id, null); else await EditProfile(profile, text == "Duplicate"); };
                menu.Items.Add(action);
            }
            menu.Items.Add(new MenuFlyoutSeparator());
            foreach (var (text, delta) in new[] { ("Move up", -1), ("Move down", 1) })
            {
                var move = new MenuFlyoutItem { Text = text };
                menu.Opening += (_, _) => move.IsEnabled = rows.IndexOf(row) + delta >= 0 && rows.IndexOf(row) + delta < rows.Count;
                move.Click += (_, _) =>
                {
                    int from = rows.IndexOf(row), to = from + delta;
                    if (from < 0 || to < 0 || to >= rows.Count) return;
                    rows.Move(from, to); SaveProfileOrder(rows.Select(r => rowIds[r]));
                };
                menu.Items.Add(move);
            }
            var more = new Button { Content = new FontIcon { Glyph = "\uE712", FontSize = 16 }, Flyout = menu,
                VerticalAlignment = VerticalAlignment.Center, IsEnabled = server is not null && !policySaving };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(more, $"Options for {profile["name"]!.GetValue<string>()}");
            Grid.SetColumn(more, 5); row.Children.Add(more);
            rowIds[row] = id; rows.Add(row);
        }
        list.Children.Add(profilesList);
        page.Children.Add(Card(new ScrollViewer { Content = list, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Enabled, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollMode = ScrollMode.Disabled }, 0));
        RenderClientCustomization();
        RenderVideoCodecs();
    }

    // Read defensively: a profile saved before these fields existed is Constant / Balanced.
    static string ProfileBitrateMode(JsonObject profile) =>
        profile["bitrateMode"] is JsonValue value && value.TryGetValue<string>(out var mode) && mode == "vbr" ? "vbr" : "cbr";

    static string ProfileQuality(JsonObject profile) =>
        profile["quality"] is JsonValue value && value.TryGetValue<string>(out var quality) && quality is "efficient" or "high" ? quality! : "balanced";

    static Grid ProfileTableRow()
    {
        var row = new Grid { MinWidth = 656, ColumnSpacing = HostSpacing.Row,
            Padding = new Thickness(HostSpacing.Card, HostSpacing.Row, HostSpacing.Card, HostSpacing.Row) };
        foreach (var width in new[] { new GridLength(44), new GridLength(1, GridUnitType.Star), new GridLength(100), new GridLength(72), new GridLength(120), new GridLength(40) })
            row.ColumnDefinitions.Add(new() { Width = width });
        return row;
    }

    // Dropdown row: "W × H" with the dim aspect ratio at the right. The edit box text comes from SizeChoice.ToString, not this template.
    static DataTemplate SizeChoiceTemplate() => (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("""
        <DataTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'>
          <Grid ColumnSpacing='16'>
            <Grid.ColumnDefinitions><ColumnDefinition Width='*'/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions>
            <TextBlock Text='{Binding Label}'/>
            <TextBlock Grid.Column='1' Text='{Binding Ratio}' Opacity='.6'/>
          </Grid>
        </DataTemplate>
        """);

    static TextBox? FindEditableText(DependencyObject root)
    {
        for (int i = 0; i < Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChild(root, i);
            if (child is TextBox box) return box;
            if (FindEditableText(child) is { } found) return found;
        }
        return null;
    }

    async Task EditProfile(JsonObject? source, bool duplicate)
    {
        if (dialogOpen || streamPolicy is null || policySaving) return;
        dialogOpen = true;
        try { await CreateProfileEditor(source, duplicate).ShowAsync(); }
        finally { dialogOpen = false; }
    }

    ContentDialog CreateProfileEditor(JsonObject? source, bool duplicate)
    {
        var candidate = streamPolicy!.DeepClone().AsObject();
        var profile = source?.DeepClone().AsObject() ?? new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["name"] = "", ["description"] = "",
            ["enabled"] = true, ["width"] = 1920, ["height"] = 1080, ["fps"] = 30, ["bitrateKbps"] = 4000, ["frameDelivery"] = "fixed",
            ["bitrateMode"] = "cbr", ["quality"] = "balanced" };
        if (duplicate) { profile["id"] = Guid.NewGuid().ToString(); profile["name"] = "Copy of " + profile["name"]!.GetValue<string>(); }
        var form = new StackPanel { Spacing = HostSpacing.Row, MinWidth = 320, MaxWidth = 520 };
        var name = new TextBox { Header = "Name", Text = profile["name"]!.GetValue<string>(), MaxLength = 64 };
        var description = new TextBox { Header = "Description", Text = profile["description"]!.GetValue<string>(), MaxLength = 240, TextWrapping = TextWrapping.Wrap };
        form.Children.Add(name); form.Children.Add(description);
        static Grid FieldRow(UIElement heading, Control input)
        {
            var row = new Grid { ColumnSpacing = HostSpacing.Card };
            row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) }); row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            Grid.SetColumn(input, 1); row.Children.Add(heading); row.Children.Add(input);
            return row;
        }
        // Output size: one editable dropdown of "W × H" presets, with the aspect ratio shown under its heading.
        var sizeChoices = ProfileInputs.SizePresets.Select(p => new SizeChoice(p.Width, p.Height)).ToList();
        var currentSize = new SizeChoice(profile["width"]!.GetValue<int>(), profile["height"]!.GetValue<int>());
        if (!sizeChoices.Contains(currentSize)) sizeChoices.Insert(0, currentSize);
        var size = new ComboBox { IsEditable = true, Width = 160, ItemsSource = sizeChoices, ItemTemplate = SizeChoiceTemplate(),
            SelectedIndex = sizeChoices.IndexOf(currentSize) };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(size, "Output size");
        var aspect = Secondary("");
        void ShowAspect(string? text) => aspect.Text = ProfileInputs.TryParseSize(text, out var w, out var h) && ProfileInputs.AspectRatio(w, h) is { Length: > 0 } ratio
            ? "Aspect ratio " + ratio : "Aspect ratio unknown";
        ShowAspect(currentSize.Label);
        size.SelectionChanged += (_, _) => { if (size.SelectedItem is SizeChoice choice) ShowAspect(choice.Label); };
        size.TextSubmitted += (_, args) => { args.Handled = true; ShowAspect(args.Text); };
        size.Loaded += (_, _) => { if (FindEditableText(size) is { } box) box.TextChanged += (_, _) => ShowAspect(box.Text); };   // live while typing
        form.Children.Add(FieldRow(new StackPanel { Spacing = HostSpacing.Small, VerticalAlignment = VerticalAlignment.Center, Children = { new TextBlock { Text = "Output size" }, aspect } }, size));
        // Frame rate: editable dropdown of common rates plus the profile's own value.
        var currentRate = profile["fps"]!.GetValue<int>();
        var rateChoices = ProfileInputs.FrameRatePresets.Append(currentRate).Distinct().Order().Select(r => r.ToString()).ToList();
        var fps = new ComboBox { IsEditable = true, Width = 160, ItemsSource = rateChoices, SelectedIndex = rateChoices.IndexOf(currentRate.ToString()) };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(fps, "Frame rate (fps)");
        fps.TextSubmitted += (_, args) => args.Handled = true;
        form.Children.Add(FieldRow(new TextBlock { Text = "Frame rate (fps)", VerticalAlignment = VerticalAlignment.Center }, fps));
        var bitrateHeading = new TextBlock { Text = "Video bitrate (kbit/s)", VerticalAlignment = VerticalAlignment.Center };
        var bitrate = new NumberBox { Value = profile["bitrateKbps"]!.GetValue<int>(), Minimum = 100, Maximum = 50000, Width = 160,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact, SmallChange = 100 };
        form.Children.Add(FieldRow(bitrateHeading, bitrate));
        var modeKeys = new[] { "cbr", "vbr" }; var qualityKeys = new[] { "efficient", "balanced", "high" };
        var bitrateMode = new ComboBox { Header = "Bitrate mode", ItemsSource = new[] { "Constant", "Variable" }, HorizontalAlignment = HorizontalAlignment.Stretch,
            SelectedIndex = Array.IndexOf(modeKeys, ProfileBitrateMode(profile)) };
        var quality = new ComboBox { Header = "Quality", ItemsSource = new[] { "Efficient", "Balanced", "High" }, HorizontalAlignment = HorizontalAlignment.Stretch,
            SelectedIndex = Array.IndexOf(qualityKeys, ProfileQuality(profile)) };
        void ApplyBitrateMode()
        {
            var variable = bitrateMode.SelectedIndex == 1;
            quality.IsEnabled = variable;
            var title = variable ? "Maximum sustained bitrate (kbit/s)" : "Video bitrate (kbit/s)";
            bitrateHeading.Text = title; Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(bitrate, title);
        }
        bitrateMode.SelectionChanged += (_, _) => ApplyBitrateMode();
        ApplyBitrateMode();
        var modeRow = new Grid { ColumnSpacing = HostSpacing.Card };
        modeRow.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) }); modeRow.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(quality, 1); modeRow.Children.Add(bitrateMode); modeRow.Children.Add(quality); form.Children.Add(modeRow);
        var available = new ToggleSwitch { Header = "Available to clients", IsOn = profile["enabled"]!.GetValue<bool>() }; form.Children.Add(available);
        var permission = new CheckBox { Content = "Disconnect connected clients when saving", Visibility = sessionCards.Count > 0 ? Visibility.Visible : Visibility.Collapsed };
        form.Children.Add(permission);
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = ResourceBrush("SystemFillColorCriticalBrush") }; form.Children.Add(error);
        var dialog = new ContentDialog { Title = source is null || duplicate ? "New profile" : "Edit profile", Content = new ScrollViewer { Content = form, MaxHeight = 520, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
            PrimaryButtonText = "Save", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary, XamlRoot = navigation.XamlRoot };
        dialog.PrimaryButtonClick += async (_, args) => {
            args.Cancel = true; var deferral = args.GetDeferral();
            try {
                if (string.IsNullOrWhiteSpace(name.Text)) throw new InvalidOperationException("Enter a profile name.");
                // Read the edit box itself: ComboBox.Text is only committed on Enter or focus loss.
                if (!ProfileInputs.TryParseSize(FindEditableText(size)?.Text ?? size.Text, out var width, out var height)) throw new InvalidOperationException("Enter the output size as width × height, for example 1920 × 1080.");
                if (width is < 64 or > 4096 || height is < 64 or > 4096) throw new InvalidOperationException("Output width and height must each be from 64 to 4096.");
                if (width % 2 != 0 || height % 2 != 0) throw new InvalidOperationException("Output width and height must be even.");
                if (!ProfileInputs.TryParseFrameRate(FindEditableText(fps)?.Text ?? fps.Text, out var rate) || rate is < 1 or > 60) throw new InvalidOperationException("Enter a frame rate from 1 to 60.");
                if (!double.IsFinite(bitrate.Value) || bitrate.Value != Math.Truncate(bitrate.Value)) throw new InvalidOperationException("Enter whole numbers for stream settings.");
                profile["width"] = width; profile["height"] = height; profile["fps"] = rate; profile["bitrateKbps"] = (int)bitrate.Value;
                profile["bitrateMode"] = modeKeys[bitrateMode.SelectedIndex]; profile["quality"] = qualityKeys[quality.SelectedIndex];
                profile["name"] = name.Text.Trim(); profile["description"] = description.Text.Trim(); profile["enabled"] = available.IsOn;
                var profiles = candidate["profiles"]!.AsArray();
                var previous = profiles.FirstOrDefault(p => p!["id"]!.GetValue<string>() == profile["id"]!.GetValue<string>());
                if (previous is null) profiles.Add(profile.DeepClone()); else profiles[profiles.IndexOf(previous)] = profile.DeepClone();
                await SavePolicy(candidate, permission.IsChecked == true);
                args.Cancel = false;
            } catch (Exception exception) { error.Text = exception.Message; }
            finally { deferral.Complete(); }
        };
        return dialog;
    }
}
