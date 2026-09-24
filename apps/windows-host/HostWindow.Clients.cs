using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    sealed record PendingClient(string Id, string DeviceName, string Username, string Client, string Network);
    sealed record ApprovedClient(string Id, string DeviceName, string Username, string Client, string Network,
        bool Connected, string Permission, string LastConnectedLabel);

    PendingClient[] pendingClients = [];
    ApprovedClient[] approvedClients = [];
    readonly Dictionary<string, TaskCompletionSource<JsonElement>> clientReplies = [];
    string? clientSetupKey;
    long? clientSetupExpiresAt;
    string? oneTimeConnectionKey;
    long? oneTimeConnectionExpiresAt;
    string? clientError;
    bool ephemeralCodeLocked;
    bool sessionPasswordLocked;
    Action? refreshConnectionDialog;

    void UpdateCodeStatus(JsonElement status)
    {
        if (!status.TryGetProperty("codes", out var codes)) return;
        static bool Locked(JsonElement codes, string name) =>
            codes.TryGetProperty(name, out var row) && row.ValueKind == JsonValueKind.Object &&
            row.TryGetProperty("locked", out var locked) && locked.ValueKind == JsonValueKind.True;
        var ephemeral = Locked(codes, "ephemeral");
        var session = Locked(codes, "session");
        if (ephemeral == ephemeralCodeLocked && session == sessionPasswordLocked) return;
        ephemeralCodeLocked = ephemeral; sessionPasswordLocked = session;
        refreshConnectionDialog?.Invoke();
    }

    void UpdateClients(JsonElement status)
    {
        PendingClient[] nextPending = status.TryGetProperty("pending", out var pending) && pending.ValueKind == JsonValueKind.Array
            ? pending.EnumerateArray().Select(row => new PendingClient(
                Text(row, "id"), Text(row, "deviceName", "Unknown device"), Text(row, "username", "Unknown user"),
                Text(row, "client", "Unknown client"), Text(row, "network", "Unknown network"))).ToArray()
            : [];
        ApprovedClient[] nextApproved = status.TryGetProperty("approved", out var approved) && approved.ValueKind == JsonValueKind.Array
            ? approved.EnumerateArray().Select(row => new ApprovedClient(
                Text(row, "id"), Text(row, "deviceName", "Unknown device"), Text(row, "username", "Unknown user"),
                Text(row, "client", "Unknown client"), Text(row, "network", ""),
                row.TryGetProperty("connected", out var connected) && connected.ValueKind == JsonValueKind.True,
                Text(row, "permission", "default"), LastConnectedLabel(row))).ToArray()
            : [];
        if (nextPending.Length > 0) { clientSetupKey = null; clientSetupExpiresAt = null; }
        // The server reports clients every second; rebuilding unchanged rows would dismiss open dropdowns and menus.
        if (nextPending.SequenceEqual(pendingClients) && nextApproved.SequenceEqual(approvedClients)) return;
        pendingClients = nextPending;
        approvedClients = nextApproved;
        if (currentPage == "Clients") RenderPage();
    }

    static string Text(JsonElement row, string property, string fallback = "") =>
        row.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : fallback;

    static string LastConnectedLabel(JsonElement row)
    {
        var supplied = Text(row, "lastConnectedLabel");
        if (!string.IsNullOrWhiteSpace(supplied)) return supplied;
        if (!row.TryGetProperty("lastConnectedAt", out var connected) || connected.ValueKind != JsonValueKind.Number ||
            !connected.TryGetInt64(out var timestamp)) return "Not connected yet";
        var minutes = Math.Max(0, (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - timestamp) / 60000);
        if (minutes == 0) return "Last connected just now";
        if (minutes < 60) return $"Last connected {minutes} min ago";
        if (minutes < 24 * 60) return $"Last connected {minutes / 60} hr ago";
        return $"Last connected {minutes / (24 * 60)} day{(minutes < 48 * 60 ? "" : "s")} ago";
    }

    void ReceiveClientResult(JsonElement result)
    {
        if (!result.TryGetProperty("requestId", out var id)) return;
        var requestId = id.GetString();
        if (requestId is not null && clientReplies.TryGetValue(requestId, out var reply))
            reply.TrySetResult(result.Clone());
    }

    async Task<JsonElement> SendClientOwnerCommand(Dictionary<string, object?> command)
    {
        var child = server ?? throw new IOException("Start sharing before managing approved clients.");
        var requestId = Guid.NewGuid().ToString("N");
        command["requestId"] = requestId;
        var reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        clientReplies[requestId] = reply;
        try
        {
            await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(command));
            await child.StandardInput.FlushAsync();
            var result = await reply.Task;
            if (!result.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
                throw new IOException(Text(result, "error", "The server could not complete the client action."));
            return result;
        }
        finally { clientReplies.Remove(requestId); }
    }

    async Task<string> RequestDiagnosticsCapability()
    {
        var result = await SendClientOwnerCommand(new() { ["type"] = "diagnostics-capability-create" });
        var token = Text(result, "token");
        if (token.Length != 43) throw new IOException("The server returned an invalid diagnostics capability.");
        return token;
    }

    async Task RequestClientSetupKey(string alphabet)
    {
        var result = await SendClientOwnerCommand(new() { ["type"] = "client-setup-create", ["alphabet"] = alphabet });
        clientSetupKey = Text(result, "key");
        clientSetupExpiresAt = result.TryGetProperty("expiresAt", out var expires) && expires.TryGetInt64(out var timestamp)
            ? timestamp : null;
        clientError = null;
    }

    async Task RequestOneTimeConnectionKey(string alphabet)
    {
        var result = await SendClientOwnerCommand(new() { ["type"] = "connection-once-create", ["alphabet"] = alphabet });
        oneTimeConnectionKey = Text(result, "key");
        oneTimeConnectionExpiresAt = result.TryGetProperty("expiresAt", out var expires) && expires.TryGetInt64(out var timestamp)
            ? timestamp : null;
        clientError = null;
    }

    async Task RotateSessionPassword(string alphabet)
    {
        var result = await SendClientOwnerCommand(new() { ["type"] = "session-password-rotate", ["alphabet"] = alphabet });
        password.Text = Text(result, "key");
        clientError = null;
    }

    async Task SendClientCommand(string type, string action, string id, string? permission = null)
    {
        var command = new Dictionary<string, object?> { ["type"] = type, ["action"] = action, ["id"] = id };
        if (permission is not null) command["permission"] = permission;
        try { await SendClientOwnerCommand(command); clientError = null; }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        { clientError = error.Message; if (currentPage == "Clients") RenderPage(); }
    }

    async Task DisconnectOrdinarySessions()
    {
        try
        {
            await SendClientOwnerCommand(new() { ["type"] = "ordinary-sessions-disconnect" });
            clientError = null;
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        { clientError = error.Message; if (currentPage == "Clients") RenderPage(); }
    }

    async Task ConfirmOrdinaryDisconnect()
    {
        var confirm = new ContentDialog
        {
            Title = "Disconnect ordinary sessions now?",
            Content = "This ends connections made with a session password or one-time code. Approved-client sessions stay connected. Changing the connection method alone only affects new sign-ins.",
            PrimaryButtonText = "Disconnect ordinary sessions",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = navigation.XamlRoot,
        };
        if (await confirm.ShowAsync() == ContentDialogResult.Primary) await DisconnectOrdinarySessions();
    }

    void RenderClients()
    {
        var connect = new Button { Content = "Connect a device", Tag = "approved-client", IsEnabled = sharing };
        connect.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        connect.Click += async (_, _) => await ShowConnection("approved-client");
        pageAction.Content = connect;
        page.Children.Add(Secondary("Manage devices that can sign in to this host", 16));
        if (clientError is not null) page.Children.Add(new InfoBar { IsOpen = true, IsClosable = true,
            Severity = InfoBarSeverity.Error, Message = clientError });

        var summaryContent = new StackPanel { Spacing = HostSpacing.Small };
        summaryContent.Children.Add(Label($"{approvedClients.Length} approved client{Plural(approvedClients.Length)} · " +
            $"{pendingClients.Length} waiting for approval"));
        summaryContent.Children.Add(Secondary("New devices must be verified before they can connect."));
        page.Children.Add(Card(IconRow("\uE716", summaryContent)));

        var lockdown = new StackPanel { Spacing = HostSpacing.Row };
        lockdown.Children.Add(Label("Emergency ordinary-session disconnect"));
        lockdown.Children.Add(Secondary("Changing to approved clients only blocks new ordinary sign-ins. Use this separate action to end ordinary sessions already connected."));
        var disconnectOrdinary = new Button { Content = "Disconnect ordinary sessions now", Tag = "disconnect-ordinary", IsEnabled = server is not null };
        disconnectOrdinary.Click += async (_, _) => await ConfirmOrdinaryDisconnect();
        lockdown.Children.Add(disconnectOrdinary);
        page.Children.Add(Card(lockdown));

        page.Children.Add(Label("Needs your approval", 22));
        if (pendingClients.Length == 0)
            page.Children.Add(Card(Secondary("No clients are waiting for approval.")));
        else
            foreach (var client in pendingClients) page.Children.Add(Card(PendingClientRow(client), HostSpacing.Row));

        page.Children.Add(Label("Approved clients", 22));
        if (approvedClients.Length == 0)
            page.Children.Add(Card(Secondary("No approved clients yet. Choose Connect a device to add one.")));
        else
            foreach (var client in approvedClients) page.Children.Add(Card(ApprovedClientRow(client), HostSpacing.Row));

        page.Children.Add(Secondary("An approved browser credential is copyable. Protect it and its password; removal revokes its active session."));
    }

    static string Plural(int count) => count == 1 ? "" : "s";

    // "default" follows the Access page setting; the rest override it for one client.
    static readonly string[] ClientPermissions = ["default", "approval", "available", "view-only"];

    static string ControlLabel(string value) => value switch
    {
        "available" => "Allow when available",
        "view-only" => "View only",
        _ => "Require host approval",
    };

    Grid PendingClientRow(PendingClient client)
    {
        var row = ClientRow(client.DeviceName, client.Username, client.Client, client.Network, "pending-client-row");
        var state = Label("Waiting for approval");
        state.Foreground = ThemeStatusBrush(state, "warning");
        state.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(state, 2); row.Children.Add(state);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = HostSpacing.Related, VerticalAlignment = VerticalAlignment.Center };
        var approve = new Button { Content = "Approve", IsEnabled = server is not null };
        approve.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        approve.Click += async (_, _) => await SendClientCommand("client-request-command", "approve", client.Id);
        actions.Children.Add(approve);
        var reject = new Button { Content = "Reject", IsEnabled = server is not null };
        reject.Click += async (_, _) => await SendClientCommand("client-request-command", "reject", client.Id);
        actions.Children.Add(reject);
        Grid.SetColumn(actions, 3); row.Children.Add(actions);
        return row;
    }

    Grid ApprovedClientRow(ApprovedClient client)
    {
        var row = ClientRow(client.DeviceName, client.Username, client.Client, client.Network, "approved-client-row");
        var state = Label(client.Connected ? "● Connected" : client.LastConnectedLabel, 12);
        if (client.Connected) state.Foreground = ThemeStatusBrush(state, "success");
        else state.Opacity = .76;
        state.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(state, 2); row.Children.Add(state);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = HostSpacing.Related, VerticalAlignment = VerticalAlignment.Center };
        var permission = new ComboBox { MinWidth = 170, Tag = "client-permission", VerticalAlignment = VerticalAlignment.Center };
        permission.Items.Add("Use Access default");
        foreach (var value in ClientPermissions.Skip(1)) permission.Items.Add(ControlLabel(value));
        permission.SelectedIndex = Math.Max(0, Array.IndexOf(ClientPermissions, client.Permission));
        permission.IsEnabled = server is not null;
        permission.SelectionChanged += async (_, _) => await SendClientCommand("approved-client-command", "permission",
            client.Id, ClientPermissions[permission.SelectedIndex]);
        actions.Children.Add(permission);
        var more = new Button { Content = "⋯", IsEnabled = server is not null, VerticalAlignment = VerticalAlignment.Center };
        var menu = new MenuFlyout();
        var remove = new MenuFlyoutItem { Text = "Remove approved client" };
        remove.Click += async (_, _) => await SendClientCommand("approved-client-command", "remove", client.Id);
        menu.Items.Add(remove); more.Flyout = menu;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(more, "More client actions");
        actions.Children.Add(more);
        Grid.SetColumn(actions, 3); row.Children.Add(actions);
        return row;
    }

    Grid ClientRow(string deviceName, string username, string client, string network, string tag)
    {
        var row = new Grid { Tag = tag, ColumnSpacing = HostSpacing.Card, MinHeight = 58 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var icon = new FontIcon { Glyph = DeviceGlyph(deviceName, client), FontSize = 26, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(icon);
        var identity = new StackPanel { Spacing = HostSpacing.Small, VerticalAlignment = VerticalAlignment.Center };
        var title = Label(deviceName, 17); title.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
        identity.Children.Add(title);
        var detail = string.Join(" · ", new[] { username, client, network }.Where(value => !string.IsNullOrWhiteSpace(value)));
        identity.Children.Add(Secondary(detail, 12));
        Grid.SetColumn(identity, 1); row.Children.Add(identity);
        return row;
    }

    static string DeviceGlyph(string deviceName, string client) =>
        deviceName.Contains("iPhone", StringComparison.OrdinalIgnoreCase) ||
        deviceName.Contains("Android", StringComparison.OrdinalIgnoreCase) ||
        client.Contains("iOS", StringComparison.OrdinalIgnoreCase) ||
        client.Contains("Android", StringComparison.OrdinalIgnoreCase) ? "\uE8EA" : "\uE7F4";
}
