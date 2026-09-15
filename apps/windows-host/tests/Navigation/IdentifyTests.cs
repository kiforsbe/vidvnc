using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using VidVnc.Host;

namespace VidVnc.NavigationTests;

public partial class App
{
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();

    static async Task CheckIdentify(HostWindow host, BindingFlags flags)
    {
        var update = typeof(HostWindow).GetMethod("UpdateDisplays", flags)!;
        var identify = typeof(HostWindow).GetMethod("IdentifyDisplays", flags)!;
        var windows = (List<Window>)typeof(HostWindow).GetField("identifyWindows", flags)!.GetValue(host)!;
        var area = DisplayArea.GetFromWindowId(host.AppWindow.Id, DisplayAreaFallback.Primary);
        var bounds = area.OuterBounds;
        using var inventory = JsonDocument.Parse(JsonSerializer.Serialize(new[] {
            new { id = "identify-test", name = "Test display", primary = true,
                x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height, rotation = 0 }
        }));
        update.Invoke(host, new object[] { inventory.RootElement });
        var foreground = GetForegroundWindow();
        identify.Invoke(host, null);
        if (windows.Count != 1) throw new Exception("Identify must show one overlay on the exact physical display");
        var overlay = windows.Single();
        if (GetForegroundWindow() != foreground) throw new Exception("Identify stole focus");
        if (!overlay.AppWindow.IsVisible || overlay.AppWindow.IsShownInSwitchers)
            throw new Exception("Identify must be visible but absent from task switching");
        var position = overlay.AppWindow.Position;
        var size = overlay.AppWindow.Size;
        var work = area.WorkArea;
        if (position.X < work.X || position.Y < work.Y || position.X + size.Width > work.X + work.Width ||
            position.Y + size.Height > work.Y + work.Height || position.Y < work.Y + work.Height / 2)
            throw new Exception("Identify label must fit near the bottom of its monitor");
        bool replacedClosed = false;
        overlay.Closed += (_, _) => replacedClosed = true;
        identify.Invoke(host, null);
        if (!replacedClosed || windows.Count != 1) throw new Exception("Repeated Identify must replace, not accumulate, overlays");
        await Task.Delay(3500);
        if (windows.Count != 0) throw new Exception("Identify did not expire after three seconds");
        identify.Invoke(host, null);
        using var empty = JsonDocument.Parse("[]");
        update.Invoke(host, new object[] { empty.RootElement });
        if (windows.Count != 0) throw new Exception("Inventory changes must dismiss Identify overlays");
        identify.Invoke(host, null);
        if (windows.Count != 0) throw new Exception("Identify must not substitute a missing monitor");
        typeof(HostWindow).GetMethod("CloseIdentify", flags)!.Invoke(host, null);
    }
}
