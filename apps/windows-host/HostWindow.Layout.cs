using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    // Shared Fluent spacing defaults, in effective pixels. Native controls keep
    // their template padding; content containers apply these insets once.
    static class HostSpacing
    {
        public const double Small = 4;
        public const double Related = 8;
        public const double Row = 12;
        public const double Card = 16;
        public const double Page = 24;
    }
    readonly Grid shell = new();
    readonly TitleBar titleBar = new() { Title = "VidVNC", IsPaneToggleButtonVisible = true,
        IconSource = new FontIconSource { Glyph = "\uE7F4" } };
    readonly NavigationView navigation = new() { IsBackButtonVisible = NavigationViewBackButtonVisible.Collapsed,
        IsSettingsVisible = false, PaneDisplayMode = NavigationViewPaneDisplayMode.Auto, OpenPaneLength = 210,
        CompactModeThresholdWidth = 640, ExpandedModeThresholdWidth = 900, IsPaneOpen = true };
    readonly StackPanel page = new() { Spacing = HostSpacing.Card };
    readonly TextBlock pageTitle = new() { Text = "Overview", FontSize = 28, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold };
    readonly TextBlock summary = new() { Text = "No connected devices", TextWrapping = TextWrapping.Wrap };
    readonly TextBlock sharingText = new() { Text = "Starting…" };
    readonly TextBlock ownership = new() { Text = "No connected devices", TextWrapping = TextWrapping.Wrap };
    readonly Button connectDevice = new() { Content = "Connect a device", IsEnabled = false };
    readonly ContentControl pageAction = new() { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
    readonly ContentControl displayActions = new();
    readonly Button openPreview = new() { Content = "Open preview", IsEnabled = false };
    readonly StackPanel sessionList = new() { Spacing = HostSpacing.Row };
    readonly Dictionary<string, SessionVisual> sessionCards = new();
    string currentPage = "Overview";
    string displayDescription = "Display information appears when sharing starts.";
    string? previewUrl;
    bool sharing;
    bool dialogOpen;

    static TextBlock Label(string text, double size = 14) => new() { Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap };
    static Brush ResourceBrush(string name) => (Brush)Application.Current.Resources[name];
    static Border Card(UIElement content, double inset = HostSpacing.Card) => new() { Child = content, Padding = new Thickness(inset), CornerRadius = new CornerRadius(8),
        BorderThickness = new Thickness(1), BorderBrush = ResourceBrush("CardStrokeColorDefaultBrush"),
        Background = ResourceBrush("CardBackgroundFillColorDefaultBrush") };
    static Button Command(string label, Action action)
    {
        var button = new Button { Content = label }; button.Click += (_, _) => action(); return button;
    }
    static void Copy(string text) { if (string.IsNullOrEmpty(text)) return; var data = new DataPackage(); data.SetText(text); Clipboard.SetContent(data); }

    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    void BuildShell()
    {
        var scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
        AppWindow.Resize(new Windows.Graphics.SizeInt32((int)(1000 * scale), (int)(720 * scale)));
        foreach (var (name, glyph) in new[] { ("Overview", "\uE80F"), ("Displays", "\uE7F4"), ("Streaming profiles", "\uE714"), ("Sessions", "\uE716"), ("Access", "\uE83D") })
            navigation.MenuItems.Add(new NavigationViewItem { Content = name, Tag = name, Icon = new FontIcon { Glyph = glyph } });
        // Footer order is deliberate: sharing state above the bottom-most Settings entry.
        BuildSharingIndicator();
        navigation.FooterMenuItems.Add(new NavigationViewItem { Content = "Settings", Tag = "Settings", Icon = new SymbolIcon(Symbol.Setting) });
        navigation.SelectionChanged += (_, args) => { if (args.SelectedItem is NavigationViewItem item && item.Tag is string name) { currentPage = name; RenderPage(); } };
        var grid = new Grid { Padding = new Thickness(HostSpacing.Page), RowSpacing = HostSpacing.Card };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var header = new Grid { ColumnSpacing = 16 };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        pageTitle.VerticalAlignment = VerticalAlignment.Center;
        header.Children.Add(pageTitle); Grid.SetColumn(pageAction, 1); header.Children.Add(pageAction);
        connectDevice.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        connectDevice.Click += async (_, _) => await ShowConnection();
        grid.Children.Add(header);
        var scroll = new ScrollViewer { Content = page, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Disabled, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(scroll, 1); grid.Children.Add(scroll);
        var footer = new Grid { ColumnSpacing = HostSpacing.Row };
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footer.Children.Add(ownership);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        actions.Children.Add(action); actions.Children.Add(openPreview); actions.Children.Add(connectDevice);
        actions.Children.Add(displayActions);
        openPreview.Click += (_, _) => { if (previewUrl is not null) Process.Start(new ProcessStartInfo(previewUrl) { UseShellExecute = true }); };
        Grid.SetColumn(actions, 1); footer.Children.Add(actions); Grid.SetRow(footer, 2); grid.Children.Add(footer);
        navigation.Content = grid;
        navigation.IsPaneToggleButtonVisible = false;
        navigation.IsTitleBarAutoPaddingEnabled = false;
        shell.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        shell.Children.Add(titleBar);
        Grid.SetRow(navigation, 1); shell.Children.Add(navigation);
        Content = shell;
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(titleBar);
        titleBar.PaneToggleRequested += (_, _) => navigation.IsPaneOpen = !navigation.IsPaneOpen;
        navigation.SelectedItem = navigation.MenuItems[0];
    }

    void SetSharing(bool enabled)
    {
        if (!enabled) CloseIdentify();
        sharing = enabled; sharingText.Text = enabled ? "Sharing is on" : "Sharing is off";
        UpdateSharingIndicator();
        connectDevice.IsEnabled = enabled; openPreview.IsEnabled = enabled;
        if (!enabled) { sessionList.Children.Clear(); sessionCards.Clear(); deviceTotal.Text = "0"; streamTotal.Text = "0"; summary.Text = "No connected devices"; ownership.Text = "No connected devices"; address.Text = ""; password.Text = ""; }
        RenderPage();
    }

    void RenderPage()
    {
        // Pages own their presentation controls; only direct child panels are reused.
        pageTitle.Text = currentPage; page.Children.Clear(); pageAction.Content = null;
        displayActions.Content = null;
        action.Visibility = openPreview.Visibility = currentPage == "Displays" ? Visibility.Collapsed : Visibility.Visible;
        switch (currentPage)
        {
            case "Overview":
                RenderOverview();
                break;
            case "Sessions":
                var diagnosticsLink = Command("Diagnostics ↗", OpenDiagnostics);
                diagnosticsLink.IsEnabled = sharing && DiagnosticsAddress() is not null;
                pageAction.Content = diagnosticsLink;
                page.Children.Add(sessionTotals);
                if (sessionCards.Count == 0) page.Children.Add(Card(Label(sharing ? "No devices connected. Choose Connect a device to get started." : "Start sharing to accept connections.")));
                page.Children.Add(sessionList);
                page.Children.Add(new Expander { Header = "About sessions", HorizontalAlignment = HorizontalAlignment.Stretch,
                    Content = Label("Up to two connected devices, each with two display streams. Desktop audio is shared once per device. Only one device can be granted keyboard and mouse control at a time.") });
                break;
            case "Displays":
                RenderDisplays();
                break;
            case "Streaming profiles":
                RenderProfiles();
                break;
            case "Access":
                RenderAccess();
                break;
            case "Settings":
                var theme = new ComboBox { Header = "Appearance", MinWidth = 200 };
                foreach (var name in new[] { "Use system setting", "Light", "Dark" }) theme.Items.Add(name);
                theme.SelectedIndex = (int)shell.RequestedTheme;
                theme.SelectionChanged += (_, _) => shell.RequestedTheme = (ElementTheme)theme.SelectedIndex;
                page.Children.Add(Card(theme));
                page.Children.Add(Card(Label("When the window closes\nSharing stops and the application exits. Automatic startup is off.")));
                page.Children.Add(Card(Label("Connection\nDesigned for trusted local networks. Remote connection setup is not available. Firewall permissions remain under your control.")));
                page.Children.Add(Command("Open logs folder", () => { var folder = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VidVNC", "logs"); System.IO.Directory.CreateDirectory(folder); Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true }); }));
                page.Children.Add(Label("VidVNC · Windows host\nWindows 11 25H2 or later · NVIDIA media runtime"));
                break;
        }
    }

    string? DiagnosticsAddress() => Uri.TryCreate(previewUrl, UriKind.Absolute, out var uri) &&
        uri.Scheme == "http" && uri.Host == "127.0.0.1" ? new Uri(uri, "/diagnostics").AbsoluteUri : null;

    void OpenDiagnostics()
    {
        var url = DiagnosticsAddress();
        if (url is null) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        { page.Children.Add(new InfoBar { IsOpen = true, Severity = InfoBarSeverity.Error, Message = "Couldn't open diagnostics: " + error.Message }); }
    }

    async Task ShowConnection()
    {
        if (dialogOpen) return;
        dialogOpen = true;
        try
        {
            var body = new StackPanel { Spacing = 12 };
            body.Children.Add(Label("Use Safari on your iPhone, or a browser on another device on your local network."));
            var link = new TextBox { Header = "Connection address", Text = address.Text, IsReadOnly = true };
            body.Children.Add(link); body.Children.Add(Command("Copy address", () => Copy(link.Text)));
            body.Children.Add(Label("Session password"));
            var code = new TextBox { Text = password.Text, IsReadOnly = true, FontSize = 24, FontFamily = new FontFamily("Cascadia Mono") };
            body.Children.Add(code); body.Children.Add(Command("Copy password", () => Copy(code.Text)));
            body.Children.Add(Label("Trusted networks only: pairing currently uses HTTP. QR pairing and passkeys are not available yet."));
            await new ContentDialog { Title = "Connect a device", Content = new ScrollViewer { Content = body, MaxHeight = 420 },
                CloseButtonText = "Done", XamlRoot = navigation.XamlRoot }.ShowAsync();
        }
        finally { dialogOpen = false; }
    }

    void UpdateSessions(JsonElement status)
    {
        var rows = status.GetProperty("sessions").EnumerateArray().ToArray();
        var streamsCount = status.GetProperty("streamCount").GetInt32();
        summary.Text = $"{rows.Length} connected device{(rows.Length == 1 ? "" : "s")} · {streamsCount} display stream{(streamsCount == 1 ? "" : "s")}";
        if (overviewSessionSummary is not null) overviewSessionSummary.Text = summary.Text;
        deviceTotal.Text = rows.Length.ToString(); streamTotal.Text = streamsCount.ToString();
        ownership.Text = rows.Length == 0 ? "No connected devices" : summary.Text;
        var ids = rows.Select(r => r.GetProperty("id").GetString()!).ToHashSet();
        bool changed = false;
        foreach (var id in sessionCards.Keys.Where(id => !ids.Contains(id)).ToArray()) { sessionList.Children.Remove(sessionCards[id].Card); sessionCards.Remove(id); changed = true; }
        foreach (var row in rows)
        {
            var id = row.GetProperty("id").GetString()!;
            if (!sessionCards.TryGetValue(id, out var controls))
            {
                controls = new SessionVisual((action, streamId) => SendSessionCommand(action, id, streamId));
                var disconnect = new Button { Content = "Disconnect" };
                disconnect.Click += async (_, _) => { try { if (server is not null) { await server.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { type = "disconnect", id })); await server.StandardInput.FlushAsync(); } } catch (Exception error) when (error is IOException or InvalidOperationException) { detail.Text = error.Message; } };
                controls.Actions.Children.Add(disconnect);
                sessionCards[id] = controls; sessionList.Children.Add(controls.Card); changed = true;
            }
            controls.Title.Text = row.GetProperty("device").GetString();
            controls.Icon.Glyph = controls.Title.Text?.Contains("iPhone") == true || controls.Title.Text?.Contains("Android") == true ? "\uE8EA" : "\uE7F4";
            controls.Health.Text = row.GetProperty("health").GetString();
            controls.UpdateHealthBrush();
            var minutes = Math.Max(0, (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - row.GetProperty("connectedAt").GetInt64()) / 60000);
            controls.Detail.Text = $"{row.GetProperty("address").GetString()} · {(minutes == 0 ? "Connected just now" : $"Connected {minutes} min ago")}";
            controls.Audio.Text = row.GetProperty("audio").GetBoolean() ? "Audio on" : "Audio off";
            controls.UpdatePermission(row, status.TryGetProperty("capabilities", out var capabilities) &&
                capabilities.TryGetProperty("hostControl", out var hostControl) && hostControl.GetBoolean());
            controls.UpdateStreams(row.GetProperty("streams"));
        }
        if (changed && currentPage == "Sessions") RenderPage();
    }
}
