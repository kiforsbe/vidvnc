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
                    {"schemaVersion":1,"revision":0,"profiles":[{"id":"balanced","name":"Balanced","description":"Everyday desktop use","enabled":true,"width":1920,"height":1080,"fps":30,"bitrateKbps":4000,"frameDelivery":"fixed","bitrateMode":"cbr","quality":"balanced"},{"id":"detail","name":"Detail","description":"Sharper text and fine detail","enabled":true,"width":1920,"height":1080,"fps":30,"bitrateKbps":6000,"frameDelivery":"fixed","bitrateMode":"vbr","quality":"high"}],"clientMode":"profiles","defaultProfileId":"auto","displayDefaults":{},"allowAudio":true,"videoCodecs":["av1","h264"],"allowedOptions":{"resolutions":[{"width":960,"height":540},{"width":1280,"height":720},{"width":1920,"height":1080},{"width":2560,"height":1440}],"frameRates":[15,30],"bitratesKbps":[1000,2000,4000,6000]}}
                    """);
                    updatePolicy.Invoke(window, new object[] { policyFixture.RootElement });
                    var updateDisplays = typeof(HostWindow).GetMethod("UpdateDisplays", flags);
                    if (updateDisplays is null) throw new Exception("Native display inventory view is missing");
                    var updateClients = typeof(HostWindow).GetMethod("UpdateClients", flags);
                    if (updateClients is null) throw new Exception("Approved clients administration view is missing");
                    var createConnectionDialog = typeof(HostWindow).GetMethod("CreateConnectionDialog", flags);
                    if (createConnectionDialog is null) throw new Exception("Shared connection dialog modes are missing");
                    var connectionQrUrl = typeof(HostWindow).GetMethod("ConnectionQrUrl", BindingFlags.Static | BindingFlags.NonPublic);
                    if (connectionQrUrl is null) throw new Exception("Connection QR links are missing");
                    var requestClientSetup = typeof(HostWindow).GetMethod("RequestClientSetupKey", flags);
                    var receiveClientResult = typeof(HostWindow).GetMethod("ReceiveClientResult", flags);
                    if (requestClientSetup is null || receiveClientResult is null)
                        throw new Exception("Desktop owner client command protocol is missing");
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
                        foreach (var name in new[] { "Sessions", "Overview", "Displays", "Streaming profiles", "Clients", "Access", "Settings", "Sessions", "Overview" })
                        {
                            navigation.SelectedItem = navigation.MenuItems.Concat(navigation.FooterMenuItems)
                                .OfType<NavigationViewItem>().Single(item => item.Tag as string == name);
                            await Task.Delay(80);
                            if (title.Text != name) throw new Exception($"Navigation did not reach {name}");
                            if (name == "Clients" && cycle == 0)
                            {
                                var menu = navigation.MenuItems.OfType<NavigationViewItem>().ToArray();
                                var sessionsIndex = Array.FindIndex(menu, item => item.Tag as string == "Sessions");
                                var clientsIndex = Array.FindIndex(menu, item => item.Tag as string == "Clients");
                                var accessIndex = Array.FindIndex(menu, item => item.Tag as string == "Access");
                                if (clientsIndex != sessionsIndex + 1 || accessIndex != clientsIndex + 1)
                                    throw new Exception("Clients must sit between Sessions and Access");
                                using var clientsFixture = JsonDocument.Parse("""
                                {"pending":[{"id":"pending-1","deviceName":"Alex’s iPhone","username":"alex","client":"Safari on iOS","network":"Local network","requestedAt":0,"password":"must-not-render"}],
                                 "approved":[{"id":"approved-1","deviceName":"Kim’s iPhone","username":"kim","client":"Safari on iOS","connected":true,"permission":"default","lastConnectedAt":0,"clientSecret":"must-not-render"},
                                             {"id":"approved-2","deviceName":"Work laptop","username":"kim-work","client":"Edge on Windows","connected":false,"permission":"view-only","lastConnectedLabel":"Last connected yesterday"}]}
                                """);
                                updateClients.Invoke(window, new object[] { clientsFixture.RootElement });
                                await Task.Delay(80);
                                var clientsAction = (Button?)((ContentControl)typeof(HostWindow).GetField("pageAction", flags)!.GetValue(window)!).Content;
                                if (clientsAction?.Content as string != "Connect a browser" || clientsAction.Tag as string != "approved-client")
                                    throw new Exception("Clients header must open Connect a browser in approved-client mode");
                                var visibleText = Descendants(shell).OfType<TextBlock>().Select(text => text.Text).ToArray();
                                if (!visibleText.Contains("2 approved clients · 1 waiting for approval"))
                                    throw new Exception("Clients summary does not reflect pending and approved counts");
                                if (!visibleText.Contains("Needs your approval") ||
                                    Descendants(shell).OfType<Grid>().Count(grid => grid.Tag as string == "pending-client-row") != 1)
                                    throw new Exception("Pending approved-client request is missing");
                                if (!visibleText.Contains("Approved clients") ||
                                    Descendants(shell).OfType<Grid>().Count(grid => grid.Tag as string == "approved-client-row") != 2)
                                    throw new Exception("Approved-client rows are missing");
                                var connected = Descendants(shell).OfType<TextBlock>().SingleOrDefault(text => text.Text == "● Connected");
                                if (connected?.Foreground is not Microsoft.UI.Xaml.Media.SolidColorBrush)
                                    throw new Exception("Connected client needs a semantic green status");
                                if (!visibleText.Contains("Last connected yesterday"))
                                    throw new Exception("Inactive approved client needs last-connected status");
                                if (visibleText.Contains("Active sessions"))
                                    throw new Exception("Session detail leaked onto the Clients page");
                                var lockdownButton = Descendants(shell).OfType<Button>().SingleOrDefault(button => button.Tag as string == "disconnect-ordinary");
                                if (lockdownButton?.Content as string != "Disconnect ordinary sessions now" ||
                                    !visibleText.Any(text => text.Contains("only blocks new ordinary sign-ins")))
                                    throw new Exception("The separate emergency ordinary-session disconnect action is missing");
                                var visibleInput = Descendants(shell).OfType<TextBox>().Select(input => input.Text);
                                if (visibleText.Concat(visibleInput).Any(text => text is "must-not-render"))
                                    throw new Exception("Password or client secret leaked into the Clients page");

                                ((TextBox)typeof(HostWindow).GetField("address", flags)!.GetValue(window)!).Text = "http://192.168.50.47:4382";
                                ((TextBox)typeof(HostWindow).GetField("password", flags)!.GetValue(window)!).Text = "NLYJ-LGFN";
                                if ((string)connectionQrUrl.Invoke(null, new object[] { "http://192.168.50.47:4382", "NLYJ-LGFN" })! !=
                                    "http://192.168.50.47:4382/#key=NLYJ-LGFN")
                                    throw new Exception("Connection QR links must keep the secret out of the request URL");
                                var onceDialog = (ContentDialog)createConnectionDialog.Invoke(window, new object[] { "connect-once" })!;
                                var onceBody = (StackPanel)onceDialog.Content;
                                var alphabet = onceBody.Children.OfType<ComboBox>()
                                    .Single(control => Equals(control.Tag, "code-alphabet"));
                                var generate = onceBody.Children.OfType<Button>()
                                    .Single(control => Equals(control.Tag, "generate-code"));
                                if (alphabet.SelectedIndex != 0) throw new Exception("Letters and numbers must be the default");
                                if (!generate.IsEnabled) throw new Exception("Code issuance requires an owner action");
                                var onceSelector = onceBody.Children.OfType<ComboBox>().Single(control => control.Tag as string == "connection-type");
                                var oncePanel = onceBody.Children.OfType<StackPanel>().Single(panel => panel.Tag as string == "connection-mode");
                                if (!onceSelector.Items.OfType<ComboBoxItem>().Select(item => item.Tag as string).SequenceEqual(new[] { "session-key", "one-time-key", "approved-client" }) ||
                                    ((onceSelector.SelectedItem as ComboBoxItem)?.Tag as string) != "session-key" ||
                                    !Descendants(oncePanel).OfType<TextBox>().Any(control => control.Tag as string == "Connection address" && control.Text == "http://192.168.50.47:4382") ||
                                    !Descendants(oncePanel).OfType<TextBox>().Any(control => control.Tag as string == "Session password" && control.Text == "NLYJ-LGFN"))
                                    throw new Exception("Connect-once mode lost the current address or Session password");
                                if (!Descendants(oncePanel).OfType<Image>().Any(image => image.Tag as string == "connection-qr-image"))
                                    throw new Exception("Connect-once mode must offer a scannable connection QR code");
                                if (Descendants(oncePanel).OfType<Button>().Count(button =>
                                    Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(button)?.StartsWith("Copy ") == true && button.Content is FontIcon) != 2)
                                    throw new Exception("Copy actions must be compact accessible icon buttons beside their fields");
                                onceSelector.SelectedItem = onceSelector.Items.OfType<ComboBoxItem>().Single(item => Equals(item.Tag, "one-time-key"));
                                if (Descendants(oncePanel).OfType<TextBox>().Any(control => Equals(control.Tag, "One-time connection key")) ||
                                    Descendants(oncePanel).OfType<Image>().Any(image => Equals(image.Tag, "connection-qr-image")))
                                    throw new Exception("Switching to a one-time key must not issue a code");
                                var updateCodeStatus = typeof(HostWindow).GetMethod("UpdateCodeStatus", flags)!;
                                using (var lockedCode = JsonDocument.Parse("{\"codes\":{\"ephemeral\":{\"locked\":true},\"session\":{\"locked\":false}}}"))
                                    updateCodeStatus.Invoke(window, new object[] { lockedCode.RootElement });
                                if (!oncePanel.Children.OfType<InfoBar>().Any(bar => bar.Message.Contains("attempts are exhausted")))
                                    throw new Exception("A locked code needs a visible warning and regeneration path");
                                using (var unlockedCode = JsonDocument.Parse("{\"codes\":{\"ephemeral\":{\"locked\":false},\"session\":{\"locked\":false}}}"))
                                    updateCodeStatus.Invoke(window, new object[] { unlockedCode.RootElement });
                                onceSelector.SelectedItem = onceSelector.Items.OfType<ComboBoxItem>().Single(item => Equals(item.Tag, "approved-client"));
                                if (Descendants(oncePanel).OfType<TextBox>().Any(control => Equals(control.Tag, "Client setup key")) ||
                                    Descendants(oncePanel).OfType<Image>().Any(image => Equals(image.Tag, "connection-qr-image")))
                                    throw new Exception("Switching to client registration must not issue a code");

                                var ownerStart = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
                                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                                ownerStart.ArgumentList.Add(Path.GetFullPath("apps/windows-host/tests/Navigation/owner-fixture.mjs"));
                                using var clientOwner = System.Diagnostics.Process.Start(ownerStart)!;
                                var clientServerField = typeof(HostWindow).GetField("server", flags)!;
                                clientServerField.SetValue(window, clientOwner);
                                var setupTask = (Task)requestClientSetup.Invoke(window, new object[] { "letters" })!;
                                var setupLine = await clientOwner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                using (var setupResult = JsonDocument.Parse(setupLine!))
                                {
                                    if (setupResult.RootElement.GetProperty("received").GetProperty("type").GetString() != "client-setup-create")
                                        throw new Exception("Host requested the wrong client setup operation");
                                    if (setupResult.RootElement.GetProperty("received").GetProperty("alphabet").GetString() != "letters")
                                        throw new Exception("Host did not send its selected alphabet");
                                    receiveClientResult.Invoke(window, new object[] { setupResult.RootElement });
                                }
                                await setupTask;
                                var approvalDialog = (ContentDialog)createConnectionDialog.Invoke(window, new object[] { "approved-client" })!;
                                var approvalBody = (StackPanel)approvalDialog.Content;
                                var approvalSelector = approvalBody.Children.OfType<ComboBox>().Single(control => control.Tag as string == "connection-type");
                                var approvalPanel = approvalBody.Children.OfType<StackPanel>().Single(panel => panel.Tag as string == "connection-mode");
                                var setupKey = Descendants(approvalPanel).OfType<TextBox>().SingleOrDefault(control => control.Tag as string == "Client setup key");
                                if (((approvalSelector.SelectedItem as ComboBoxItem)?.Tag as string) != "approved-client" || setupKey is null || !setupKey.IsReadOnly ||
                                    !System.Text.RegularExpressions.Regex.IsMatch(setupKey.Text, "^[A-Z]{4}-[A-Z]{4}$") ||
                                    Descendants(approvalPanel).OfType<TextBox>().Any(control => control.Text == "NLYJ-LGFN") ||
                                    !approvalPanel.Children.OfType<TextBlock>().Any(text => text.Text.Contains("Single use")) ||
                                    !Descendants(approvalPanel).OfType<Image>().Any(image => image.Tag as string == "connection-qr-image"))
                                    throw new Exception("Approved-client mode must hide the Session password and show its server-issued single-use key");
                                var disconnectOrdinary = typeof(HostWindow).GetMethod("DisconnectOrdinarySessions", flags)!;
                                var disconnectTask = (Task)disconnectOrdinary.Invoke(window, null)!;
                                var disconnectLine = await clientOwner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                using (var disconnectResult = JsonDocument.Parse(disconnectLine!))
                                {
                                    if (disconnectResult.RootElement.GetProperty("received").GetProperty("type").GetString() != "ordinary-sessions-disconnect")
                                        throw new Exception("Host did not send its explicit ordinary-session disconnect command");
                                    receiveClientResult.Invoke(window, new object[] { disconnectResult.RootElement });
                                }
                                await disconnectTask;
                                clientServerField.SetValue(window, null);
                                clientOwner.StandardInput.Close();
                                if (!clientOwner.WaitForExit(5000)) clientOwner.Kill();
                                var clientsBitmap = new Microsoft.UI.Xaml.Media.Imaging.RenderTargetBitmap();
                                await clientsBitmap.RenderAsync(window.Content);
                                var clientPixels = await clientsBitmap.GetPixelsAsync();
                                var clientBytes = new byte[clientPixels.Length];
                                using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(clientPixels)) reader.ReadBytes(clientBytes);
                                var clientFolder = await Windows.Storage.StorageFolder.GetFolderFromPathAsync(AppContext.BaseDirectory);
                                var clientFile = await clientFolder.CreateFileAsync("clients-page.png", Windows.Storage.CreationCollisionOption.ReplaceExisting);
                                using var clientOutput = await clientFile.OpenAsync(Windows.Storage.FileAccessMode.ReadWrite);
                                var clientEncoder = await Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, clientOutput);
                                clientEncoder.SetPixelData(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied,
                                    (uint)clientsBitmap.PixelWidth, (uint)clientsBitmap.PixelHeight, 96, 96, clientBytes);
                                await clientEncoder.FlushAsync();
                            }
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
                                    using var initialAccess = JsonDocument.Parse("{\"revision\":0,\"defaultControl\":\"approval\",\"connectionMode\":\"session-key\"}");
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
                                    foreach (var index in new[] { 1, 2, 0 })
                                    {
                                        var method = Descendants(shell).OfType<ComboBox>().Single(c => c.Tag as string == "connection-mode");
                                        if (!method.IsEnabled) throw new Exception("Connection method is disabled with a ready owner");
                                        method.SelectedIndex = index;
                                        var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                        using var reply = JsonDocument.Parse(line!);
                                        var expected = index == 1 ? "one-time-keys" : index == 2 ? "approved-only" : "session-key";
                                        if (!reply.RootElement.GetProperty("ok").GetBoolean() ||
                                            reply.RootElement.GetProperty("access").GetProperty("connectionMode").GetString() != expected)
                                            throw new Exception("Connection method was not persisted through owner pipe");
                                        typeof(HostWindow).GetMethod("ReceiveAccessResult", flags)!.Invoke(window, new object[] { reply.RootElement });
                                        await Task.Delay(80);
                                        method = Descendants(shell).OfType<ComboBox>().Single(c => c.Tag as string == "connection-mode");
                                        if (method.SelectedIndex != index || !method.IsEnabled)
                                            throw new Exception("Saved connection method was not reflected in the UI");
                                    }
                                    foreach (var index in new[] { 7, 0, 3 })
                                    {
                                        var limit = Descendants(shell).OfType<ComboBox>().Single(c => c.Tag as string == "max-sessions");
                                        if (!limit.IsEnabled || limit.Items.Count != 8) throw new Exception("Device limit must offer 1–8 devices with a ready owner");
                                        limit.SelectedIndex = index;
                                        var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                        using var reply = JsonDocument.Parse(line!);
                                        if (!reply.RootElement.GetProperty("ok").GetBoolean() ||
                                            reply.RootElement.GetProperty("access").GetProperty("maxSessions").GetInt32() != index + 1)
                                            throw new Exception("Device limit was not persisted through owner pipe");
                                        typeof(HostWindow).GetMethod("ReceiveAccessResult", flags)!.Invoke(window, new object[] { reply.RootElement });
                                        await Task.Delay(80);
                                        limit = Descendants(shell).OfType<ComboBox>().Single(c => c.Tag as string == "max-sessions");
                                        if (limit.SelectedIndex != index || !limit.IsEnabled)
                                            throw new Exception("Saved device limit was not reflected in the UI");
                                    }
                                }
                                finally { serverField.SetValue(window, null); owner.StandardInput.Close(); if (!owner.WaitForExit(5000)) owner.Kill(); }
                            }
                            if (name == "Settings" && cycle == 0)
                            {
                                var publicNameStart = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
                                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                                publicNameStart.ArgumentList.Add(Path.GetFullPath("apps/windows-host/tests/Navigation/owner-fixture.mjs"));
                                using var publicNameOwner = System.Diagnostics.Process.Start(publicNameStart)!;
                                var publicNameServer = typeof(HostWindow).GetField("server", flags)!;
                                try
                                {
                                    publicNameServer.SetValue(window, publicNameOwner);
                                    using var publicNameAccess = JsonDocument.Parse("{\"revision\":0,\"defaultControl\":\"approval\",\"connectionMode\":\"session-key\",\"maxSessions\":4,\"publicName\":\"Friendly test host\"}");
                                    typeof(HostWindow).GetMethod("UpdateAccess", flags)!.Invoke(window, new object[] { publicNameAccess.RootElement });
                                    var publicNameField = Descendants(shell).OfType<TextBox>().SingleOrDefault(box => box.Tag as string == "public-name");
                                    var savePublicName = Descendants(shell).OfType<Button>().SingleOrDefault(button => button.Tag as string == "save-public-name");
                                    if (publicNameField?.Text != "Friendly test host" || !publicNameField.IsEnabled || savePublicName?.IsEnabled != false)
                                        throw new Exception("Settings must show an editable saved public login name");
                                    publicNameField.Text = new string('A', 81);
                                    await Task.Delay(80);
                                    if (savePublicName.IsEnabled || !Descendants(shell).OfType<TextBlock>().Any(text => text.Text == "Use 1–80 characters."))
                                        throw new Exception("Settings must explain and block public login names longer than 80 characters");
                                    publicNameField.Text = "  Living room PC  ";
                                    await Task.Delay(80);
                                    if (!savePublicName.IsEnabled) throw new Exception($"Editing the public login name must enable Save (text='{publicNameField.Text}', fieldEnabled={publicNameField.IsEnabled}, saveEnabled={savePublicName.IsEnabled})");
                                    var publicNamePeer = new Microsoft.UI.Xaml.Automation.Peers.ButtonAutomationPeer(savePublicName);
                                    ((Microsoft.UI.Xaml.Automation.Provider.IInvokeProvider)publicNamePeer.GetPattern(Microsoft.UI.Xaml.Automation.Peers.PatternInterface.Invoke)).Invoke();
                                    var publicNameLine = await publicNameOwner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                    using var publicNameReply = JsonDocument.Parse(publicNameLine!);
                                    if (!publicNameReply.RootElement.GetProperty("ok").GetBoolean() ||
                                        publicNameReply.RootElement.GetProperty("access").GetProperty("publicName").GetString() != "Living room PC")
                                        throw new Exception("Public login name was not persisted through the owner pipe");
                                    typeof(HostWindow).GetMethod("ReceiveAccessResult", flags)!.Invoke(window, new object[] { publicNameReply.RootElement });
                                    await Task.Delay(80);
                                    publicNameField = Descendants(shell).OfType<TextBox>().SingleOrDefault(box => box.Tag as string == "public-name");
                                    if (publicNameField?.Text != "Living room PC")
                                        throw new Exception("Settings did not show the saved public login name");
                                }
                                finally { publicNameServer.SetValue(window, null); publicNameOwner.StandardInput.Close(); if (!publicNameOwner.WaitForExit(5000)) publicNameOwner.Kill(); }

                                // The HTTPS section. Everything asserted here is driven by one
                                // input — the `tls` object the server puts on its periodic status
                                // message — so this exercises the same path the running host uses,
                                // with no certificate tooling anywhere near it.
                                var updateTls = typeof(HostWindow).GetMethod("UpdateTlsStatus", flags)!;
                                var renderPage = typeof(HostWindow).GetMethod("RenderPage", flags)!;
                                var enrolmentUrl = typeof(HostWindow).GetMethod("EnrolmentUrl", flags)!;
                                var addressBox = (TextBox)typeof(HostWindow).GetField("address", flags)!.GetValue(window)!;
                                var serverField = typeof(HostWindow).GetField("server", flags)!;
                                var connectButton = (Button)typeof(HostWindow).GetField("connectDevice", flags)!.GetValue(window)!;
                                var previewButton = (Button)typeof(HostWindow).GetField("openPreview", flags)!.GetValue(window)!;
                                setSharing.Invoke(window, new object[] { true });
                                typeof(HostWindow).GetField("plaintextAddress", flags)!.SetValue(window, "http://192.168.50.47:4382");

                                string TlsStatus(string tls)
                                {
                                    using var parsed = JsonDocument.Parse(tls);
                                    var root = parsed.RootElement;
                                    var active = root.GetProperty("active").GetBoolean();
                                    var mode = root.GetProperty("mode").GetString();
                                    var reason = root.GetProperty("reason").ValueKind == JsonValueKind.String;
                                    var viewerUrls = active ? "[\"https://192.168.50.47:4383\",\"https://127.0.0.1:4383\"]" : mode == "off" && !reason ? "[\"http://192.168.50.47:4382\",\"http://127.0.0.1:4382\"]" : "[]";
                                    var extra = $"\"viewerReady\":{(viewerUrls == "[]" ? "false" : "true")},\"httpViewerEnabled\":{(mode == "off" && !reason ? "true" : "false")},\"viewerUrls\":{viewerUrls},\"localHttpUrls\":[\"http://192.168.50.47:4382\",\"http://127.0.0.1:4382\"]";
                                    return $"{{\"type\":\"status\",\"sessions\":[],\"streamCount\":0,\"tls\":{{{tls.TrimStart('{').TrimEnd('}')},{extra}}}}}";
                                }
                                async Task ApplyTls(string tls)
                                {
                                    using var document = JsonDocument.Parse(TlsStatus(tls));
                                    updateTls.Invoke(window, new object[] { document.RootElement });
                                    renderPage.Invoke(window, null);
                                    await Task.Delay(80);
                                }
                                TextBlock? TlsText(string tag) => Descendants(shell).OfType<TextBlock>().SingleOrDefault(t => t.Tag as string == tag);
                                Button? TlsButton(string tag) => Descendants(shell).OfType<Button>().SingleOrDefault(b => b.Tag as string == tag);
                                InfoBar? TlsBar(string tag) => Descendants(shell).OfType<InfoBar>().SingleOrDefault(b => b.Tag as string == tag);

                                const string selfSigned = "{\"mode\":\"auto\",\"active\":true,\"port\":4383,\"strategy\":\"windows-self-signed\",\"enrolmentStatus\":\"required\",\"fingerprint\":\"AA:BB:CC:DD:EE:FF\",\"expiry\":\"2036-09-21T10:00:00.000Z\",\"expired\":false,\"needsRenewal\":false,\"reason\":null}";
                                await ApplyTls(selfSigned);
                                if (!Descendants(shell).OfType<Border>().Any(b => b.Tag as string == "tls-section"))
                                    throw new Exception("Settings page is missing the HTTPS section");
                                if (TlsText("tls-mode")?.Text != "Automatic")
                                    throw new Exception($"HTTPS mode not shown: '{TlsText("tls-mode")?.Text}'");
                                if (TlsText("tls-active")?.Text != "Running on port 4383")
                                    throw new Exception($"HTTPS listener state not shown: '{TlsText("tls-active")?.Text}'");
                                if (TlsText("tls-strategy")?.Text.Contains("windows-self-signed") != true)
                                    throw new Exception($"Active strategy must be named: '{TlsText("tls-strategy")?.Text}'");
                                if (TlsText("tls-fingerprint")?.Text != "AA:BB:CC:DD:EE:FF")
                                    throw new Exception($"Certificate fingerprint not shown: '{TlsText("tls-fingerprint")?.Text}'");
                                if (TlsText("tls-expiry")?.Text.Contains("2036") != true)
                                    throw new Exception($"Certificate expiry not shown: '{TlsText("tls-expiry")?.Text}'");
                                if (TlsText("tls-reissue-note")?.Text.Contains("enrolling every device again") != true)
                                    throw new Exception($"Self-signed reissue must warn that enrolment is invalidated: '{TlsText("tls-reissue-note")?.Text}'");
                                if (TlsBar("tls-reason") is not null)
                                    throw new Exception("A healthy listener must not show a failure reason");
                                // Spec: the address shown encodes HTTPS once TLS is up.
                                if (addressBox.Text != "https://192.168.50.47:4383")
                                    throw new Exception($"Connection address did not move to HTTPS: '{addressBox.Text}'");
                                if (!connectButton.IsEnabled || !previewButton.IsEnabled)
                                    throw new Exception("Active HTTPS should enable connection and loopback preview actions");
                                // The enrolment page stays on the plaintext listener: a device that
                                // does not trust this PC yet cannot fetch the anchor over HTTPS.
                                var trustUrl = (string?)enrolmentUrl.Invoke(window, null);
                                if (trustUrl != "http://192.168.50.47:4382/trust")
                                    throw new Exception($"Enrolment QR must point at the plaintext trust page: '{trustUrl}'");
                                var qrPng = HostWindow.EnrolmentQrPng(trustUrl!);
                                if (qrPng.Length < 100 || qrPng[0] != 0x89 || qrPng[1] != 'P' || qrPng[2] != 'N' || qrPng[3] != 'G')
                                    throw new Exception($"Enrolment QR code was not rendered locally as a PNG ({qrPng.Length} bytes)");
                                if (TlsButton("tls-enrolment-qr")?.IsEnabled != true)
                                    throw new Exception("Show enrolment QR code must be available while HTTPS is running");
                                if (TlsButton("tls-regenerate") is not { } stoppedRegenerate || stoppedRegenerate.IsEnabled)
                                    throw new Exception("Regenerate cannot be offered while the server is stopped");

                                // mkcert: the anchor is the CA, which a reissue does not touch, so
                                // the enrolment warning must not appear.
                                await ApplyTls("{\"mode\":\"auto\",\"active\":true,\"port\":4383,\"strategy\":\"mkcert\",\"enrolmentStatus\":\"required\",\"fingerprint\":\"11:22:33\",\"expiry\":\"2036-09-21T10:00:00.000Z\",\"expired\":false,\"needsRenewal\":false,\"reason\":null}");
                                if (TlsText("tls-strategy")?.Text.Contains("mkcert") != true)
                                    throw new Exception("mkcert strategy must be named");
                                if (TlsText("tls-reissue-note")?.Text.Contains("enrolling every device again") == true)
                                    throw new Exception("mkcert reissue must not claim enrolment is invalidated");

                                // provided: the operator's own certificate is never replaced.
                                await ApplyTls("{\"mode\":\"provided\",\"active\":true,\"port\":4383,\"strategy\":\"provided\",\"enrolmentStatus\":\"unknown\",\"fingerprint\":\"44:55:66\",\"expiry\":\"2036-09-21T10:00:00.000Z\",\"expired\":false,\"needsRenewal\":false,\"reason\":null}");
                                if (TlsButton("tls-regenerate")?.IsEnabled != false || TlsText("tls-regenerate-blocked") is null)
                                    throw new Exception("A supplied certificate must not offer a regenerate action, and must say why");

                                // Deliberate off: LAN-only HTTP remains a viewer option.
                                await ApplyTls("{\"mode\":\"off\",\"active\":false,\"port\":null,\"strategy\":null,\"enrolmentStatus\":null,\"fingerprint\":null,\"expiry\":null,\"expired\":false,\"needsRenewal\":false,\"reason\":null}");
                                if (TlsButton("tls-regenerate")?.IsEnabled != false || TlsText("tls-regenerate-blocked") is null)
                                    throw new Exception("Regenerate must be unavailable and explained while HTTPS is off");
                                if (addressBox.Text != "http://192.168.50.47:4382")
                                    throw new Exception($"Address must return to plaintext when HTTPS is off: '{addressBox.Text}'");
                                if (!connectButton.IsEnabled || !previewButton.IsEnabled)
                                    throw new Exception("Deliberate LAN HTTP should retain connection and preview actions");
                                if (TlsBar("tls-reason") is not null)
                                    throw new Exception("A deliberate off must not be reported as a failure");

                                // off with a reason: the settings file could not be used, so TLS is
                                // off without anyone asking for it. That must not read as a clean,
                                // deliberate "Off" — the sanitized sentence has to reach the UI.
                                await ApplyTls("{\"mode\":\"off\",\"active\":false,\"port\":null,\"strategy\":null,\"enrolmentStatus\":null,\"fingerprint\":null,\"expiry\":null,\"expired\":false,\"needsRenewal\":false,\"reason\":\"The TLS settings could not be used, so HTTPS is off. Nothing was changed; the server log says why.\"}");
                                if (!addressBox.Text.Contains("HTTPS unavailable"))
                                    throw new Exception("Invalid TLS settings must not show a usable HTTP viewer address");
                                if (connectButton.IsEnabled || previewButton.IsEnabled)
                                    throw new Exception("Invalid TLS settings must disable connection and preview actions");
                                if (TlsBar("tls-reason")?.Message?.Contains("TLS settings could not be used") != true)
                                    throw new Exception($"An unusable TLS settings file must be reported, not shown as a deliberate off: '{TlsBar("tls-reason")?.Message}'");
                                if (TlsButton("tls-regenerate")?.IsEnabled != false || TlsText("tls-regenerate-blocked") is null)
                                    throw new Exception("Regenerate must stay unavailable and explained while HTTPS is off for any reason");

                                // Provisioning failed: TLS never degrades silently.
                                const string failedAuto = "{\"mode\":\"auto\",\"active\":false,\"port\":null,\"strategy\":null,\"enrolmentStatus\":null,\"fingerprint\":null,\"expiry\":null,\"expired\":false,\"needsRenewal\":false,\"reason\":\"HTTPS could not be started on port 4383, so connections are not encrypted. The server log says why.\"}";
                                await ApplyTls(failedAuto);
                                if (!addressBox.Text.Contains("HTTPS unavailable"))
                                    throw new Exception("Failed auto TLS must not show a usable HTTP viewer address");
                                if (connectButton.IsEnabled || previewButton.IsEnabled)
                                    throw new Exception("Failed HTTPS must disable connection and preview actions");
                                if (TlsBar("tls-reason")?.Message?.Contains("could not be started on port 4383") != true)
                                    throw new Exception("A failed HTTPS start must be reported in the host UI, not silently");
                                await ApplyTls("{\"mode\":\"auto\",\"active\":false,\"port\":null,\"strategy\":null,\"enrolmentStatus\":null,\"fingerprint\":null,\"expiry\":null,\"expired\":false,\"needsRenewal\":false,\"reason\":\"HTTPS has not started yet. The viewer is waiting; HTTP viewer access is disabled.\"}");
                                if (addressBox.Text != "Waiting for HTTPS" || connectButton.IsEnabled || previewButton.IsEnabled)
                                    throw new Exception("Pending HTTPS must show a waiting state with viewer controls disabled");

                                // An expired certificate must be flagged even though the server
                                // reports needsRenewal:false for it.
                                await ApplyTls("{\"mode\":\"auto\",\"active\":true,\"port\":4383,\"strategy\":\"windows-self-signed\",\"enrolmentStatus\":\"required\",\"fingerprint\":\"77:88:99\",\"expiry\":\"2020-01-01T00:00:00.000Z\",\"expired\":true,\"needsRenewal\":false,\"reason\":null}");
                                if (TlsBar("tls-renewal") is null || TlsText("tls-expiry")?.Text.Contains("expired") != true)
                                    throw new Exception("An expired certificate must be flagged, not hidden by needsRenewal being false");

                                var tlsStart = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
                                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                                tlsStart.ArgumentList.Add(Path.GetFullPath("apps/windows-host/tests/Navigation/owner-fixture.mjs"));
                                using var tlsOwner = System.Diagnostics.Process.Start(tlsStart)!;
                                try
                                {
                                    serverField.SetValue(window, tlsOwner);
                                    await ApplyTls(selfSigned);
                                    var regenerate = TlsButton("tls-regenerate")!;
                                    if (!regenerate.IsEnabled) throw new Exception("Regenerate must be available for a generated certificate with a ready owner");
                                    var regeneratePeer = new Microsoft.UI.Xaml.Automation.Peers.ButtonAutomationPeer(regenerate);
                                    ((Microsoft.UI.Xaml.Automation.Provider.IInvokeProvider)regeneratePeer.GetPattern(Microsoft.UI.Xaml.Automation.Peers.PatternInterface.Invoke)).Invoke();
                                    var regenerateLine = await tlsOwner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                    using var regenerateResult = JsonDocument.Parse(regenerateLine!);
                                    if (regenerateResult.RootElement.GetProperty("received").GetProperty("type").GetString() != "tls-regenerate")
                                        throw new Exception("Regenerate sent the wrong owner-pipe command");
                                    typeof(HostWindow).GetMethod("ReceiveTlsRegenerateResult", flags)!.Invoke(window, new object[] { regenerateResult.RootElement });
                                    for (int i = 0; i < 200 && (bool)typeof(HostWindow).GetField("tlsRegenerating", flags)!.GetValue(window)!; i++) await Task.Delay(10);
                                    if (typeof(HostWindow).GetField("tlsError", flags)!.GetValue(window) is string regenerateError)
                                        throw new Exception("Regenerate reported an error: " + regenerateError);

                                    // Provisioning has failed, so no strategy has won — but HTTPS is
                                    // still configured and the server is running, so the button is
                                    // live. Whatever the server would reissue from may well be a
                                    // self-signed leaf that is its own trust anchor, so the
                                    // consequence has to be stated even though it cannot be named
                                    // precisely. This state is only reachable with a running server,
                                    // which is why the earlier failure case (server == null) misses it.
                                    await ApplyTls(failedAuto);
                                    var recoveryRegenerate = TlsButton("tls-regenerate")!;
                                    if (!recoveryRegenerate.IsEnabled)
                                        throw new Exception("Regenerate must stay available as the way out of a failed provision");
                                    if (TlsText("tls-reissue-note")?.Text.Contains("trust the new one again") != true)
                                        throw new Exception($"Regenerate offered with no reissue consequence stated: '{TlsText("tls-reissue-note")?.Text}'");

                                    // A stale "was not regenerated" banner must not outlive the
                                    // problem: a report that recovers clears it.
                                    typeof(HostWindow).GetField("tlsError", flags)!.SetValue(window, "stale regenerate failure");
                                    await ApplyTls(selfSigned);
                                    if (typeof(HostWindow).GetField("tlsError", flags)!.GetValue(window) is not null)
                                        throw new Exception("A recovered HTTPS report must clear the stale regenerate error");
                                    if (TlsBar("tls-error") is not null)
                                        throw new Exception("A cleared regenerate error must leave no banner behind");

                                    // The QR really renders, rather than leaving a blank square.
                                    var qrImage = new Image();
                                    await HostWindow.ApplyQrSource(qrImage, trustUrl!);
                                    if (qrImage.Source is not Microsoft.UI.Xaml.Media.Imaging.BitmapImage { PixelWidth: > 0 })
                                        throw new Exception("Enrolment QR code did not decode into an image source");
                                }
                                finally
                                {
                                    serverField.SetValue(window, null); tlsOwner.StandardInput.Close();
                                    if (!tlsOwner.WaitForExit(5000)) tlsOwner.Kill();
                                    setSharing.Invoke(window, new object[] { false });
                                    renderPage.Invoke(window, null);
                                }
                            }
                            if (name == "Streaming profiles")
                            {
                                var menu = navigation.MenuItems.OfType<NavigationViewItem>().ToArray();
                                if (menu[2].Tag as string != "Streaming profiles") throw new Exception("Profiles tab must follow Displays");
                                var profileRows = Descendants(window.Content).OfType<Grid>().Where(g => g.Tag as string == "profile-row").ToArray();
                                if (profileRows.Length != 2 || !Descendants(profileRows[0]).OfType<ToggleSwitch>().Any())
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
                                    // Encoder selector: exactly Automatic plus the backends this
                                    // machine reported, and an honest notice when the saved
                                    // setting names hardware that is not here.
                                    var backendsField = typeof(HostWindow).GetField("hostBackends", flags)!;
                                    backendsField.SetValue(window, new[] { ("nvenc", "NVIDIA NVENC"), ("amf", "AMD AMF") });
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null); await Task.Delay(80);
                                    var encoderBox = Descendants(shell).OfType<ComboBox>().Single(c => c.Tag as string == "encoder-backend");
                                    var encoderLabels = encoderBox.Items.OfType<ComboBoxItem>().Select(i => i.Content as string).ToArray();
                                    if (!encoderLabels.SequenceEqual(new[] { "Automatic", "NVIDIA NVENC", "AMD AMF" }))
                                        throw new Exception("Encoder options must be Automatic plus exactly the reported backends, got: " + string.Join(", ", encoderLabels));
                                    if (encoderBox.SelectedIndex != 0) throw new Exception("An unset encoder must show as Automatic");
                                    var policyField = typeof(HostWindow).GetField("streamPolicy", flags)!;
                                    var forcedPolicy = System.Text.Json.Nodes.JsonNode.Parse(policyFixture.RootElement.GetRawText())!.AsObject();
                                    forcedPolicy["encoderBackend"] = "qsv";
                                    using (var forcedDocument = JsonDocument.Parse(forcedPolicy.ToJsonString()))
                                        updatePolicy.Invoke(window, new object[] { forcedDocument.RootElement });
                                    await Task.Delay(80);
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null); await Task.Delay(80);
                                    if (!Descendants(shell).OfType<TextBlock>().Any(t => t.Text is string s && s.Contains("not available on this PC")))
                                        throw new Exception("A forced backend this machine lacks must be reported as substituted, not shown as in effect");
                                    var restorePolicy = System.Text.Json.Nodes.JsonNode.Parse(policyFixture.RootElement.GetRawText())!.AsObject();
                                    using (var restoreDocument = JsonDocument.Parse(restorePolicy.ToJsonString()))
                                        updatePolicy.Invoke(window, new object[] { restoreDocument.RootElement });
                                    await Task.Delay(80);
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null); await Task.Delay(80);
                                    var snapshotField = policyField;
                                    var reorderPolicy = System.Text.Json.Nodes.JsonNode.Parse(policyFixture.RootElement.GetRawText())!.AsObject();
                                    reorderPolicy["profiles"]!.AsArray().RemoveAt(1);
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
                                    if (description.Text != "Everyday desktop use" || Descendants(editor).OfType<NumberBox>().Count() != 1)
                                        throw new Exception("Profile modal must include description and the video bitrate number box");
                                    var editableCombos = Descendants(editor).OfType<ComboBox>().Where(c => c.IsEditable).ToArray();
                                    var sizeCombo = editableCombos.SingleOrDefault(c => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(c) == "Output size");
                                    var rateCombo = editableCombos.SingleOrDefault(c => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(c) == "Frame rate (fps)");
                                    var visibleRatio = Descendants(editor).OfType<TextBlock>().Any(t => t.Visibility == Visibility.Visible && t.Text.Contains("16:9"));
                                    if (sizeCombo?.Text != "1920 × 1080" || rateCombo?.Text != "30" || !visibleRatio || Descendants(editor).OfType<RadioButton>().Any())
                                        throw new Exception($"Profile modal must expose editable Output size ('{sizeCombo?.Text}') and Frame rate ('{rateCombo?.Text}') combos, a visible 16:9 aspect ratio ({visibleRatio}) and no RadioButtons");
                                    description.Text = "Uncommitted edit";
                                    editor.Hide(); await showing;
                                    if (((System.Text.Json.Nodes.JsonObject)snapshotField.GetValue(window)!).ToJsonString() != before)
                                        throw new Exception("Canceling profile editor mutated the policy snapshot");
                                    var variableRow = Descendants(shell).OfType<Grid>().Single(g => g.Tag as string == "profile-row" &&
                                        Descendants(g).OfType<TextBlock>().Any(t => t.Text == "Detail"));
                                    var variableText = Descendants(variableRow).OfType<TextBlock>().Select(t => t.Text).ToArray();
                                    if (!variableText.Any(t => t.Contains("up to")) || !variableText.Any(t => t.Contains("Variable")))
                                        throw new Exception("Variable profile row must show its cap as 'up to' and the Variable mode");
                                    var variableSource = System.Text.Json.Nodes.JsonNode.Parse(policyFixture.RootElement.GetProperty("profiles")[1].GetRawText())!.AsObject();
                                    var variableEditor = (ContentDialog)typeof(HostWindow).GetMethod("CreateProfileEditor", flags)!.Invoke(window, new object?[] { variableSource, false })!;
                                    var variableShowing = variableEditor.ShowAsync();
                                    await Task.Delay(120);
                                    var variableChoices = Descendants(variableEditor).OfType<ComboBox>().Select(c => c.Header as string).ToArray();
                                    variableEditor.Hide(); await variableShowing;
                                    if (!variableChoices.Contains("Bitrate mode") || !variableChoices.Contains("Quality"))
                                        throw new Exception("Profile modal must expose Bitrate mode and Quality choices");
                                    var serverField = typeof(HostWindow).GetField("server", flags)!;
                                    serverField.SetValue(window, System.Diagnostics.Process.GetCurrentProcess());
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null);
                                    await Task.Delay(80);
                                    var modes = Descendants(shell).OfType<RadioButton>().ToArray();
                                    if (modes.Length != 2 || modes.Any(r => !r.IsEnabled)) throw new Exception("Customization modes remain disabled with an available server");
                                    var editOptions = Descendants(shell).OfType<Button>().Single(b => b.Content as string == "Edit allowed options");
                                    if (!editOptions.IsEnabled || editOptions.TransformToVisual(shell).TransformPoint(new(0, 0)).X <= modes[0].TransformToVisual(shell).TransformPoint(new(0, 0)).X + modes[0].ActualWidth)
                                        throw new Exception("Edit allowed options must be enabled beside the mode choices");
                                    var hostCodecsField = typeof(HostWindow).GetField("hostCodecs", flags)!;
                                    hostCodecsField.SetValue(window, new[] { "h264", "h265", "av1" });
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null);
                                    await Task.Delay(80);
                                    string CodecOf(Grid row) => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(Descendants(row).OfType<ToggleSwitch>().Single()).Replace("Use ", "");
                                    var codecRows = Descendants(shell).OfType<Grid>().Where(g => g.Tag as string == "codec-row").ToArray();
                                    if (codecRows.Length != 3) throw new Exception("Expected three video codec rows");
                                    var codecOrder = codecRows.Select(CodecOf).ToArray();
                                    if (!codecOrder.SequenceEqual(new[] { "AV1", "H.264", "H.265" }))
                                        throw new Exception("Video codec rows out of order: " + string.Join(", ", codecOrder));
                                    var h264Toggle = Descendants(codecRows.Single(r => CodecOf(r) == "H.264")).OfType<ToggleSwitch>().Single();
                                    if (!h264Toggle.IsOn || h264Toggle.IsEnabled) throw new Exception("H.264 codec toggle must stay on and disabled");
                                    var h265Toggle = Descendants(codecRows.Single(r => CodecOf(r) == "H.265")).OfType<ToggleSwitch>().Single();
                                    if (h265Toggle.IsOn) throw new Exception("H.265 codec toggle must start off");
                                    if (!Descendants(shell).OfType<TextBlock>().Any(t => t.Text == "Always on"))
                                        throw new Exception("Video codecs card is missing the Always on label for H.264");
                                    hostCodecsField.SetValue(window, new[] { "h264" });
                                    typeof(HostWindow).GetMethod("RenderPage", flags)!.Invoke(window, null);
                                    await Task.Delay(80);
                                    codecRows = Descendants(shell).OfType<Grid>().Where(g => g.Tag as string == "codec-row").ToArray();
                                    var h265Row = codecRows.Single(r => CodecOf(r) == "H.265");
                                    if (!Descendants(h265Row).OfType<TextBlock>().Any(t => t.Text == "Not supported by this GPU") ||
                                        Descendants(h265Row).OfType<ToggleSwitch>().Single().IsEnabled)
                                        throw new Exception("Unsupported H.265 must show the GPU warning with a disabled toggle");
                                    var av1Row = codecRows.Single(r => CodecOf(r) == "AV1");
                                    if (!Descendants(av1Row).OfType<ToggleSwitch>().Single().IsEnabled)
                                        throw new Exception("Stored-on AV1 codec must keep an enabled toggle so it can be turned off");
                                    hostCodecsField.SetValue(window, new[] { "h264", "h265", "av1" });
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
                                if (cycle > 0 && !Descendants(shell).OfType<TextBlock>().Any(text => text.Text == "Public login name: Living room PC"))
                                    throw new Exception("Overview does not show the saved public login name");
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
                                {"sessions":[{"id":"test-session","device":"iPhone","health":"Smooth","address":"127.0.0.1","connectedAt":0,"audio":true,"streams":[{"id":"stream-one","name":"Primary display","width":1280,"height":720,"targetFps":15,"profile":"test","encoder":{"label":"NVIDIA NVENC","element":"nvd3d11h265enc"}}]}],"streamCount":1}
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
                                if (!Descendants(list).OfType<TextBlock>().Any(t => t.Text == "NVIDIA NVENC"))
                                    throw new Exception("Session card does not show the active encoder");
                                TextBlock StreamHeader(string text) => Descendants(list).OfType<TextBlock>().Single(t => t.Text == text);
                                var profileHeader = StreamHeader("Profile");
                                var resolutionHeader = StreamHeader("Resolution");
                                var fpsHeader = StreamHeader("Target FPS");
                                var codecHeader = StreamHeader("Codec");
                                var encoderHeader = StreamHeader("Encoder");
                                double X(FrameworkElement element) => element.TransformToVisual(list).TransformPoint(new(0, 0)).X;
                                double Y(FrameworkElement element) => element.TransformToVisual(list).TransformPoint(new(0, 0)).Y;
                                if (!(X(profileHeader) < X(resolutionHeader) && X(resolutionHeader) < X(fpsHeader) && X(fpsHeader) < X(codecHeader)))
                                    throw new Exception("Stream details must lead with Profile, then Resolution, Target FPS and Codec");
                                if (Y(encoderHeader) <= Y(profileHeader))
                                    throw new Exception("Encoder must be shown beneath the compact stream detail row");
                                var encoderValue = Descendants(list).OfType<TextBlock>().Single(t => t.Text == "NVIDIA NVENC");
                                if (Y(encoderValue) <= Y(encoderHeader))
                                    throw new Exception("Encoder value must be shown beneath its heading");
                                var sessionHeader = (Grid)((Expander)list.Children[0]).Header;
                                var actionGroup = sessionHeader.Children.OfType<StackPanel>().Single(panel => panel.Children.OfType<Button>().Any());
                                var revokeControl = actionGroup.Children.OfType<Button>().Single(b => b.Content as string is "Grant control" or "Revoke control");
                                var disconnect = actionGroup.Children.OfType<Button>().Single(b => b.Content as string == "Disconnect");
                                if (actionGroup.Children.OfType<Button>().Any(b => b.Content as string == "Stop stream"))
                                    throw new Exception("Stop stream belongs with its individual stream, not the session header");
                                var stopStream = Descendants(list).OfType<Button>().Single(b => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(b) == "Stop stream");
                                if (Y(revokeControl) >= Y(profileHeader) || Y(disconnect) >= Y(profileHeader))
                                    throw new Exception("Session actions must appear in the device header above stream details");
                                if (X(revokeControl) <= X(codecHeader))
                                    throw new Exception("Session actions must be right-aligned in the device header");
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
                                device["streams"]![0]!["codec"] = "av1";
                                device["streams"]![0]!["viewers"] = 2; secondDevice["streams"]![0]!["viewers"] = 2;
                                multiple["sessions"]!.AsArray().Add(secondDevice); multiple["streamCount"] = 3;
                                using var multiStatus = JsonDocument.Parse(multiple.ToJsonString());
                                update.Invoke(window, new object[] { multiStatus.RootElement });
                                await Task.Delay(100);
                                if (Descendants(list).OfType<Canvas>().Count() != 3) throw new Exception("Each stream needs its own graph");
                                if (!Descendants(list).OfType<TextBlock>().Any(t => t.Text == "AV1")) throw new Exception("Stream codec value missing for the AV1 stream");
                                if (!Descendants(list).OfType<TextBlock>().Any(t => t.Text == "H.264")) throw new Exception("Stream codec value missing the default H.264 fallback");
                                var headerActions = list.Children.OfType<Expander>()
                                    .SelectMany(card => ((Grid)card.Header).Children.OfType<StackPanel>())
                                    .SelectMany(group => group.Children.OfType<Button>()).ToArray();
                                if (headerActions.Count(b => b.Content as string == "Grant control") != 2)
                                    throw new Exception("Each device needs a host control action");
                                if (Descendants(list).OfType<Button>().Count(b => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(b) == "Stop stream") != 3)
                                    throw new Exception("Each stream needs its own stop action");
                                var stablePlots = Descendants(list).OfType<Canvas>().ToArray();
                                update.Invoke(window, new object[] { multiStatus.RootElement });
                                if (!stablePlots.SequenceEqual(Descendants(list).OfType<Canvas>())) throw new Exception("Telemetry rebuilt per-stream graphs");
                                if (Descendants(list).OfType<TextBlock>().Count(t => t.Text == "Shared · 2 devices") != 2)
                                    throw new Exception("Streams shared with other devices need a shared label");
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
                                        IEnumerable<Button> HeaderButtons() => list.Children.OfType<Expander>()
                                            .SelectMany(card => ((Grid)card.Header).Children.OfType<StackPanel>())
                                            .SelectMany(group => group.Children.OfType<Button>());
                                        await InvokeSession(HeaderButtons().First(b => b.Content as string == "Grant control"), "grant", null);
                                        device["control"] = "Granted";
                                        using var granted = JsonDocument.Parse(multiple.ToJsonString()); update.Invoke(window, new object[] { granted.RootElement });
                                        await InvokeSession(HeaderButtons().Single(b => b.Content as string == "Revoke control"), "revoke", null);
                                        await InvokeSession(Descendants(list).OfType<Button>().First(b => Microsoft.UI.Xaml.Automation.AutomationProperties.GetName(b) == "Stop stream"), "stop-stream", "stream-one");
                                    } finally { ownerField.SetValue(window, null); owner.StandardInput.Close(); if (!owner.WaitForExit(5000)) owner.Kill(); }
                                }
                                if (Descendants(list).OfType<TextBlock>().Any(t => t.Text == "Waiting for telemetry" && t.Visibility == Visibility.Visible))
                                    throw new Exception("Fresh frame flow must replace the waiting state");
                                var diagnosticsAddress = typeof(HostWindow).GetMethod("DiagnosticsAddress", BindingFlags.Static | BindingFlags.NonPublic)!;
                                if ((string?)diagnosticsAddress.Invoke(null, new object[] { "http://127.0.0.1:45999/diagnostics" }) != "http://127.0.0.1:45999/diagnostics")
                                    throw new Exception("Diagnostics must accept the owner-provided private loopback port");
                                if (cycle == 0)
                                {
                                    var start = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
                                        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                                    start.ArgumentList.Add(Path.GetFullPath("apps/windows-host/tests/Navigation/owner-fixture.mjs"));
                                    using var owner = System.Diagnostics.Process.Start(start)!;
                                    var serverField = typeof(HostWindow).GetField("server", flags)!;
                                    try
                                    {
                                        serverField.SetValue(window, owner);
                                        var requested = (Task<(string Url, string Token)>)typeof(HostWindow).GetMethod("RequestDiagnosticsCapability", flags)!.Invoke(window, null)!;
                                        var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                                        using var result = JsonDocument.Parse(line!);
                                        if (result.RootElement.GetProperty("received").GetProperty("type").GetString() != "diagnostics-capability-create")
                                            throw new Exception("Diagnostics did not request owner-scoped capability");
                                        typeof(HostWindow).GetMethod("ReceiveClientResult", flags)!.Invoke(window, new object[] { result.RootElement });
                                        var (url, token) = await requested.WaitAsync(TimeSpan.FromSeconds(5));
                                        var launched = (string)typeof(HostWindow).GetMethod("DiagnosticsLaunchUrl", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null,
                                            new object[] { url, token })!;
                                        if (launched != "http://127.0.0.1:45999/diagnostics#capability=" + token)
                                            throw new Exception("Diagnostics capability was not confined to a URL fragment");
                                    }
                                    finally { serverField.SetValue(window, null); owner.StandardInput.Close(); if (!owner.WaitForExit(5000)) owner.Kill(); }
                                }
                                if (diagnosticsAddress.Invoke(null, new object[] { "http://example.com:45999/diagnostics" }) is not null)
                                    throw new Exception("Diagnostics link accepted a non-local endpoint");
                                if (diagnosticsAddress.Invoke(null, new object[] { "http://127.0.0.1:45678/api/info" }) is not null)
                                    throw new Exception("Diagnostics link accepted another route");
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
                    File.WriteAllText(Result, "PASS: title bar/themes; seven-page navigation; Clients administration and connection modes; footer/header actions; aligned profile columns; cosmetic reorder persistence without policy changes; profile/options modal cancel; owner-pipe mode/options persistence; display/Overview layout; session lifecycle; HTTPS section (mode/port/strategy/expiry/fingerprint, strategy-specific reissue warning, disabled regenerate for provided and off, visible provisioning failure, HTTPS address display, locally rendered enrolment QR, owner-pipe regenerate).");
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
