using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    VariableSizedWrapGrid? overviewDisplayCards;
    TextBlock? overviewSessionSummary;

    static TextBlock Secondary(string text, double size = 13)
    {
        var label = Label(text, size);
        label.Opacity = .76;
        return label;
    }

    static Grid IconRow(string glyph, FrameworkElement content)
    {
        var row = new Grid { ColumnSpacing = HostSpacing.Card };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(new FontIcon { Glyph = glyph, FontSize = 28, VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(content, 1); row.Children.Add(content);
        return row;
    }

    // Decorative artwork only: never capture a desktop to paint a monitor tile.
    static Border MonitorArt(DisplayInfo display, int number, bool compact)
    {
        var brush = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(1, 1) };
        brush.GradientStops.Add(new GradientStop { Color = Windows.UI.Color.FromArgb(255, 9, 25, 65), Offset = 0 });
        brush.GradientStops.Add(new GradientStop { Color = Windows.UI.Color.FromArgb(255, 13, 83, 175), Offset = .55 });
        brush.GradientStops.Add(new GradientStop { Color = Windows.UI.Color.FromArgb(255, 25, 39, 104), Offset = 1 });
        var text = new StackPanel { Spacing = HostSpacing.Small, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = number.ToString(), FontSize = compact ? 24 : 32,
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White), HorizontalAlignment = HorizontalAlignment.Center,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold });
        text.Children.Add(new TextBlock { Text = $"{display.Width} × {display.Height}", FontSize = compact ? 10 : 12,
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White), HorizontalAlignment = HorizontalAlignment.Center });
        return new Border { Background = brush, Child = text, CornerRadius = new CornerRadius(5),
            BorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 80, 160, 240)), BorderThickness = new Thickness(1),
            HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch };
    }

    void RenderOverview()
    {
        page.Children.Add(Secondary("Your desktop, ready to share", 16));
        var host = new StackPanel { Spacing = 8 };
        var name = Label(Environment.MachineName, 24); name.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
        host.Children.Add(name);
        host.Children.Add(Secondary(sharing ? "Available on your local network" : heading.Text));
        var state = Label(sharing ? "●  Sharing is on" : "●  Sharing is off");
        state.Foreground = ThemeStatusBrush(navigation, sharing ? "success" : "neutral"); host.Children.Add(state);
        if (!sharing) host.Children.Add(new ScrollViewer { Content = Label(detail.Text), MaxHeight = 70 });
        var hostCard = Card(IconRow("\uE7F4", host));

        var session = new StackPanel { Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
        overviewSessionSummary = Label(summary.Text);
        session.Children.Add(overviewSessionSummary);
        var sessionActions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = HostSpacing.Related };
        sessionActions.Children.Add(Command("View sessions  ›", () => navigation.SelectedItem = navigation.MenuItems.OfType<NavigationViewItem>().Single(i => i.Tag as string == "Sessions")));
        var connect = new Button { Content = "Connect a device", IsEnabled = sharing };
        connect.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        connect.Click += async (_, _) => await ShowConnection("connect-once");
        sessionActions.Children.Add(connect);
        session.Children.Add(sessionActions);
        var sessionCard = Card(IconRow("\uE716", session));
        var statusRow = new Grid { Name = "OverviewStatusRow", ColumnSpacing = 16 };
        statusRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        statusRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        statusRow.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        statusRow.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetColumn(sessionCard, 1);
        statusRow.Children.Add(hostCard); statusRow.Children.Add(sessionCard);
        statusRow.SizeChanged += (_, _) =>
        {
            bool stacked = statusRow.ActualWidth < 600;
            Grid.SetColumnSpan(hostCard, stacked ? 2 : 1);
            Grid.SetColumnSpan(sessionCard, stacked ? 2 : 1);
            Grid.SetColumn(sessionCard, stacked ? 0 : 1);
            Grid.SetRow(sessionCard, stacked ? 1 : 0);
            statusRow.RowSpacing = stacked ? 16 : 0;
        };
        page.Children.Add(statusRow);

        var displays = new StackPanel { Spacing = 12 };
        var header = new Grid { ColumnSpacing = 8 };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.Children.Add(Label("Your displays", 20));
        var manage = Command("Manage displays  ›", OpenDisplays); Grid.SetColumn(manage, 1); header.Children.Add(manage);
        displays.Children.Add(header);
        overviewDisplayCards = new VariableSizedWrapGrid { Orientation = Orientation.Horizontal, ItemWidth = 210, ItemHeight = 200 };
        for (int i = 0; i < displayInventory.Length; i++)
        {
            var display = displayInventory[i];
            var content = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Stretch };
            var artworkSlot = new Grid { Height = 96 };
            var artwork = MonitorArt(display, i + 1, true);
            artwork.Height = 92; artwork.Width = Math.Min(168, 92.0 * display.Width / display.Height);
            artwork.HorizontalAlignment = HorizontalAlignment.Center;
            artworkSlot.Children.Add(artwork); content.Children.Add(artworkSlot);
            content.Children.Add(Label(display.Primary ? "Main display" : display.Height > display.Width ? "Portrait display" : display.Name, 16));
            content.Children.Add(Secondary(display.Primary ? "Primary capture source" : "Detected · not shared", 12));
            var tile = new Button { Content = content, Margin = new Thickness(0, 0, HostSpacing.Related, HostSpacing.Related), Padding = new Thickness(HostSpacing.Row),
                HorizontalContentAlignment = HorizontalAlignment.Stretch, HorizontalAlignment = HorizontalAlignment.Stretch };
            tile.Click += (_, _) => { selectedDisplay = display.Id; OpenDisplays(); };
            overviewDisplayCards.Children.Add(tile);
        }
        displays.Children.Add(overviewDisplayCards);
        if (displayInventory.Length == 0) displays.Children.Add(Secondary("Display information appears when sharing starts."));
        page.Children.Add(Card(displays));

        page.Children.Add(new Expander { Header = "Connection security", Content = Label(ConnectionSecurityNote()), HorizontalAlignment = HorizontalAlignment.Stretch });
    }
}
