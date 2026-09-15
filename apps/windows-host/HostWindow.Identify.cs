using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    readonly List<Window> identifyWindows = [];
    DispatcherTimer? identifyTimer;
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern nint IdentifyGetWindowLong(nint hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern nint IdentifySetWindowLong(nint hwnd, int index, nint value);

    void CloseIdentify()
    {
        identifyTimer?.Stop(); identifyTimer = null;
        foreach (var window in identifyWindows.ToArray()) window.Close();
        identifyWindows.Clear();
    }

    void IdentifyDisplays()
    {
        CloseIdentify();
        if (closing) return;
        try
        {
            for (int i = 0; i < displayInventory.Length; i++)
            {
                var display = displayInventory[i];
                var area = DisplayArea.GetFromPoint(new PointInt32(display.X + display.Width / 2, display.Y + display.Height / 2), DisplayAreaFallback.None);
                // A removed/rearranged display must not label some other monitor.
                if (area is null || area.OuterBounds.X != display.X || area.OuterBounds.Y != display.Y ||
                    area.OuterBounds.Width != display.Width || area.OuterBounds.Height != display.Height) continue;
                var window = new Window { Title = $"VidVNC · Display {i + 1}" };
                identifyWindows.Add(window);
                var content = new StackPanel { Spacing = 0, Margin = new Thickness(16, 6, 16, 10) };
                content.Children.Add(new TextBlock { Text = (i + 1).ToString(), FontSize = 44,
                    FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = new SolidColorBrush(Microsoft.UI.Colors.White) });
                content.Children.Add(new TextBlock { Text = "VidVNC", FontSize = 14, Foreground = new SolidColorBrush(Microsoft.UI.Colors.White) });
                window.Content = new Border { Background = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 28, 34, 42)),
                    CornerRadius = new CornerRadius(8), Child = content };
                var presenter = (OverlappedPresenter)window.AppWindow.Presenter;
                presenter.SetBorderAndTitleBar(false, false);
                presenter.IsResizable = presenter.IsMaximizable = presenter.IsMinimizable = false;
                presenter.IsAlwaysOnTop = true;
                window.AppWindow.IsShownInSwitchers = false;
                var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
                IdentifySetWindowLong(hwnd, -8, WinRT.Interop.WindowNative.GetWindowHandle(this)); // owned popup
                IdentifySetWindowLong(hwnd, -20, IdentifyGetWindowLong(hwnd, -20) | 0x08000080); // NOACTIVATE | TOOLWINDOW
                window.AppWindow.Move(new PointInt32(display.X, display.Y));
                var dpi = Math.Max(96, GetDpiForWindow(hwnd)) / 96.0;
                var work = area.WorkArea;
                int width = Math.Min(work.Width, (int)Math.Round(110 * dpi));
                int height = Math.Min(work.Height, (int)Math.Round(100 * dpi));
                int inset = (int)Math.Round(24 * dpi);
                window.AppWindow.MoveAndResize(new RectInt32(work.X + Math.Min(inset, Math.Max(0, work.Width - width)),
                    work.Y + Math.Max(0, work.Height - height - inset), width, height));
                window.Closed += (_, _) => identifyWindows.Remove(window);
                window.AppWindow.Show(false);
            }
            identifyTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            identifyTimer.Tick += (_, _) => CloseIdentify();
            identifyTimer.Start();
        }
        catch (Exception error)
        {
            CloseIdentify();
            page.Children.Add(new InfoBar { IsOpen = true, Severity = InfoBarSeverity.Error,
                Message = "Couldn't identify displays: " + error.Message });
        }
    }
}
