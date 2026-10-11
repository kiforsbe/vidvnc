using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

// The notification-area (system tray) icon. Closing the window hides it and VidVNC stays
// running behind this icon, still sharing unless the owner turned that off in Settings; the
// macOS host does the same from the menu bar. The icon's tooltip and menu show the sharing
// state, so sharing is never left on with nothing on screen saying so. Quit, in the icon's
// menu, is what stops sharing and exits. WinUI has no tray control, so this is Shell_NotifyIcon
// on the window's own handle, whose messages arrive through a window subclass.
public sealed partial class HostWindow
{
    const uint TrayMessage = 0x8000 + 1; // WM_APP + 1
    const uint TrayIconId = 1;
    const int OpenCommand = 1, SharingCommand = 2, RemoteCommand = 3, QuitCommand = 4;
    HostPreferencesStore preferences = new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VidVNC", "host-settings.json"));
    bool keepSharingOnClose = true;
    bool quitting;
    bool trayAdded;
    bool trayHintShown;
    IntPtr windowHandle, trayIcon;
    bool trayIconOwned;
    uint taskbarCreated;
    // Kept in a field: native code holds only a pointer to it, which must not be collected.
    SubclassProc? trayProc;

    void BuildTray()
    {
        LoadPreferences();
        windowHandle = WinRT.Interop.WindowNative.GetWindowHandle(this);
        taskbarCreated = RegisterWindowMessageW("TaskbarCreated");
        trayProc = TrayWindowProc;
        SetWindowSubclass(windowHandle, trayProc, 1, UIntPtr.Zero);
        var small = new IntPtr[1];
        if (Environment.ProcessPath is { } executable && ExtractIconExW(executable, 0, null, small, 1) > 0 && small[0] != IntPtr.Zero)
        { trayIcon = small[0]; trayIconOwned = true; }
        else trayIcon = LoadIconW(IntPtr.Zero, 32512); // IDI_APPLICATION, for a build without the icon
        AddTrayIcon();
        // Only the title bar's close button, Alt+F4 and the taskbar's Close window raise Closing;
        // Window.Close() from Quit does not, so Quit always closes for real.
        AppWindow.Closing += async (_, args) =>
        {
            // VIDVNC_HOST_QUIT_ON_CLOSE=1 makes closing the window quit, for scripts that close
            // the host they started (tools/screenshot-host.ps1).
            if (quitting || Environment.GetEnvironmentVariable("VIDVNC_HOST_QUIT_ON_CLOSE") == "1") return;
            args.Cancel = true;
            CloseIdentify();
            AppWindow.Hide();
            if (!trayHintShown) { trayHintShown = true; ShowTrayNotice(); }
            if (!keepSharingOnClose && server is not null) await StopServer();
        };
    }

    void LoadPreferences()
    {
        try { keepSharingOnClose = preferences.Load().KeepSharingOnClose; }
        catch (Exception error) when (error is IOException or InvalidDataException or JsonException or UnauthorizedAccessException)
        { keepSharingOnClose = true; }
    }

    void SaveKeepSharingOnClose(bool value)
    {
        keepSharingOnClose = value;
        try { preferences.Save(new HostPreferencesStore.Values(value)); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    // Settings: what closing the window does. VidVNC stays in the notification area either way.
    void RenderCloseSettings()
    {
        var content = new StackPanel { Spacing = HostSpacing.Small, Tag = "close-settings" };
        var keep = new ToggleSwitch { Header = "Keep sharing when the window closes", IsOn = keepSharingOnClose,
            OnContent = "On", OffContent = "Off", Tag = "keep-sharing-on-close" };
        keep.Toggled += (_, _) => { SaveKeepSharingOnClose(keep.IsOn); RenderPage(); };
        content.Children.Add(keep);
        content.Children.Add(Secondary(keepSharingOnClose
            ? "Closing the window keeps VidVNC sharing from the notification area. To stop sharing and exit, right-click the VidVNC icon there and choose Quit VidVNC. Automatic startup is off."
            : "Closing the window stops sharing. VidVNC stays in the notification area; right-click its icon and choose Quit VidVNC to exit. Automatic startup is off."));
        page.Children.Add(Card(content));
    }

    void RemoveTray()
    {
        if (trayAdded) { var data = TrayData(0); Shell_NotifyIconW(NimDelete, ref data); trayAdded = false; }
        if (trayIconOwned) { DestroyIcon(trayIcon); trayIconOwned = false; }
        if (trayProc is not null && windowHandle != IntPtr.Zero) RemoveWindowSubclass(windowHandle, trayProc, 1);
    }

    void AddTrayIcon()
    {
        var data = TrayData(NifMessage | NifIcon | NifTip | NifShowTip);
        trayAdded = Shell_NotifyIconW(NimAdd, ref data);
        if (!trayAdded) return;
        data.uVersion = NotifyIconVersion4;
        Shell_NotifyIconW(NimSetVersion, ref data);
    }

    // Called from UpdateSharingIndicator, so the tooltip follows every change of state.
    void UpdateTrayTip()
    {
        if (!trayAdded) return;
        var data = TrayData(NifTip | NifShowTip);
        Shell_NotifyIconW(NimModify, ref data);
    }

    string TrayState() => sharingScope.Text.Length == 0 ? sharingText.Text : $"{sharingText.Text} · {sharingScope.Text}";

    void ShowTrayNotice()
    {
        if (!trayAdded) return;
        var data = TrayData(NifInfo);
        data.szInfoTitle = keepSharingOnClose && server is not null ? "VidVNC is still sharing" : "VidVNC is still running";
        data.szInfo = "Select the VidVNC icon to open it again. To exit, right-click it and choose Quit VidVNC.";
        data.dwInfoFlags = NiifInfo | NiifRespectQuietTime;
        Shell_NotifyIconW(NimModify, ref data);
    }

    void ShowFromTray()
    {
        AppWindow.Show();
        if (AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter { State: Microsoft.UI.Windowing.OverlappedPresenterState.Minimized } presenter)
            presenter.Restore();
        Activate();
        SetForegroundWindow(windowHandle);
    }

    void Quit()
    {
        quitting = true;
        // The Closed handler stops sharing and the server, as it always has.
        Close();
    }

    void ShowTrayMenu(int x, int y)
    {
        var menu = CreatePopupMenu();
        try
        {
            var busy = stopping || (server is not null && !sharing);
            AppendMenuW(menu, MfString | MfGrayed, 0, "VidVNC: " + TrayState());
            AppendMenuW(menu, MfSeparator, 0, null);
            AppendMenuW(menu, MfString, OpenCommand, "Open VidVNC");
            AppendMenuW(menu, MfString | (busy ? MfGrayed : 0), SharingCommand, server is null ? "Start sharing on the local network" : "Stop sharing");
            if (server is null) AppendMenuW(menu, MfString | (busy ? MfGrayed : 0), RemoteCommand, "Start sharing with remote access");
            AppendMenuW(menu, MfSeparator, 0, null);
            AppendMenuW(menu, MfString, QuitCommand, "Quit VidVNC");
            // The documented pattern: the owner must be foreground for the menu to close when
            // the user clicks elsewhere, and WM_NULL afterwards lets a second click open it again.
            SetForegroundWindow(windowHandle);
            var command = TrackPopupMenuEx(menu, TpmReturnCmd | TpmRightButton, x, y, windowHandle, IntPtr.Zero);
            PostMessageW(windowHandle, 0, IntPtr.Zero, IntPtr.Zero);
            // Run outside the window procedure: these await and may re-render the window.
            DispatcherQueue.TryEnqueue(async () =>
            {
                switch (command)
                {
                    case OpenCommand: ShowFromTray(); break;
                    case SharingCommand: await ToggleSharing(); break;
                    case RemoteCommand: await StartServer("remote"); break;
                    case QuitCommand: Quit(); break;
                }
            });
        }
        finally { DestroyMenu(menu); }
    }

    IntPtr TrayWindowProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam, UIntPtr id, UIntPtr data)
    {
        if (message == TrayMessage)
        {
            // NOTIFYICON_VERSION_4: the event is in lParam's low word, the anchor point in wParam.
            var trayEvent = (uint)(lParam.ToInt64() & 0xFFFF);
            var x = (short)(wParam.ToInt64() & 0xFFFF); var y = (short)((wParam.ToInt64() >> 16) & 0xFFFF);
            if (trayEvent is NinSelect or NinKeySelect) DispatcherQueue.TryEnqueue(ShowFromTray);
            else if (trayEvent == WmContextMenu) ShowTrayMenu(x, y);
            return IntPtr.Zero;
        }
        // Explorer restarted: its notification area is new and empty, so add the icon again.
        if (message == taskbarCreated && taskbarCreated != 0) { trayAdded = false; AddTrayIcon(); }
        return DefSubclassProc(hWnd, message, wParam, lParam);
    }

    NotifyIconData TrayData(uint flags)
    {
        var tip = "VidVNC: " + TrayState();
        return new NotifyIconData
        {
            cbSize = Marshal.SizeOf<NotifyIconData>(), hWnd = windowHandle, uID = TrayIconId, uFlags = flags,
            uCallbackMessage = TrayMessage, hIcon = trayIcon, szTip = tip.Length > 127 ? tip[..127] : tip,
            szInfo = "", szInfoTitle = "",
        };
    }

    const uint NimAdd = 0, NimModify = 1, NimDelete = 2, NimSetVersion = 4, NotifyIconVersion4 = 4;
    const uint NifMessage = 0x1, NifIcon = 0x2, NifTip = 0x4, NifInfo = 0x10, NifShowTip = 0x80;
    const uint NiifInfo = 0x1, NiifRespectQuietTime = 0x80;
    const uint NinSelect = 0x400, NinKeySelect = 0x401, WmContextMenu = 0x7B;
    const uint MfString = 0x0, MfGrayed = 0x1, MfSeparator = 0x800, TpmRightButton = 0x2, TpmReturnCmd = 0x100;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct NotifyIconData
    {
        public int cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    delegate IntPtr SubclassProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam, UIntPtr id, UIntPtr data);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern bool Shell_NotifyIconW(uint message, ref NotifyIconData data);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern uint ExtractIconExW(string file, int index, IntPtr[]? large, IntPtr[]? small, uint count);
    [DllImport("comctl32.dll")] static extern bool SetWindowSubclass(IntPtr hWnd, SubclassProc proc, UIntPtr id, UIntPtr data);
    [DllImport("comctl32.dll")] static extern bool RemoveWindowSubclass(IntPtr hWnd, SubclassProc proc, UIntPtr id);
    [DllImport("comctl32.dll")] static extern IntPtr DefSubclassProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessageW(string name);
    [DllImport("user32.dll")] static extern IntPtr LoadIconW(IntPtr instance, IntPtr name);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool AppendMenuW(IntPtr menu, uint flags, nuint id, string? text);
    [DllImport("user32.dll")] static extern int TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr hWnd, IntPtr parameters);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
