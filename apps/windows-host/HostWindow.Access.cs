using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    string defaultControl = "approval";
    long accessRevision;
    bool accessReady;
    bool accessSaving;
    string? accessError;
    string? accessRequestId;
    TaskCompletionSource<JsonElement>? accessReply;

    void UpdateAccess(JsonElement value)
    {
        defaultControl = value.GetProperty("defaultControl").GetString()!;
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
        page.Children.Add(Card(Label("Session password\nDevices connect using the current sharing password. Stopping sharing disconnects clients; restarting creates a new password.")));
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
        choice.SelectionChanged += async (_, _) => await SaveAccess(choice.SelectedIndex == 1 ? "available" : "approval");
        Grid.SetColumn(choice, 2); row.Children.Add(choice);
        content.Children.Add(row);
        content.Children.Add(DisplaySeparator());
        content.Children.Add(Secondary("One device can control at a time. Manage access in Sessions."));
        page.Children.Add(Card(content));
        if (accessError is not null) page.Children.Add(new InfoBar { IsOpen = true,
            Severity = InfoBarSeverity.Error, Message = accessError });
        page.Children.Add(Label("Approved users, remembered devices, passkeys and per-device permissions are not implemented yet."));
    }

    async Task SaveAccess(string value)
    {
        if (accessSaving || value == defaultControl) return;
        accessSaving = true; accessError = null;
        accessRequestId = Guid.NewGuid().ToString();
        accessReply = new(TaskCreationOptions.RunContinuationsAsynchronously);
        if (currentPage == "Access") RenderPage();
        try
        {
            var child = server ?? throw new InvalidOperationException("Start sharing before changing access defaults.");
            await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new {
                type = "access-set", requestId = accessRequestId, revision = accessRevision, defaultControl = value }));
            await child.StandardInput.FlushAsync();
            var reply = await accessReply.Task.WaitAsync(TimeSpan.FromSeconds(10));
            UpdateAccess(reply.GetProperty("access"));
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
