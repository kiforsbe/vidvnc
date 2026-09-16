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
            var labels = new[] { $"{profile["width"]} × {profile["height"]}", $"{profile["fps"]} fps", $"{profile["bitrateKbps"]!.GetValue<int>() / 1000.0:0.###} Mbit/s" };
            for (int i = 0; i < labels.Length; i++) {
                var label = Label(labels[i]); label.TextWrapping = TextWrapping.NoWrap; label.VerticalAlignment = VerticalAlignment.Center;
                Grid.SetColumn(label, i + 2); row.Children.Add(label);
            }
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

    static Grid ProfileTableRow()
    {
        var row = new Grid { MinWidth = 620, ColumnSpacing = HostSpacing.Row,
            Padding = new Thickness(HostSpacing.Card, HostSpacing.Row, HostSpacing.Card, HostSpacing.Row) };
        foreach (var width in new[] { new GridLength(44), new GridLength(1, GridUnitType.Star), new GridLength(100), new GridLength(72), new GridLength(84), new GridLength(40) })
            row.ColumnDefinitions.Add(new() { Width = width });
        return row;
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
            ["enabled"] = true, ["width"] = 1920, ["height"] = 1080, ["fps"] = 30, ["bitrateKbps"] = 4000, ["frameDelivery"] = "fixed" };
        if (duplicate) { profile["id"] = Guid.NewGuid().ToString(); profile["name"] = "Copy of " + profile["name"]!.GetValue<string>(); }
        var form = new StackPanel { Spacing = HostSpacing.Row, MinWidth = 320, MaxWidth = 520 };
        var name = new TextBox { Header = "Name", Text = profile["name"]!.GetValue<string>(), MaxLength = 64 };
        var description = new TextBox { Header = "Description", Text = profile["description"]!.GetValue<string>(), MaxLength = 240, TextWrapping = TextWrapping.Wrap };
        form.Children.Add(name); form.Children.Add(description);
        var numbers = new Dictionary<string, NumberBox>();
        foreach (var (key, title, min, max) in new[] { ("width", "Output width", 64, 4096), ("height", "Output height", 64, 4096), ("fps", "Frame rate (fps)", 1, 60), ("bitrateKbps", "Video bitrate (kbit/s)", 100, 50000) }) {
            var row = new Grid { ColumnSpacing = HostSpacing.Card };
            row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) }); row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            row.Children.Add(new TextBlock { Text = title, VerticalAlignment = VerticalAlignment.Center });
            var input = new NumberBox { Value = profile[key]!.GetValue<int>(), Minimum = min, Maximum = max, Width = 160,
                SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact, SmallChange = key is "width" or "height" ? 2 : key == "bitrateKbps" ? 100 : 1 };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(input, title);
            numbers[key] = input; Grid.SetColumn(input, 1); row.Children.Add(input); form.Children.Add(row);
        }
        var fixedMode = new RadioButton { Content = "Fixed", IsChecked = true };
        form.Children.Add(fixedMode); form.Children.Add(Pending(new RadioButton { Content = "Variable" }, "Variable frame delivery"));
        var available = new ToggleSwitch { Header = "Available to clients", IsOn = profile["enabled"]!.GetValue<bool>() }; form.Children.Add(available);
        var permission = new CheckBox { Content = "Disconnect connected clients when saving", Visibility = sessionCards.Count > 0 ? Visibility.Visible : Visibility.Collapsed };
        form.Children.Add(permission);
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = ResourceBrush("SystemFillColorCriticalBrush") }; form.Children.Add(error);
        var dialog = new ContentDialog { Title = source is null || duplicate ? "New profile" : "Edit profile", Content = new ScrollViewer { Content = form, MaxHeight = 520 },
            PrimaryButtonText = "Save", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary, XamlRoot = navigation.XamlRoot };
        dialog.PrimaryButtonClick += async (_, args) => {
            args.Cancel = true; var deferral = args.GetDeferral();
            try {
                if (string.IsNullOrWhiteSpace(name.Text)) throw new InvalidOperationException("Enter a profile name.");
                foreach (var (key, number) in numbers) {
                    if (!double.IsFinite(number.Value) || number.Value != Math.Truncate(number.Value)) throw new InvalidOperationException("Enter whole numbers for stream settings.");
                    profile[key] = (int)number.Value;
                }
                if (numbers["width"].Value % 2 != 0 || numbers["height"].Value % 2 != 0) throw new InvalidOperationException("Output width and height must be even.");
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
