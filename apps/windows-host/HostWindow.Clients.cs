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

    void UpdateClients(JsonElement status)
    {
        pendingClients = status.TryGetProperty("pending", out var pending) && pending.ValueKind == JsonValueKind.Array
            ? pending.EnumerateArray().Select(row => new PendingClient(
                Text(row, "id"), Text(row, "deviceName", "Unknown device"), Text(row, "username", "Unknown user"),
                Text(row, "client", "Unknown client"), Text(row, "network", "Unknown network"))).ToArray()
            : [];
        approvedClients = status.TryGetProperty("approved", out var approved) && approved.ValueKind == JsonValueKind.Array
            ? approved.EnumerateArray().Select(row => new ApprovedClient(
                Text(row, "id"), Text(row, "deviceName", "Unknown device"), Text(row, "username", "Unknown user"),
                Text(row, "client", "Unknown client"), Text(row, "network", ""),
                row.TryGetProperty("connected", out var connected) && connected.ValueKind == JsonValueKind.True,
                Text(row, "permission", "view-only"), Text(row, "lastConnectedLabel", "Not connected yet"))).ToArray()
            : [];
        if (currentPage == "Clients") RenderPage();
    }

    static string Text(JsonElement row, string property, string fallback = "") =>
        row.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : fallback;

    void RenderClients()
    {
        page.Children.Add(Secondary("Manage devices that can sign in to this host", 16));

        var summaryContent = new StackPanel { Spacing = HostSpacing.Small };
        summaryContent.Children.Add(Label($"{approvedClients.Length} approved client{Plural(approvedClients.Length)} · " +
            $"{pendingClients.Length} waiting for approval"));
        summaryContent.Children.Add(Secondary("New devices must be verified before they can connect."));
        page.Children.Add(Card(IconRow("\uE716", summaryContent)));

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

        page.Children.Add(Secondary("Approved clients can sign in without a connection key."));
    }

    static string Plural(int count) => count == 1 ? "" : "s";

    Grid PendingClientRow(PendingClient client)
    {
        var row = ClientRow(client.DeviceName, client.Username, client.Client, client.Network, "pending-client-row");
        var state = Label("Waiting for approval");
        state.Foreground = ThemeStatusBrush(state, "warning");
        Grid.SetColumn(state, 2); row.Children.Add(state);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = HostSpacing.Related };
        actions.Children.Add(Pending(new Button { Content = "Approve" }, "Approve client"));
        actions.Children.Add(Pending(new Button { Content = "Reject" }, "Reject client"));
        Grid.SetColumn(actions, 3); row.Children.Add(actions);
        return row;
    }

    Grid ApprovedClientRow(ApprovedClient client)
    {
        var row = ClientRow(client.DeviceName, client.Username, client.Client, client.Network, "approved-client-row");
        var state = Label(client.Connected ? "● Connected" : client.LastConnectedLabel, 12);
        if (client.Connected) state.Foreground = ThemeStatusBrush(state, "success");
        else state.Opacity = .76;
        Grid.SetColumn(state, 2); row.Children.Add(state);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = HostSpacing.Related };
        var permission = new ComboBox { MinWidth = 170, Tag = "client-permission" };
        permission.Items.Add("View only"); permission.Items.Add("Can request control");
        permission.SelectedIndex = client.Permission == "request-control" ? 1 : 0;
        actions.Children.Add(Pending(permission, "Change client permission"));
        var more = Pending(new Button { Content = "⋯" }, "More client actions");
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
