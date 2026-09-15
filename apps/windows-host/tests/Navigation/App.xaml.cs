using System.Reflection;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using VidVnc.Host;

namespace VidVnc.NavigationTests;

public partial class App : Application
{
    HostWindow? window;
    static readonly string Result = Path.Combine(AppContext.BaseDirectory, "navigation-result.log");
    public App()
    {
        InitializeComponent();
        UnhandledException += (_, args) => Fail(args.Exception);
    }
    static void Fail(Exception error)
    {
        File.WriteAllText(Result, error.ToString());
        Environment.Exit(1);
    }
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            // No runtime manifest in this isolated test output: no server or capture starts.
            Environment.SetEnvironmentVariable("VIDVNC_RUNTIME_MANIFEST", Path.Combine(AppContext.BaseDirectory, "absent-runtime.json"));
            window = new HostWindow();
            window.Activate();
            window.DispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    var flags = BindingFlags.Instance | BindingFlags.NonPublic;
                    var orderFilename = Path.Combine(AppContext.BaseDirectory, "profile-order-test.json");
                    File.Delete(orderFilename);
                    typeof(HostWindow).GetField("profileOrder", flags)!.SetValue(window, new ProfileOrderStore(orderFilename));
                    var navigation = (NavigationView)typeof(HostWindow).GetField("navigation", flags)!.GetValue(window)!;
                    if (!window.ExtendsContentIntoTitleBar) throw new Exception("Host still uses the default system title strip");
                    var shell = (Grid)window.Content;
                    var titleBar = shell.Children.OfType<TitleBar>().Single();
                    if (titleBar.Title != "VidVNC" || !titleBar.IsPaneToggleButtonVisible || navigation.IsPaneToggleButtonVisible)
                        throw new Exception("Title bar identity or navigation integration missing");
                    foreach (var theme in new[] { ElementTheme.Light, ElementTheme.Dark, ElementTheme.Default })
                    {
                        shell.RequestedTheme = theme;
                        await Task.Delay(80);
                        if (titleBar.ActualTheme != navigation.ActualTheme) throw new Exception("Title bar and content themes differ");
                    }
                    var title = (TextBlock)typeof(HostWindow).GetField("pageTitle", flags)!.GetValue(window)!;
                    var update = typeof(HostWindow).GetMethod("UpdateSessions", flags)!;
                    var updatePolicy = typeof(HostWindow).GetMethod("UpdatePolicy", flags);
                    if (updatePolicy is null) throw new Exception("Streaming profiles administration view is missing");
                    using var policyFixture = JsonDocument.Parse("""
                    {"schemaVersion":1,"revision":0,"profiles":[{"id":"balanced","name":"Balanced","description":"Everyday desktop use","enabled":true,"width":1920,"height":1080,"fps":30,"bitrateKbps":4000,"frameDelivery":"fixed"}],"clientMode":"profiles","defaultProfileId":"auto","displayDefaults":{},"allowAudio":true,"allowedOptions":{"resolutions":[{"width":960,"height":540},{"width":1280,"height":720},{"width":1920,"height":1080},{"width":2560,"height":1440}],"frameRates":[15,30],"bitratesKbps":[1000,2000,4000,6000]}}
                    """);
                    updatePolicy.Invoke(window, new object[] { policyFixture.RootElement });
                    var updateDisplays = typeof(HostWindow).GetMethod("UpdateDisplays", flags);
                    if (updateDisplays is null) throw new Exception("Native display inventory view is missing");
                    using var inventory = JsonDocument.Parse("""
                    [{"id":"landscape","name":"Main display","primary":true,"x":0,"y":0,"width":2560,"height":1440,"refreshHz":144,"rotation":0},
                     {"id":"portrait","name":"Portrait display","primary":false,"x":-1080,"y":-480,"width":1080,"height":1920,"refreshHz":60,"rotation":90}]
                    """);
                    updateDisplays.Invoke(window, new object[] { inventory.RootElement });
                    await CheckIdentify(window, flags);
                    updateDisplays.Invoke(window, new object[] { inventory.RootElement });
                    var setSharing = typeof(HostWindow).GetMethod("SetSharing", flags)!;
                    setSharing.Invoke(window, new object[] { true });
                    var sharingLabel = (TextBlock)typeof(HostWindow).GetField("sharingText", flags)!.GetValue(window)!;
                    await Task.Delay(80);
                    for (DependencyObject? ancestor = sharingLabel; ancestor is not null; ancestor = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetParent(ancestor))
                        if (ancestor is Control control && !control.IsEnabled) throw new Exception("Sharing status is styled as disabled");
                    if (sharingLabel.Text != "Sharing is on") throw new Exception("Active sharing status missing");
                    setSharing.Invoke(window, new object[] { false });
                    if (sharingLabel.Text != "Sharing is off") throw new Exception("Stopped sharing status missing");
                    for (int cycle = 0; cycle < 3; cycle++)
                    {
                        foreach (var name in new[] { "Sessions", "Overview", "Displays", "Streaming profiles", "Access", "Settings", "Sessions", "Overview" })
                        {
                            navigation.SelectedItem = navigation.MenuItems.Concat(navigation.FooterMenuItems)
                                .OfType<NavigationViewItem>().Single(item => item.Tag as string == name);
                            await Task.Delay(80);
                            if (title.Text != name) throw new Exception($"Navigation did not reach {name}");
                            if (name == "Access" && cycle == 0)
                            {
                                var picker = Descendants(shell).OfType<ComboBox>().SingleOrDefault(c => c.Tag as string == "default-control");
                                if (picker is null) throw new Exception("Access page is missing default keyboard/mouse permissions");
                                if (picker.IsEnabled) throw new Exception("Access cannot save while server is stopped");
                                var start = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
                                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                                start.ArgumentList.Add(Path.GetFullPath("apps/windows-host/tests/Navigation/owner-fixture.mjs"));
                                using var owner = System.Diagnostics.Process.Start(start)!;
                                var serverField = typeof(HostWindow).GetField("server", flags)!;
                                try
                                {
                                    serverField.SetValue(window, owner);
                                    using var initialAccess = JsonDocument.Parse("{\"revision\":0,\"defaultControl\":\"approval\"}");
                                    typeof(HostWindow).GetMethod("UpdateAccess", flags)!.Invoke(window, new object[] { initialAccess.RootElement });
                                    foreach (var index in new[] { 1, 0 })
                                    {
                                        picker = Descendants(shell).OfType<ComboBox>().Single(c => c.Tag as string == "default-control");
                                        if (!picker.IsEnabled) throw new Exception("Access setting is disabled with a ready owner");
                                        picker.SelectedIndex = index;
                                        var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                        using var reply = JsonDocument.Parse(line!);
                                        if (!reply.RootElement.GetProperty("ok").GetBoolean() ||
                                            reply.RootElement.GetProperty("access").GetProperty("defaultControl").GetString() != (index == 1 ? "available" : "approval"))
                                            throw new Exception("Access default was not persisted through owner pipe");
                                        typeof(HostWindow).GetMethod("ReceiveAccessResult", flags)!.Invoke(window, new object[] { reply.RootElement });
                                        await Task.Delay(80);
                                        picker = Descendants(shell).OfType<ComboBox>().Single(c => c.Tag as string == "default-control");
                                        if (picker.SelectedIndex != index || !picker.IsEnabled) throw new Exception("Saved access default was not reflected in the UI");
                                    }
                                }
                                finally { serverField.SetValue(window, null); owner.StandardInput.Close(); if (!owner.WaitForExit(5000)) owner.Kill(); }
                            }
                            if (name == "Streaming profiles")
                            {
                                var menu = navigation.MenuItems.OfType<NavigationViewItem>().ToArray();
                                if (menu[2].Tag as string != "Streaming profiles") throw new Exception("Profiles tab must follow Displays");
                                var profileRows = Descendants(window.Content).OfType<Grid>().Where(g => g.Tag as string == "profile-row").ToArray();
                                if (profileRows.Length != 1 || !Descendants(profileRows[0]).OfType<ToggleSwitch>().Any())
                                    throw new Exception("Profiles require left-hand availability toggles");
                                if (!Descendants(profileRows[0]).OfType<TextBlock>().Any(t => t.Text == "Everyday desktop use"))
                                    throw new Exception("Profile description missing");
                                var connect = (Button)typeof(HostWindow).GetField("connectDevice", flags)!.GetValue(window)!;
                                if (connect.TransformToVisual(shell).TransformPoint(new(0, 0)).Y < shell.ActualHeight / 2)
                                    throw new Exception("Connect a device must be in the footer, not the page header");
                                var addProfile = Descendants(shell).OfType<Button>().Single(b => b.Content as string == "＋ New profile");
                                if (Math.Abs(addProfile.TransformToVisual(shell).TransformPoint(new(0, 0)).Y - title.TransformToVisual(shell).TransformPoint(new(0, 0)).Y) > 8)
                                    throw new Exception("New profile must share the title header");
                                foreach (var heading in new[] { "Output size", "Frame rate", "Video bitrate" })
                                    if (!Descendants(shell).OfType<TextBlock>().Any(t => t.Text == heading)) throw new Exception("Missing profile column heading: " + heading);
                                var numeric = Descendants(profileRows[0]).OfType<TextBlock>().Single(t => t.Text == "1920 × 1080");
                                var toggleControl = Descendants(profileRows[0]).OfType<ToggleSwitch>().Single();
                                double Center(FrameworkElement e) => e.TransformToVisual(profileRows[0]).TransformPoint(new(0, 0)).Y + e.ActualHeight / 2;
                                if (Math.Abs(Center(numeric) - Center(toggleControl)) > 3)
                                    throw new Exception("Profile values wrap below the availability control at normal window width");
                                if (cycle == 0)
                                {
                                    var snapshotField = typeof(HostWindow).GetField("streamPolicy", flags)!;
                                    var reorderPolicy = System.Text.Json.Nodes.JsonNode.Parse(policyFixture.RootElement.GetRawText())!.AsObject();
                                    var secondProfile = reorderPolicy["profiles"]![0]!.DeepClone();
                                    secondProfile["id"] = "mobile"; secondProfile["name"] = "Mobile";
                                    reorderPolicy["profiles"]!.AsArray().Add(secondProfile);
                                    using var reorderDocument = JsonDocument.Parse(reorderPolicy.ToJsonString());
                                    updatePolicy.Invoke(window, new object[] { reorderDocument.RootElement }); await Task.Delay(80);
                                    var reorderBefore = ((System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!).ToJsonString();
                                    var dragList = Descendants(shell).OfType<ListView>().Single(l => l.Tag as string == "profile-list");
                                    if (!dragList.CanDragItems || !dragList.CanReorderItems || !dragList.AllowDrop)
                                        throw new Exception("Profiles must support native drag and drop reordering");
                                    var dragRows = (System.Collections.ObjectModel.ObservableCollection<Grid>)dragList.ItemsSource;
                                    var firstMenu = (MenuFlyout)dragRows[0].Children.OfType<Button>().Single().Flyout;
                                    var moveDown = firstMenu.Items.OfType<MenuFlyoutItem>().Single(i => i.Text == "Move down");
                                    var movePeer = new Microsoft.UI.Xaml.Automation.Peers.MenuFlyoutItemAutomationPeer(moveDown);
                                    ((Microsoft.UI.Xaml.Automation.Provider.IInvokeProvider)movePeer.GetPattern(Microsoft.UI.Xaml.Automation.Peers.PatternInterface.Invoke)).Invoke();
                                    await Task.Delay(80);
                                    if (!Descendants(dragRows[0]).OfType<TextBlock>().Any(t => t.Text == "Mobile"))
                                        throw new Exception("Move down did not reorder the displayed rows");
                                    if (((System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!).ToJsonString() != reorderBefore)
                                        throw new Exception("Cosmetic reorder changed the server policy or revision");
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null); await Task.Delay(80);
                                    var reloadedList = Descendants(shell).OfType<ListView>().Single(l => l.Tag as string == "profile-list");
                                    var reloadedRows = (System.Collections.ObjectModel.ObservableCollection<Grid>)reloadedList.ItemsSource;
                                    if (!Descendants(reloadedRows[0]).OfType<TextBlock>().Any(t => t.Text == "Mobile"))
                                        throw new Exception("Profile display ordering did not survive page reload");
                                    updatePolicy.Invoke(window, new object[] { policyFixture.RootElement }); await Task.Delay(80);
                                    var before = ((System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!).ToJsonString();
                                    var source = System.Text.Json.Nodes.JsonNode.Parse(policyFixture.RootElement.GetProperty("profiles")[0].GetRawText())!.AsObject();
                                    var editor = (ContentDialog)typeof(HostWindow).GetMethod("CreateProfileEditor", flags)!.Invoke(window, new object?[] { source, false })!;
                                    var showing = editor.ShowAsync();
                                    await Task.Delay(120);
                                    var fields = Descendants(editor).OfType<TextBox>().ToArray();
                                    var description = fields.Single(t => t.Header as string == "Description");
                                    if (description.Text != "Everyday desktop use" || Descendants(editor).OfType<NumberBox>().Count() != 4)
                                        throw new Exception("Profile modal must include description and numeric stream settings");
                                    description.Text = "Uncommitted edit";
                                    editor.Hide(); await showing;
                                    if (((System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!).ToJsonString() != before)
                                        throw new Exception("Canceling profile editor mutated the policy snapshot");
                                    var serverField = typeof(HostWindow).GetField("server", flags)!;
                                    serverField.SetValue(window, System.Diagnostics.Process.GetCurrentProcess());
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null);
                                    await Task.Delay(80);
                                    var modes = Descendants(shell).OfType<RadioButton>().ToArray();
                                    if (modes.Length != 2 || modes.Any(r => !r.IsEnabled)) throw new Exception("Customization modes remain disabled with an available server");
                                    var editOptions = Descendants(shell).OfType<Button>().Single(b => b.Content as string == "Edit allowed options");
                                    if (!editOptions.IsEnabled || editOptions.TransformToVisual(shell).TransformPoint(new(0, 0)).X <= modes[0].TransformToVisual(shell).TransformPoint(new(0, 0)).X + modes[0].ActualWidth)
                                        throw new Exception("Edit allowed options must be enabled beside the mode choices");
                                    serverField.SetValue(window, null);
                                    var optionsMethod = typeof(HostWindow).GetMethod("CreateAllowedOptionsEditor", flags);
                                    if (optionsMethod is null) throw new Exception("Allowed options editor is missing");
                                    var optionsEditor = (ContentDialog)optionsMethod.Invoke(window, null)!;
                                    var showingOptions = optionsEditor.ShowAsync(); await Task.Delay(300);
                                    if (Descendants(optionsEditor).OfType<NumberBox>().Count() != 14)
                                        throw new Exception("Allowed options editor must expose every approved resolution, frame rate and bitrate");
                                    var optionGroups = Descendants(optionsEditor).OfType<Grid>().Where(g => g.Tag as string == "allowed-option-group").ToArray();
                                    if (optionGroups.Length != 3) throw new Exception("Allowed options must use three label/editor columns rather than stacked full-width inputs");
                                    foreach (var group in optionGroups)
                                    {
                                        var label = group.Children.OfType<TextBlock>().Single();
                                        var input = Descendants(group).OfType<NumberBox>().First();
                                        var inputPosition = input.TransformToVisual(group).TransformPoint(new(0, 0));
                                        if (inputPosition.X <= label.ActualWidth || input.ActualWidth > 160)
                                            throw new Exception("Allowed option editors must be compact and to the right of their section label");
                                    }
                                    if (!Descendants(optionsEditor).OfType<TextBlock>().Any(t => t.Text == "Mbit/s")) throw new Exception("Bitrate unit must be Mbit/s");
                                    var optionSave = Descendants(optionsEditor).OfType<Button>().Single(b => b.Name == "PrimaryButton");
                                    var optionCancel = Descendants(optionsEditor).OfType<Button>().Single(b => b.Name == "CloseButton");
                                    if (optionSave.ActualWidth > 140 || optionSave.TransformToVisual(optionsEditor).TransformPoint(new(0, 0)).X <= optionCancel.TransformToVisual(optionsEditor).TransformPoint(new(0, 0)).X)
                                        throw new Exception($"Allowed-options footer must have compact Cancel then Save buttons: Save width={optionSave.ActualWidth}, X={optionSave.TransformToVisual(optionsEditor).TransformPoint(new(0, 0)).X}, Cancel X={optionCancel.TransformToVisual(optionsEditor).TransformPoint(new(0, 0)).X}, columns={Grid.GetColumn(optionSave)}/{Grid.GetColumn(optionCancel)}");
                                    var bitmap = new Microsoft.UI.Xaml.Media.Imaging.RenderTargetBitmap();
                                    await bitmap.RenderAsync(optionsEditor);
                                    var pixels = await bitmap.GetPixelsAsync(); var bytes = new byte[pixels.Length];
                                    using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(pixels)) reader.ReadBytes(bytes);
                                    var folder = await Windows.Storage.StorageFolder.GetFolderFromPathAsync(AppContext.BaseDirectory);
                                    var screenshot = await folder.CreateFileAsync("allowed-options.png", Windows.Storage.CreationCollisionOption.ReplaceExisting);
                                    using (var output = await screenshot.OpenAsync(Windows.Storage.FileAccessMode.ReadWrite))
                                    {
                                        var encoder = await Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, output);
                                        encoder.SetPixelData(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied,
                                            (uint)bitmap.PixelWidth, (uint)bitmap.PixelHeight, 96, 96, bytes);
                                        await encoder.FlushAsync();
                                    }
                                    Descendants(optionsEditor).OfType<NumberBox>().First().Value = 1600;
                                    optionsEditor.Hide(); await showingOptions;
                                    if (((System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!).ToJsonString() != before)
                                        throw new Exception("Canceling allowed options editor mutated saved policy");
                                    var start = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
                                        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                                    start.ArgumentList.Add(Path.GetFullPath("apps/windows-host/tests/Navigation/owner-fixture.mjs"));
                                    using var owner = System.Diagnostics.Process.Start(start)!;
                                    try
                                    {
                                        serverField.SetValue(window, owner);
                                        typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null);
                                        async Task ReceiveSavedPolicy()
                                        {
                                            var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                            if (line is null) throw new Exception("Owner fixture stopped: " + await owner.StandardError.ReadToEndAsync());
                                            using var reply = JsonDocument.Parse(line);
                                            typeof(HostWindow).GetMethod("ReceivePolicyResult", flags)!.Invoke(window, new object[] { reply.RootElement });
                                            for (int i = 0; i < 100 && (bool)typeof(HostWindow).GetField("policySaving", flags)!.GetValue(window)!; i++) await Task.Delay(10);
                                            if (!reply.RootElement.GetProperty("ok").GetBoolean()) throw new Exception("Policy was not persisted: " + line);
                                        }
                                        Descendants(shell).OfType<RadioButton>().Single(r => r.Content as string == "Approved options").IsChecked = true;
                                        await ReceiveSavedPolicy();
                                        var saved = (System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!;
                                        if (saved["clientMode"]!.GetValue<string>() != "options" || saved["revision"]!.GetValue<int>() != 1)
                                            throw new Exception("Selecting approved options did not persist the mode through the owner pipe");
                                        var saveEditor = (ContentDialog)optionsMethod.Invoke(window, null)!;
                                        var savingDialog = saveEditor.ShowAsync(); await Task.Delay(120);
                                        Descendants(saveEditor).OfType<NumberBox>().First().Value = 1600;
                                        Descendants(saveEditor).OfType<NumberBox>().Last().Value = 2.5;
                                        var saveButton = Descendants(saveEditor).OfType<Button>().Single(b => b.Name == "PrimaryButton");
                                        var peer = new Microsoft.UI.Xaml.Automation.Peers.ButtonAutomationPeer(saveButton);
                                        ((Microsoft.UI.Xaml.Automation.Provider.IInvokeProvider)peer.GetPattern(Microsoft.UI.Xaml.Automation.Peers.PatternInterface.Invoke)).Invoke();
                                        await ReceiveSavedPolicy(); await savingDialog;
                                        saved = (System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!;
                                        if (saved["allowedOptions"]!["resolutions"]![0]!["width"]!.GetValue<int>() != 1600 || saved["revision"]!.GetValue<int>() != 2)
                                            throw new Exception("Allowed options Save did not persist edited dimensions");
                                        if (saved["allowedOptions"]!["bitratesKbps"]![3]!.GetValue<int>() != 2500)
                                            throw new Exception("Mbit/s editor failed to convert 2.5 to 2500 kbit/s on save");
                                    }
                                    finally
                                    {
                                        serverField.SetValue(window, null); owner.StandardInput.Close();
                                        if (!owner.WaitForExit(5000)) owner.Kill();
                                        updatePolicy.Invoke(window, new object[] { policyFixture.RootElement });
                                    }
                                }
                            }
                            if (name == "Overview")
                            {
                                var placeholders = Descendants(window.Content).OfType<Control>()
                                    .Where(c => c.Tag as string == "backend-pending").ToArray();
                                if (placeholders.Length < 1 || placeholders.Any(c => c.IsEnabled))
                                    throw new Exception("Planned controls must be visible but disabled until their backend exists");
                            }
                            if (name == "Overview")
                            {
                                var statusRow = Descendants(window.Content).OfType<Grid>().Single(g => g.Name == "OverviewStatusRow");
                                var statusCards = statusRow.Children.OfType<Border>().ToArray();
                                if (statusCards.Length != 2 || Grid.GetRow(statusCards[0]) != Grid.GetRow(statusCards[1]) ||
                                    Grid.GetColumn(statusCards[1]) != 1 || Math.Abs(statusCards[0].ActualHeight - statusCards[1].ActualHeight) > 1)
                                    throw new Exception("Overview status and session cards must share an equal-height row at desktop width");
                                var cards = (Panel?)typeof(HostWindow).GetField("overviewDisplayCards", flags)?.GetValue(window);
                                if (cards is null || cards.Children.Count != 2) throw new Exception("Overview needs individual display cards, not the configuration map");
                                foreach (var card in cards.Children.OfType<Button>())
                                    foreach (var text in Descendants(card).OfType<TextBlock>())
                                    {
                                        var textPosition = text.TransformToVisual(card).TransformPoint(new Windows.Foundation.Point(0, 0));
                                        if (textPosition.Y < card.Padding.Top - 1 || textPosition.Y + text.ActualHeight > card.ActualHeight - card.Padding.Bottom + 1)
                                            throw new Exception("Overview display text is clipped by its card instead of fitting inside the padding");
                                    }
                            }
                            if (name == "Displays")
                            {
                                var identifyAction = Descendants(window.Content).OfType<Button>().Single(b => b.Content as string == "Identify displays");
                                if (!identifyAction.IsEnabled) throw new Exception("Identify must be available for an existing display inventory");
                                if (cycle == 0)
                                {
                                    await Task.Delay(500); // Let native expander transitions settle before rendering.
                                    var bitmap = new Microsoft.UI.Xaml.Media.Imaging.RenderTargetBitmap();
                                    await bitmap.RenderAsync(window.Content);
                                    var pixels = await bitmap.GetPixelsAsync();
                                    var bytes = new byte[pixels.Length];
                                    using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(pixels)) reader.ReadBytes(bytes);
                                    var folder = await Windows.Storage.StorageFolder.GetFolderFromPathAsync(AppContext.BaseDirectory);
                                    var file = await folder.CreateFileAsync("displays-flat.png", Windows.Storage.CreationCollisionOption.ReplaceExisting);
                                    using var output = await file.OpenAsync(Windows.Storage.FileAccessMode.ReadWrite);
                                    var encoder = await Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, output);
                                    encoder.SetPixelData(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied,
                                        (uint)bitmap.PixelWidth, (uint)bitmap.PixelHeight, 96, 96, bytes);
                                    await encoder.FlushAsync();
                                }
                                var page = (StackPanel)typeof(HostWindow).GetField("page", flags)!.GetValue(window)!;
                                var map = page.Children.OfType<Border>().Select(b => b.Child).OfType<Canvas>().Single();
                                var tiles = map.Children.OfType<Button>().ToArray();
                                var occupiedHeight = tiles.Max(t => Canvas.GetTop(t) + t.ActualHeight) - tiles.Min(Canvas.GetTop);
                                if (map.ActualHeight - occupiedHeight > 8)
                                    throw new Exception("Monitor canvas reserves empty vertical space beyond its arrangement");
                                foreach (var displayRow in page.Children.OfType<Expander>().Where(e => e.Header is Grid))
                                {
                                    var headerGrid = (Grid)displayRow.Header;
                                    if (headerGrid.ActualHeight - headerGrid.Children.OfType<FrameworkElement>().Max(c => c.ActualHeight) < 23)
                                        throw new Exception("Display header needs breathing room above and below its content");
                                }
                                var settingsPanel = page.Children.OfType<Border>().Select(b => b.Child).OfType<StackPanel>()
                                    .Single(p => p.Children.OfType<Grid>().Count() == 2);
                                if (settingsPanel.Children.OfType<Border>().Count() != 1)
                                    throw new Exception("Host defaults must use one separator, not nested cards");
                                foreach (var setting in settingsPanel.Children.OfType<Grid>())
                                {
                                    if (setting.ActualHeight > 80)
                                        throw new Exception("Desktop settings row has duplicate padding or an unused row gap");
                                    var editor = setting.Children.OfType<Control>().Single();
                                    if (!editor.IsEnabled) throw new Exception("Implemented host defaults must be editable");
                                    var position = editor.TransformToVisual(setting).TransformPoint(new Windows.Foundation.Point(0, 0));
                                    if (Math.Abs(position.X + editor.ActualWidth - (setting.ActualWidth - setting.Padding.Right)) > 1)
                                        throw new Exception("Settings editor does not align with the right content inset");
                                    if (editor is ToggleSwitch && editor.ActualWidth > 100)
                                        throw new Exception("Audio switch reserves an oversized blank tail after its short state label");
                                }
                                if (tiles.Length != 2 || tiles[0].ActualWidth <= tiles[0].ActualHeight || tiles[1].ActualWidth >= tiles[1].ActualHeight)
                                    throw new Exception("Display map lost landscape/portrait proportions");
                                if (Canvas.GetLeft(tiles[1]) >= Canvas.GetLeft(tiles[0]) || Canvas.GetTop(tiles[1]) >= Canvas.GetTop(tiles[0]))
                                    throw new Exception("Display map lost negative desktop coordinates");
                                foreach (var tile in tiles)
                                    if (Canvas.GetLeft(tile) < 0 || Canvas.GetTop(tile) < 0 || Canvas.GetLeft(tile) + tile.ActualWidth > map.ActualWidth + 1)
                                        throw new Exception("Display tile is outside the map");
                            }
                            if (name == "Sessions")
                            {
                                using var connected = JsonDocument.Parse("""
                                {"sessions":[{"id":"test-session","device":"iPhone","health":"Smooth","address":"127.0.0.1","connectedAt":0,"audio":true,"streams":[{"name":"Primary display","width":1280,"height":720,"targetFps":15,"profile":"test"}]}],"streamCount":1}
                                """);
                                update.Invoke(window, new object[] { connected.RootElement });
                                await Task.Delay(80);
                                var list = (StackPanel)typeof(HostWindow).GetField("sessionList", flags)!.GetValue(window)!;
                                if (list.Children.Count != 1) throw new Exception("Connected session missing");
                                ((Expander)list.Children[0]).IsExpanded = true;
                                await Task.Delay(80);
                                if (!Descendants(list).OfType<TextBlock>().Any(t => t.Text == "Connection stability"))
                                    throw new Exception("Session stability graph missing");
                                if (!Descendants(list).OfType<TextBlock>().Any(t => t.Text == "Waiting for telemetry"))
                                    throw new Exception("Missing telemetry must not be drawn as a healthy connection");
                                var graphFixture = System.Text.Json.Nodes.JsonNode.Parse(connected.RootElement.GetRawText())!;
                                var streamFixture = graphFixture["sessions"]![0]!["streams"]![0]!;
                                streamFixture["targetFps"] = 30;
                                streamFixture["stability"] = System.Text.Json.Nodes.JsonNode.Parse("""
                                {"at":60000,"stale":false,"serverStale":false,
                                 "generated":[{"at":10000,"captureFps":30,"encodeFps":29},{"at":11000,"captureFps":30,"encodeFps":30},{"at":59000,"captureFps":30,"encodeFps":30}],
                                 "points":[{"at":10000,"fps":30,"drops":null,"freezes":null,"recovery":null},
                                  {"at":11000,"fps":22,"drops":2,"freezes":1,"recovery":1,"lost":3,"rttMs":5,"jitterMs":7},
                                  {"at":59000,"fps":30,"drops":0,"freezes":0,"recovery":0}]}
                                """);
                                using var graphed = JsonDocument.Parse(graphFixture.ToJsonString());
                                update.Invoke(window, new object[] { graphed.RootElement });
                                await Task.Delay(500);
                                var plot = Descendants(list).OfType<Canvas>().Single();
                                if (plot.Children.OfType<Microsoft.UI.Xaml.Shapes.Line>().Count() != 5)
                                    throw new Exception("Expected three frame-flow segments plus target/baseline, with no line bridging the telemetry gap");
                                var markers = plot.Children.OfType<Button>().ToArray();
                                if (markers.Length != 3 || markers.Any(m => (ToolTipService.GetToolTip(m) as string)?.Contains("Frame drops: 2") != true))
                                    throw new Exception("Reported events need distinct interactive markers with interval details");
                                var identityText = Descendants(list).OfType<TextBlock>().Single(t => t.Text == "Primary display");
                                update.Invoke(window, new object[] { graphed.RootElement });
                                if (!ReferenceEquals(identityText, Descendants(list).OfType<TextBlock>().Single(t => t.Text == "Primary display")))
                                    throw new Exception("Telemetry tick rebuilt stable stream details");
                                var multiple = graphFixture.DeepClone();
                                multiple["capabilities"] = System.Text.Json.Nodes.JsonNode.Parse("{\"hostControl\":true,\"maxSessions\":2}");
                                var device = multiple["sessions"]![0]!;
                                device["control"] = "View only"; device["selectedStreamId"] = "stream-one";
                                device["streams"]![0]!["id"] = "stream-one";
                                var secondStream = device["streams"]![0]!.DeepClone();
                                secondStream["id"] = "stream-two"; secondStream["name"] = "Second display";
                                device["streams"]!.AsArray().Add(secondStream);
                                var secondDevice = device.DeepClone(); secondDevice["id"] = "other-session";
                                secondDevice["device"] = "Windows browser"; secondDevice["streams"]!.AsArray().RemoveAt(1);
                                secondDevice["streams"]![0]!["id"] = "stream-three";
                                secondDevice["selectedStreamId"] = "stream-three";
                                multiple["sessions"]!.AsArray().Add(secondDevice); multiple["streamCount"] = 3;
                                using var multiStatus = JsonDocument.Parse(multiple.ToJsonString());
                                update.Invoke(window, new object[] { multiStatus.RootElement });
                                await Task.Delay(100);
                                if (Descendants(list).OfType<Canvas>().Count() != 3) throw new Exception("Each stream needs its own graph");
                                if (Descendants(list).OfType<Button>().Count(b => b.Content as string == "Grant control") != 2)
                                    throw new Exception("Each device needs a host control action");
                                if (Descendants(list).OfType<Button>().Count(b => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(b) == "Stop stream") != 3)
                                    throw new Exception("Each stream needs its own stop action");
                                var stablePlots = Descendants(list).OfType<Canvas>().ToArray();
                                update.Invoke(window, new object[] { multiStatus.RootElement });
                                if (!stablePlots.SequenceEqual(Descendants(list).OfType<Canvas>())) throw new Exception("Telemetry rebuilt per-stream graphs");
                                if (cycle == 0)
                                {
                                    var startOwner = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
                                        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                                    startOwner.ArgumentList.Add(Path.GetFullPath("apps/windows-host/tests/Navigation/owner-fixture.mjs"));
                                    using var owner = System.Diagnostics.Process.Start(startOwner)!;
                                    var ownerField = typeof(HostWindow).GetField("server", flags)!;
                                    try {
                                        ownerField.SetValue(window, owner);
                                        async Task InvokeSession(Button button, string action, string? streamId) {
                                            var peer = new Microsoft.UI.Xaml.Automation.Peers.ButtonAutomationPeer(button);
                                            ((Microsoft.UI.Xaml.Automation.Provider.IInvokeProvider)peer.GetPattern(Microsoft.UI.Xaml.Automation.Peers.PatternInterface.Invoke)).Invoke();
                                            var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                            using var result = JsonDocument.Parse(line!);
                                            var received = result.RootElement.GetProperty("received");
                                            if (received.GetProperty("action").GetString() != action || received.GetProperty("sessionId").GetString() != "test-session" || received.GetProperty("streamId").GetString() != streamId)
                                                throw new Exception("Session button addressed the wrong device or stream");
                                            typeof(HostWindow).GetMethod("ReceiveSessionResult", flags)!.Invoke(window, new object[] { result.RootElement });
                                            await Task.Delay(40);
                                        }
                                        await InvokeSession(Descendants(list).OfType<Button>().First(b => b.Content as string == "Grant control"), "grant", null);
                                        device["control"] = "Granted";
                                        using var granted = JsonDocument.Parse(multiple.ToJsonString()); update.Invoke(window, new object[] { granted.RootElement });
                                        await InvokeSession(Descendants(list).OfType<Button>().Single(b => b.Content as string == "Revoke control"), "revoke", null);
                                        await InvokeSession(Descendants(list).OfType<Button>().First(b => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(b) == "Stop stream"), "stop-stream", "stream-one");
                                    } finally { ownerField.SetValue(window, null); owner.StandardInput.Close(); if (!owner.WaitForExit(5000)) owner.Kill(); }
                                }
                                if (Descendants(list).OfType<TextBlock>().Any(t => t.Text == "Waiting for telemetry" && t.Visibility == Visibility.Visible))
                                    throw new Exception("Fresh frame flow must replace the waiting state");
                                typeof(HostWindow).GetField("previewUrl", flags)!.SetValue(window, "http://127.0.0.1:45678/");
                                var diagnosticsAddress = typeof(HostWindow).GetMethod("DiagnosticsAddress", flags)!;
                                if ((string?)diagnosticsAddress.Invoke(window, null) != "http://127.0.0.1:45678/diagnostics")
                                    throw new Exception("Diagnostics must use the active host's loopback port");
                                typeof(HostWindow).GetField("previewUrl", flags)!.SetValue(window, "http://example.com:45678/");
                                if (diagnosticsAddress.Invoke(window, null) is not null) throw new Exception("Diagnostics link accepted a non-local endpoint");
                                if (cycle == 0)
                                {
                                    var bitmap = new Microsoft.UI.Xaml.Media.Imaging.RenderTargetBitmap();
                                    await bitmap.RenderAsync(window.Content);
                                    var pixels = await bitmap.GetPixelsAsync(); var bytes = new byte[pixels.Length];
                                    using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(pixels)) reader.ReadBytes(bytes);
                                    var folder = await Windows.Storage.StorageFolder.GetFolderFromPathAsync(AppContext.BaseDirectory);
                                    var file = await folder.CreateFileAsync("session-stability.png", Windows.Storage.CreationCollisionOption.ReplaceExisting);
                                    using var output = await file.OpenAsync(Windows.Storage.FileAccessMode.ReadWrite);
                                    var encoder = await Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, output);
                                    encoder.SetPixelData(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied,
                                        (uint)bitmap.PixelWidth, (uint)bitmap.PixelHeight, 96, 96, bytes);
                                    await encoder.FlushAsync();
                                }
                                using var empty = JsonDocument.Parse("{\"sessions\":[],\"streamCount\":0}");
                                update.Invoke(window, new object[] { empty.RootElement });
                                if (list.Children.Count != 0) throw new Exception("Disconnected session remains");
                            }
                        }
                    }
                    File.WriteAllText(Result, "PASS: title bar/themes; six-page navigation; footer/header actions; aligned profile columns; cosmetic reorder persistence without policy changes; profile/options modal cancel; owner-pipe mode/options persistence; display/Overview layout; session lifecycle.");
                    window.Close();
                    Exit();
                }
                catch (Exception error) { Fail(error); }
            });
        }
        catch (Exception error) { Fail(error); }
    }

    static IEnumerable<DependencyObject> Descendants(DependencyObject root)
    {
        for (int i = 0; i < Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChild(root, i);
            yield return child;
            foreach (var descendant in Descendants(child)) yield return descendant;
        }
    }
}
