using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    void RenderClientCustomization()
    {
        var content = new StackPanel { Spacing = HostSpacing.Related };
        content.Children.Add(Label("Client customization", 20));
        var row = new Grid { ColumnSpacing = HostSpacing.Card };
        row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        var modes = new StackPanel { Spacing = HostSpacing.Related };
        foreach (var (mode, text) in new[] { ("profiles", "Approved profiles only"), ("options", "Approved options") })
        {
            var radio = new RadioButton { Content = text, GroupName = "ClientMode", IsChecked = streamPolicy!["clientMode"]!.GetValue<string>() == mode,
                IsEnabled = server is not null && !policySaving };
            radio.Checked += async (_, _) => await ChangeClientMode(mode);
            modes.Children.Add(radio);
        }
        row.Children.Add(modes);
        var edit = Command("Edit allowed options", async () =>
        {
            if (dialogOpen || policySaving || streamPolicy is null) return;
            dialogOpen = true;
            try { await CreateAllowedOptionsEditor().ShowAsync(); }
            finally { dialogOpen = false; }
        });
        edit.VerticalAlignment = VerticalAlignment.Center;
        edit.IsEnabled = server is not null && !policySaving;
        Grid.SetColumn(edit, 1); row.Children.Add(edit);
        content.Children.Add(row); page.Children.Add(Card(content));
    }

    async Task ChangeClientMode(string mode)
    {
        try
        {
            if (streamPolicy is null || policySaving || streamPolicy["clientMode"]!.GetValue<string>() == mode) return;
            if (sessionCards.Count > 0 && !await ConfirmProfileApply("Change client customization?")) return;
            var candidate = streamPolicy.DeepClone().AsObject();
            candidate["clientMode"] = mode;
            await SavePolicy(candidate, true);
        }
        catch (Exception error) { policyError = error.Message; }
        finally { if (currentPage == "Streaming profiles") RenderPage(); }
    }

    ContentDialog CreateAllowedOptionsEditor()
    {
        var candidate = streamPolicy!.DeepClone().AsObject();
        var allowed = candidate["allowedOptions"]!.AsObject();
        var form = new StackPanel { Spacing = HostSpacing.Card, MinWidth = 500, MaxWidth = 520 };
        var groups = new Dictionary<string, List<NumberBox[]>>();
        foreach (var (key, title) in new[] { ("resolutions", "Output sizes"), ("frameRates", "Frame rates"), ("bitratesKbps", "Video bitrates") })
        {
            if (form.Children.Count > 0) form.Children.Add(new Border { Height = 1, Background = ResourceBrush("CardStrokeColorDefaultBrush") });
            var group = new Grid { Tag = "allowed-option-group", ColumnSpacing = HostSpacing.Page };
            group.ColumnDefinitions.Add(new() { Width = new GridLength(140) });
            group.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            var heading = Label(title, 16); heading.Margin = new Thickness(0, 6, 0, 0); group.Children.Add(heading);
            var section = new StackPanel { Spacing = HostSpacing.Related };
            var rows = new StackPanel { Spacing = HostSpacing.Related };
            var entries = new List<NumberBox[]>(); groups[key] = entries;
            var add = new Button { Content = "＋ Add", HorizontalAlignment = HorizontalAlignment.Left,
                Style = (Style)Application.Current.Resources["DefaultButtonStyle"] };
            var removes = new List<Button>();
            void Refresh()
            {
                add.IsEnabled = entries.Count < 64;
                foreach (var remove in removes) remove.IsEnabled = entries.Count > 1;
            }
            void AddRow(int first, int second = 0)
            {
                var row = new Grid { ColumnSpacing = HostSpacing.Related };
                bool dimensions = key == "resolutions";
                row.ColumnDefinitions.Add(new() { Width = new GridLength(112) });
                if (dimensions)
                {
                    row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
                    row.ColumnDefinitions.Add(new() { Width = new GridLength(112) });
                }
                else row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
                NumberBox Input(int value, string label) {
                    var input = new NumberBox { Value = key == "bitratesKbps" ? value / 1000.0 : value, Minimum = dimensions ? 64 : key == "frameRates" ? 1 : 0.1,
                        Maximum = dimensions ? 4096 : key == "frameRates" ? 60 : 50,
                        SmallChange = dimensions ? 2 : key == "frameRates" ? 1 : 0.1,
                        SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact, MinWidth = 100 };
                    Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(input, label);
                    return input;
                }
                var left = Input(first, dimensions ? "Width" : title); row.Children.Add(left);
                var fields = new[] { left };
                if (dimensions)
                {
                    var cross = Label("×"); cross.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(cross, 1); row.Children.Add(cross);
                    var right = Input(second, "Height"); Grid.SetColumn(right, 2); row.Children.Add(right); fields = new[] { left, right };
                }
                else
                {
                    var unit = Secondary(key == "frameRates" ? "fps" : "Mbit/s"); unit.VerticalAlignment = VerticalAlignment.Center;
                    Grid.SetColumn(unit, 1); row.Children.Add(unit);
                }
                var remove = new Button { Content = new FontIcon { Glyph = "\uE74D", FontSize = 16 }, VerticalAlignment = VerticalAlignment.Center };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(remove, "Remove " + title);
                remove.Click += (_, _) => { entries.Remove(fields); removes.Remove(remove); rows.Children.Remove(row); Refresh(); };
                Grid.SetColumn(remove, row.ColumnDefinitions.Count - 1); row.Children.Add(remove);
                entries.Add(fields); removes.Add(remove); rows.Children.Add(row); Refresh();
            }
            foreach (var value in allowed[key]!.AsArray())
                if (key == "resolutions") AddRow(value!["width"]!.GetValue<int>(), value["height"]!.GetValue<int>());
                else AddRow(value!.GetValue<int>());
            add.Click += (_, _) => AddRow(key == "resolutions" ? 1920 : key == "frameRates" ? 30 : 4000, 1080);
            add.Margin = new Thickness(0, 40, 0, 0); add.VerticalAlignment = VerticalAlignment.Top; group.Children.Add(add);
            section.Children.Add(rows);
            Grid.SetColumn(section, 1); group.Children.Add(section); form.Children.Add(group);
        }
        var permission = new CheckBox { Content = "Disconnect connected clients when saving", Visibility = sessionCards.Count > 0 ? Visibility.Visible : Visibility.Collapsed };
        form.Children.Add(permission);
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = ResourceBrush("SystemFillColorCriticalBrush") }; form.Children.Add(error);
        var dialog = new ContentDialog { Title = "Edit allowed options", Content = new ScrollViewer { Content = form, MaxHeight = 480, Padding = new Thickness(0, 0, 12, 0) },
            PrimaryButtonText = "Save", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary, XamlRoot = navigation.XamlRoot };
        dialog.Resources["ContentDialogMaxWidth"] = 620d;
        EventHandler<object> alignCommands = (_, _) =>
        {
            FrameworkElement? Find(DependencyObject root, string name)
            {
                for (int i = 0; i < Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChildrenCount(root); i++)
                {
                    var child = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChild(root, i);
                    if (child is FrameworkElement element && element.Name == name) return element;
                    if (Find(child, name) is { } found) return found;
                }
                return null;
            }
            // Preserve the native dialog's keyboard, dismissal and async-save behavior.
            // Adjust only its verified WinUI command grid to match the approved footer.
            if (Find(dialog, "CommandSpace") is Grid commands && commands.ColumnDefinitions.Count == 5 &&
                Find(dialog, "PrimaryButton") is Button save && Find(dialog, "CloseButton") is Button cancel)
            {
                if (Grid.GetColumn(save) != 4 || Grid.GetColumn(cancel) != 2)
                {
                    commands.ColumnDefinitions[0].Width = new GridLength(1, GridUnitType.Star);
                    commands.ColumnDefinitions[2].Width = new GridLength(130);
                    commands.ColumnDefinitions[4].Width = new GridLength(130);
                    Grid.SetColumn(cancel, 2); Grid.SetColumn(save, 4);
                    cancel.TabIndex = 0; save.TabIndex = 1;
                }
            }
        };
        dialog.LayoutUpdated += alignCommands;
        dialog.Closed += (_, _) => dialog.LayoutUpdated -= alignCommands;
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true; var deferral = args.GetDeferral();
            try
            {
                var options = new JsonObject();
                foreach (var (key, entries) in groups)
                {
                    var values = new JsonArray(); var unique = new HashSet<string>();
                    foreach (var fields in entries)
                    {
                        foreach (var field in fields)
                            if (!double.IsFinite(field.Value) || (key != "bitratesKbps" && field.Value != Math.Truncate(field.Value)) || field.Value < field.Minimum || field.Value > field.Maximum)
                                throw new InvalidOperationException("Enter valid values within the allowed ranges.");
                        JsonNode value;
                        if (key == "resolutions")
                        {
                            if (fields.Any(f => f.Value % 2 != 0)) throw new InvalidOperationException("Output width and height must be even.");
                            value = new JsonObject { ["width"] = (int)fields[0].Value, ["height"] = (int)fields[1].Value };
                        }
                        else
                        {
                            double numeric = fields[0].Value * (key == "bitratesKbps" ? 1000 : 1);
                            if (Math.Abs(numeric - Math.Round(numeric)) > 0.000001) throw new InvalidOperationException("Bitrates support at most three decimal places in Mbit/s.");
                            value = JsonValue.Create((int)Math.Round(numeric))!;
                        }
                        if (!unique.Add(value.ToJsonString())) throw new InvalidOperationException("Remove duplicate options before saving.");
                        values.Add(value);
                    }
                    options[key] = values;
                }
                candidate["allowedOptions"] = options;
                await SavePolicy(candidate, permission.IsChecked == true);
                args.Cancel = false;
            }
            catch (Exception exception) { error.Text = exception.Message; }
            finally { deferral.Complete(); }
        };
        return dialog;
    }
}
