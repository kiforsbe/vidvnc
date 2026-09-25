using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    string defaultControl = "approval";
    string connectionMode = "session-key";
    string publicName = "VidVNC host";
    string? publicNameDraft;
    int maxSessions = 4;
    // Remote access (server access-settings.mjs). Missing fields, from an older server or a
    // test snapshot, read as remote access off with nothing configured.
    bool remoteAccess;
    string[] publicHostnames = [];
    int? publicPort;
    (int Min, int Max)? mediaPorts;
    const int MaxSessionsLimit = 8;
    long accessRevision;
    bool accessReady;
    bool accessSaving;
    string? accessError;
    string? accessRequestId;
    TaskCompletionSource<JsonElement>? accessReply;

    void UpdateAccess(JsonElement value)
    {
        defaultControl = value.GetProperty("defaultControl").GetString()!;
        connectionMode = value.TryGetProperty("connectionMode", out var mode) ? mode.GetString() ?? "session-key" : "session-key";
        publicName = value.TryGetProperty("publicName", out var name) ? name.GetString() ?? "VidVNC host" : "VidVNC host";
        oneTimeConnectionKey = null; oneTimeConnectionExpiresAt = null;
        maxSessions = value.TryGetProperty("maxSessions", out var limit) && limit.TryGetInt32(out var count) ? count : 4;
        remoteAccess = value.TryGetProperty("remoteAccess", out var remote) && remote.ValueKind == JsonValueKind.True;
        publicHostnames = value.TryGetProperty("publicHostnames", out var hosts) && hosts.ValueKind == JsonValueKind.Array
            ? hosts.EnumerateArray().Select(host => host.GetString() ?? "").Where(host => host.Length > 0).ToArray() : [];
        publicPort = value.TryGetProperty("publicPort", out var port) && port.TryGetInt32(out var portNumber) ? portNumber : null;
        mediaPorts = value.TryGetProperty("mediaPorts", out var ports) && ports.ValueKind == JsonValueKind.Object &&
            ports.TryGetProperty("min", out var min) && ports.TryGetProperty("max", out var max) &&
            min.TryGetInt32(out var minPort) && max.TryGetInt32(out var maxPort) ? (minPort, maxPort) : null;
        UpdateSharingIndicator();
        accessRevision = value.GetProperty("revision").GetInt64();
        accessReady = true;
        if (currentPage is "Access" or "Settings" or "Overview") RenderPage();
    }

    void ReceiveAccessResult(JsonElement value)
    {
        if (value.GetProperty("requestId").GetString() == accessRequestId)
            accessReply?.TrySetResult(value.Clone());
    }

    void RenderAccess()
    {
        var admission = new StackPanel { Spacing = HostSpacing.Row };
        admission.Children.Add(Label("Connection method", 16));
        admission.Children.Add(Secondary("Choose how ordinary clients may connect. Approved clients and client setup keys remain available."));
        var method = new ComboBox { Tag = "connection-mode", HorizontalAlignment = HorizontalAlignment.Stretch,
            IsEnabled = accessReady && server is not null && !accessSaving && !remoteAccess };
        method.Items.Add("Reusable session key");
        method.Items.Add("One-time connection keys");
        method.Items.Add("Approved clients only");
        method.SelectedIndex = connectionMode == "one-time-keys" ? 1 : connectionMode == "approved-only" ? 2 : 0;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(method, "Allowed connection method");
        method.SelectionChanged += async (_, _) => await SaveAccess(connectionMode: method.SelectedIndex switch
        { 1 => "one-time-keys", 2 => "approved-only", _ => "session-key" });
        admission.Children.Add(method);
        if (remoteAccess) admission.Children.Add(Secondary("Remote access is on, which allows approved clients only. Turn remote access off to choose another method."));
        admission.Children.Add(Secondary(connectionMode switch {
            "one-time-keys" => "Each ordinary connection needs a fresh host-issued key that expires after one use.",
            "approved-only" => "Ordinary connection keys are disabled. Only approved clients can sign in.",
            _ => "The sharing-instance key can be reused; a single-use key can also be created when preferred."
        }));
        page.Children.Add(Card(admission));
        var content = new StackPanel { Spacing = HostSpacing.Card };
        var row = new Grid { ColumnSpacing = HostSpacing.Card };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new FontIcon { Glyph = "\uE765", FontSize = 24, VerticalAlignment = VerticalAlignment.Center });
        var labels = new StackPanel { Spacing = HostSpacing.Small, VerticalAlignment = VerticalAlignment.Center };
        labels.Children.Add(Label("Keyboard and mouse", 16));
        labels.Children.Add(Secondary("Default access for new connections"));
        Grid.SetColumn(labels, 1); row.Children.Add(labels);
        var choice = new ComboBox { Tag = "default-control", Width = 220,
            HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center,
            IsEnabled = accessReady && server is not null && !accessSaving };
        choice.Items.Add("Require host approval");
        choice.Items.Add("Allow when available");
        choice.SelectedIndex = defaultControl == "available" ? 1 : 0;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(choice, "Default keyboard and mouse access");
        choice.SelectionChanged += async (_, _) => await SaveAccess(defaultControl: choice.SelectedIndex == 1 ? "available" : "approval");
        Grid.SetColumn(choice, 2); row.Children.Add(choice);
        content.Children.Add(row);
        content.Children.Add(DisplaySeparator());
        content.Children.Add(Secondary("One device can control at a time. Manage access in Sessions."));
        page.Children.Add(Card(content));

        var devicesRow = new Grid { ColumnSpacing = HostSpacing.Card };
        devicesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        devicesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        devicesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        devicesRow.Children.Add(new FontIcon { Glyph = "", FontSize = 24, VerticalAlignment = VerticalAlignment.Center });
        var devicesLabels = new StackPanel { Spacing = HostSpacing.Small, VerticalAlignment = VerticalAlignment.Center };
        devicesLabels.Children.Add(Label("Connected devices", 16));
        devicesLabels.Children.Add(Secondary("Maximum devices connected at the same time"));
        Grid.SetColumn(devicesLabels, 1); devicesRow.Children.Add(devicesLabels);
        var devices = new ComboBox { Tag = "max-sessions", Width = 220,
            HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center,
            IsEnabled = accessReady && server is not null && !accessSaving };
        for (var count = 1; count <= MaxSessionsLimit; count++) devices.Items.Add(count == 1 ? "1 device" : $"{count} devices");
        devices.SelectedIndex = Math.Clamp(maxSessions, 1, MaxSessionsLimit) - 1;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(devices, "Maximum connected devices");
        devices.SelectionChanged += async (_, _) => await SaveAccess(maxSessions: devices.SelectedIndex + 1);
        Grid.SetColumn(devices, 2); devicesRow.Children.Add(devices);
        var devicesContent = new StackPanel { Spacing = HostSpacing.Card };
        devicesContent.Children.Add(devicesRow);
        devicesContent.Children.Add(DisplaySeparator());
        devicesContent.Children.Add(Secondary("Lowering the limit does not disconnect devices that are already connected."));
        page.Children.Add(Card(devicesContent));
        if (accessError is not null) page.Children.Add(new InfoBar { IsOpen = true,
            Severity = InfoBarSeverity.Error, Message = accessError });
        page.Children.Add(Secondary("Approved clients can sign in with their saved credential, username, and password."));
    }

    void RenderPublicNameSettings()
    {
        var content = new StackPanel { Spacing = HostSpacing.Row };
        content.Children.Add(Label("Public login name", 16));
        content.Children.Add(Secondary("Shown before sign-in so visitors can recognize this host. Avoid private details."));
        var name = new TextBox { Tag = "public-name", Text = publicNameDraft ?? publicName,
            MaxLength = 160, IsEnabled = accessReady && server is not null && !accessSaving };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(name, "Public login name");
        content.Children.Add(name);
        content.Children.Add(Secondary("Use 1–80 characters."));
        var save = Command("Save public login name", async () => await SaveAccess(publicName: name.Text));
        save.Tag = "save-public-name";
        void UpdateSaveState()
        {
            var trimmed = name.Text.Trim();
            var length = 0;
            foreach (var _ in trimmed.EnumerateRunes()) length++;
            save.IsEnabled = name.IsEnabled && length is >= 1 and <= 80 && trimmed != publicName;
        }
        UpdateSaveState();
        name.TextChanged += (_, _) =>
        {
            publicNameDraft = name.Text;
            UpdateSaveState();
        };
        content.Children.Add(save);
        if (accessError is not null) content.Children.Add(new InfoBar { IsOpen = true,
            Severity = InfoBarSeverity.Error, Message = accessError });
        page.Children.Add(Card(content));
    }

    async Task SaveAccess(string? defaultControl = null, string? connectionMode = null, int? maxSessions = null, string? publicName = null)
    {
        var nextControl = defaultControl ?? this.defaultControl;
        var nextMode = connectionMode ?? this.connectionMode;
        var nextLimit = maxSessions ?? this.maxSessions;
        var nextName = publicName ?? this.publicName;
        if (accessSaving || (nextControl == this.defaultControl && nextMode == this.connectionMode && nextLimit == this.maxSessions && nextName == this.publicName)) return;
        await SendAccessChanges(new Dictionary<string, object?> {
            ["defaultControl"] = nextControl, ["connectionMode"] = nextMode,
            ["maxSessions"] = nextLimit, ["publicName"] = nextName },
            onSaved: publicName is null ? null : () => publicNameDraft = null);
    }

    // Sends only the given fields; the server leaves every other access setting as it is and
    // validates the whole result, so an invalid combination comes back as an error here.
    async Task SendAccessChanges(Dictionary<string, object?> changes, Action? onSaved = null)
    {
        accessSaving = true; accessError = null;
        accessRequestId = Guid.NewGuid().ToString();
        accessReply = new(TaskCreationOptions.RunContinuationsAsynchronously);
        if (currentPage is "Access" or "Settings") RenderPage();
        try
        {
            var child = server ?? throw new InvalidOperationException("Start sharing before changing access settings.");
            var message = new Dictionary<string, object?> { ["type"] = "access-set", ["requestId"] = accessRequestId, ["revision"] = accessRevision };
            foreach (var (field, change) in changes) message[field] = change;
            await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(message));
            await child.StandardInput.FlushAsync();
            var reply = await accessReply.Task.WaitAsync(TimeSpan.FromSeconds(10));
            UpdateAccess(reply.GetProperty("access"));
            if (reply.TryGetProperty("sessionKey", out var key) && key.ValueKind == JsonValueKind.String)
                password.Text = key.GetString() ?? "";
            if (!reply.GetProperty("ok").GetBoolean()) throw new InvalidOperationException(reply.GetProperty("error").GetString());
            onSaved?.Invoke();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException)
        {
            accessError = error.Message;
            // A timeout has an uncertain write outcome; do not offer a stale revision for saving.
            if (error is TimeoutException) { accessReady = false; accessError += " Restart sharing to reload access settings."; }
        }
        finally
        {
            accessSaving = false; accessReply = null; accessRequestId = null;
            if (currentPage is "Access" or "Settings" or "Overview") RenderPage();
        }
    }
}
