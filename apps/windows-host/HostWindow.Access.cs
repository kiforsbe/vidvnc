using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    string defaultControl = "approval";
    string connectionMode = "session-key";
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
        oneTimeConnectionKey = null; oneTimeConnectionExpiresAt = null;
        accessRevision = value.GetProperty("revision").GetInt64();
        accessReady = true;
        if (currentPage == "Access") RenderPage();
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
            IsEnabled = accessReady && server is not null && !accessSaving };
        method.Items.Add("Reusable session key");
        method.Items.Add("One-time connection keys");
        method.Items.Add("Approved clients only");
        method.SelectedIndex = connectionMode == "one-time-keys" ? 1 : connectionMode == "approved-only" ? 2 : 0;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(method, "Allowed connection method");
        method.SelectionChanged += async (_, _) => await SaveAccess(connectionMode: method.SelectedIndex switch
        { 1 => "one-time-keys", 2 => "approved-only", _ => "session-key" });
        admission.Children.Add(method);
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
        if (accessError is not null) page.Children.Add(new InfoBar { IsOpen = true,
            Severity = InfoBarSeverity.Error, Message = accessError });
        page.Children.Add(Secondary("Approved clients can sign in with their saved credential, username, and password."));
    }

    async Task SaveAccess(string? defaultControl = null, string? connectionMode = null)
    {
        var nextControl = defaultControl ?? this.defaultControl;
        var nextMode = connectionMode ?? this.connectionMode;
        if (accessSaving || (nextControl == this.defaultControl && nextMode == this.connectionMode)) return;
        accessSaving = true; accessError = null;
        accessRequestId = Guid.NewGuid().ToString();
        accessReply = new(TaskCreationOptions.RunContinuationsAsynchronously);
        if (currentPage == "Access") RenderPage();
        try
        {
            var child = server ?? throw new InvalidOperationException("Start sharing before changing access defaults.");
            await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new {
                type = "access-set", requestId = accessRequestId, revision = accessRevision,
                defaultControl = nextControl, connectionMode = nextMode }));
            await child.StandardInput.FlushAsync();
            var reply = await accessReply.Task.WaitAsync(TimeSpan.FromSeconds(10));
            UpdateAccess(reply.GetProperty("access"));
            if (reply.TryGetProperty("sessionKey", out var key) && key.ValueKind == JsonValueKind.String)
                password.Text = key.GetString() ?? "";
            if (!reply.GetProperty("ok").GetBoolean()) throw new InvalidOperationException(reply.GetProperty("error").GetString());
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
            if (currentPage == "Access") RenderPage();
        }
    }
}
