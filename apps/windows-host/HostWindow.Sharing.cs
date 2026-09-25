using System.Text.RegularExpressions;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace VidVnc.Host;

// The sharing indicator in the navigation pane is also the sharing switch: select it to start
// sharing on the local network or to stop sharing. Its arrow (or a right-click) offers the other
// ways to start, and switching remote access on or off while sharing. Remote access is shown
// on the indicator itself — a globe in the warning colour and "Remote access on" — so it can't
// be missed, even with the pane collapsed to icons.
public sealed partial class HostWindow
{
    readonly TextBlock sharingScope = new() { FontSize = 12, Opacity = .76, TextTrimming = TextTrimming.CharacterEllipsis };
    readonly Button sharingOptions = new()
    {
        Content = new FontIcon { Glyph = "\uE70D", FontSize = 12 },
        Padding = new Thickness(6, 4, 6, 4), MinWidth = 0, VerticalAlignment = VerticalAlignment.Center,
        Background = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent),
        BorderThickness = new Thickness(0),
    };
    NavigationViewItem? sharingItem;
    // How the owner asked sharing to start ("local" or "remote"), and what the server said if
    // remote access could not be turned on.
    string requestedSharing = "local";
    string? sharingNotice;
    // Pressing the options arrow must not also count as a click on the indicator around it.
    DateTime ignoreSharingToggleUntil;
    string? remoteHostsDraft, remotePortDraft, remoteMediaDraft;
    string? remoteFormError;

    void BuildSharingIndicator()
    {
        var labels = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        labels.Children.Add(sharingText);
        labels.Children.Add(sharingScope);
        var content = new Grid { ColumnSpacing = HostSpacing.Related };
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        content.Children.Add(labels);
        Grid.SetColumn(sharingOptions, 1);
        content.Children.Add(sharingOptions);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(sharingOptions, "Sharing options");
        ToolTipService.SetToolTip(sharingOptions, "Sharing options");
        sharingOptions.Flyout = SharingMenu();
        sharingOptions.AddHandler(UIElement.PointerPressedEvent,
            new PointerEventHandler((_, _) => ignoreSharingToggleUntil = DateTime.UtcNow.AddMilliseconds(600)), true);
        // A command, not a page: it never becomes the selected navigation item. Keep Settings below it.
        sharingItem = new NavigationViewItem { Content = content, Icon = sharingDot, SelectsOnInvoked = false, Tag = "sharing-toggle" };
        sharingItem.ContextFlyout = SharingMenu();
        navigation.FooterMenuItems.Add(sharingItem);
        navigation.ItemInvoked += async (_, args) =>
        {
            if (args.InvokedItemContainer != sharingItem || DateTime.UtcNow < ignoreSharingToggleUntil) return;
            await ToggleSharing();
        };
        sharingText.ActualThemeChanged += (_, _) => UpdateSharingIndicator();
        foreach (var (value, label) in new[] { (deviceTotal, "Connected devices"), (streamTotal, "Display streams") })
        {
            var card = new StackPanel { Spacing = 4 };
            card.Children.Add(value); card.Children.Add(Label(label));
            var border = Card(card);
            Grid.SetColumn(border, sessionTotals.ColumnDefinitions.Count);
            sessionTotals.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            sessionTotals.Children.Add(border);
        }
        UpdateSharingIndicator();
    }

    MenuFlyout SharingMenu()
    {
        var menu = new MenuFlyout();
        menu.Opening += (_, _) =>
        {
            menu.Items.Clear();
            var busy = stopping || (server is not null && !sharing);
            MenuFlyoutItem Item(string text, string glyph, Func<Task> run, bool enabled = true)
            {
                var item = new MenuFlyoutItem { Text = text, Icon = new FontIcon { Glyph = glyph }, IsEnabled = enabled && !busy };
                item.Click += async (_, _) => await run();
                menu.Items.Add(item);
                return item;
            }
            if (server is null)
            {
                Item("Start sharing on the local network", "\uE968", () => StartServer("local"));
                Item("Start sharing with remote access", "\uE774", () => StartServer("remote"));
            }
            else
            {
                Item("Stop sharing", "\uE71A", StopServer);
                if (remoteAccess) Item("Turn off remote access", "\uE968", () => SetRemoteAccess(false), accessReady && !accessSaving);
                else Item("Turn on remote access", "\uE774", () => SetRemoteAccess(true), accessReady && !accessSaving);
            }
            menu.Items.Add(new MenuFlyoutSeparator());
            var settings = new MenuFlyoutItem { Text = "Remote access settings", Icon = new SymbolIcon(Symbol.Setting) };
            settings.Click += (_, _) => navigation.SelectedItem = navigation.FooterMenuItems.OfType<NavigationViewItem>().Single(item => item.Tag as string == "Settings");
            menu.Items.Add(settings);
        };
        return menu;
    }

    async Task ToggleSharing()
    {
        if (stopping || (server is not null && !sharing)) return;
        if (server is null) await StartServer("local");
        else await StopServer();
    }

    void UpdateSharingIndicator()
    {
        var launching = server is not null && !sharing && !stopping;
        var remote = sharing && remoteAccess;
        // SetSharing owns the primary on/off wording; transitions override it here.
        if (stopping) sharingText.Text = "Stopping…";
        else if (launching) sharingText.Text = "Starting…";
        else sharingText.Text = sharing ? "Sharing is on" : "Sharing is off";
        sharingScope.Text = stopping ? "" :
            launching ? requestedSharing == "remote" ? "With remote access" : "Local network only" :
            remote ? "Remote access on" :
            sharing ? "Local network only" : "Select to start";
        sharingDot.Glyph = remote || (launching && requestedSharing == "remote") ? "\uE774" : "\uEA3B";
        sharingDot.FontSize = sharingDot.Glyph == "\uE774" ? 16 : 12;
        sharingDot.Foreground = ThemeStatusBrush(sharingText, remote ? "warning" : sharing ? "success" : "neutral");
        if (remote) sharingScope.Foreground = ThemeStatusBrush(sharingText, "warning");
        else sharingScope.ClearValue(TextBlock.ForegroundProperty);
        if (sharingItem is null) return;
        var tip = stopping || launching ? sharingText.Text :
            remote ? "Remote access is on: approved devices can connect from the internet. Select to stop sharing." :
            sharing ? "Only devices on this network can connect. Select to stop sharing; use the arrow for remote access." :
            "Select to start sharing on the local network. Use the arrow to start with remote access.";
        ToolTipService.SetToolTip(sharingItem, tip);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(sharingItem, $"{sharingText.Text}. {sharingScope.Text}");
    }

    async Task SetRemoteAccess(bool enabled)
    {
        if (enabled && publicHostnames.Length == 0)
        {
            accessError = "Remote access needs the name or address internet devices use for this PC. Add it under Remote access, then turn it on.";
            currentPage = "Settings";
            navigation.SelectedItem = navigation.FooterMenuItems.OfType<NavigationViewItem>().Single(item => item.Tag as string == "Settings");
            RenderPage();
            return;
        }
        // Remote access requires approved-only admission; the server refuses anything else.
        await SendAccessChanges(enabled
            ? new Dictionary<string, object?> { ["remoteAccess"] = true, ["connectionMode"] = "approved-only" }
            : new Dictionary<string, object?> { ["remoteAccess"] = false });
        if (accessError is null) sharingNotice = null;
        UpdateSharingIndicator();
    }

    // Lowercase, without brackets or a trailing dot: the exact form the server stores.
    static string NormalizeHost(string value)
    {
        var text = value.Trim().ToLowerInvariant();
        if (text.StartsWith('[') && text.EndsWith(']')) text = text[1..^1];
        return text.TrimEnd('.');
    }

    async Task SaveRemoteSettings(string hostsText, string portText, string mediaText)
    {
        remoteFormError = null;
        var hosts = Regex.Split(hostsText, @"[\s,;]+").Select(NormalizeHost).Where(host => host.Length > 0).Distinct().ToArray();
        int? port = null;
        if (!string.IsNullOrWhiteSpace(portText))
        {
            if (!int.TryParse(portText.Trim(), out var number) || number is < 1 or > 65535)
            { remoteFormError = "The public HTTPS port must be a number from 1 to 65535, or empty."; RenderPage(); return; }
            port = number;
        }
        object? media = null;
        if (!string.IsNullOrWhiteSpace(mediaText))
        {
            var match = Regex.Match(mediaText.Trim(), @"^(\d{1,5})\s*-\s*(\d{1,5})$");
            if (!match.Success)
            { remoteFormError = "Media ports must be a range like 40000-40049, or empty for automatic."; RenderPage(); return; }
            media = new { min = int.Parse(match.Groups[1].Value), max = int.Parse(match.Groups[2].Value) };
        }
        if (remoteAccess && hosts.Length == 0)
        { remoteFormError = "Turn remote access off before removing every public name."; RenderPage(); return; }
        await SendAccessChanges(new Dictionary<string, object?> {
            ["publicHostnames"] = hosts, ["publicPort"] = port, ["mediaPorts"] = media },
            onSaved: () => remoteHostsDraft = remotePortDraft = remoteMediaDraft = null);
    }

    void RenderRemoteAccessSettings()
    {
        var content = new StackPanel { Spacing = HostSpacing.Row, Tag = "remote-access-settings" };
        var header = new Grid { ColumnSpacing = HostSpacing.Card };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var globe = new FontIcon { Glyph = "\uE774", FontSize = 24, VerticalAlignment = VerticalAlignment.Center };
        if (remoteAccess && sharing) globe.Foreground = ThemeStatusBrush(navigation, "warning");
        header.Children.Add(globe);
        var labels = new StackPanel { Spacing = HostSpacing.Small, VerticalAlignment = VerticalAlignment.Center };
        labels.Children.Add(Label("Remote access", 16));
        labels.Children.Add(Secondary(!sharing ? "Off while sharing is off. It is chosen each time sharing starts, and local network only is the default." :
            remoteAccess ? "On. Approved devices can connect from the internet." : "Off. Only devices on this network can connect."));
        Grid.SetColumn(labels, 1); header.Children.Add(labels);
        var toggle = new Button { Content = remoteAccess ? "Turn off" : "Turn on", Tag = "remote-access-toggle",
            VerticalAlignment = VerticalAlignment.Center,
            IsEnabled = accessReady && server is not null && sharing && !accessSaving };
        if (!remoteAccess) toggle.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        toggle.Click += async (_, _) => await SetRemoteAccess(!remoteAccess);
        Grid.SetColumn(toggle, 2); header.Children.Add(toggle);
        content.Children.Add(header);
        if (sharingNotice is not null) content.Children.Add(new InfoBar { IsOpen = true, IsClosable = false,
            Severity = InfoBarSeverity.Warning, Message = sharingNotice });
        if (remoteAccess && sharing) content.Children.Add(new InfoBar { IsOpen = true, IsClosable = false,
            Severity = InfoBarSeverity.Warning, Title = "Check the source address once",
            Message = "Connect from a phone on mobile data and open Sessions. It must show a public address, not your router's. If it shows the router, your router rewrites forwarded connections: fix its port forwarding or use a VPN instead." });

        var editable = accessReady && server is not null && !accessSaving;
        var hosts = new TextBox { Header = "Public names or addresses", Tag = "public-hostnames",
            PlaceholderText = "vnc.example.com, 203.0.113.10",
            Text = remoteHostsDraft ?? string.Join(", ", publicHostnames), IsEnabled = editable };
        hosts.TextChanged += (_, _) => remoteHostsDraft = hosts.Text;
        content.Children.Add(hosts);
        content.Children.Add(Secondary("What internet devices type to reach this PC: your DNS name (dynamic DNS is fine) or your router's public address. They are added to this PC's HTTPS certificate."));
        var port = new TextBox { Header = "Public HTTPS port", Tag = "public-port", PlaceholderText = "Same as this PC's HTTPS port",
            Text = remotePortDraft ?? publicPort?.ToString() ?? "", IsEnabled = editable };
        port.TextChanged += (_, _) => remotePortDraft = port.Text;
        content.Children.Add(port);
        content.Children.Add(Secondary("Only if the router forwards a different port, usually 443, to this PC's HTTPS port."));
        var media = new TextBox { Header = "Media ports", Tag = "media-ports", PlaceholderText = "For example 40000-40049 (empty: automatic)",
            Text = remoteMediaDraft ?? (mediaPorts is { } range ? $"{range.Min}-{range.Max}" : ""), IsEnabled = editable };
        media.TextChanged += (_, _) => remoteMediaDraft = media.Text;
        content.Children.Add(media);
        content.Children.Add(Secondary("Video, audio and input use only these UDP ports. Forward the same port numbers on the router. New streams use a changed range."));
        var save = Command("Save remote access settings", async () => await SaveRemoteSettings(hosts.Text, port.Text, media.Text));
        save.Tag = "save-remote-access"; save.IsEnabled = editable;
        content.Children.Add(save);
        if (!editable) content.Children.Add(Secondary("Start sharing to change these settings."));
        if (remoteFormError is not null) content.Children.Add(new InfoBar { IsOpen = true, IsClosable = false,
            Severity = InfoBarSeverity.Error, Message = remoteFormError });
        content.Children.Add(new Expander { Header = "What remote access changes", HorizontalAlignment = HorizontalAlignment.Stretch,
            Content = Label(string.Join("\n", new[] {
                "• Only approved clients can sign in, from anywhere. Codes, client setup and certificate enrolment stay on the local network, so set devices up here first.",
                "• Internet devices must use HTTPS. Keyboard and mouse still need your approval unless you set that client to allow control.",
                "• On the router, forward the HTTPS port (TCP) and the media ports (UDP) to this PC. Never forward the plain HTTP port.",
                "• Switching remote access off disconnects internet devices at once. Stopping sharing turns it off; start with remote access again when you need it.",
            })) });
        page.Children.Add(Card(content));
    }
}
