using System.Diagnostics;

namespace VidVnc.Host;

// WM_QUERYENDSESSION is only consent: shutdown may still be canceled by another app.
// The committed WM_ENDSESSION callback cannot depend on the UI message loop continuing.
public static class SessionShutdown
{
    public static bool IsCommitted(uint message, IntPtr wParam) => message == 0x16 && wParam != IntPtr.Zero;

    public static void StopServer(Process? child)
    {
        if (child is null) return;
        try
        {
            if (child.HasExited) return;
            child.StandardInput.WriteLine("{\"type\":\"stop\"}");
            child.StandardInput.Flush();
            if (!child.WaitForExit(5000))
            {
                child.Kill(entireProcessTree: true);
                child.WaitForExit(1000);
            }
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or System.ComponentModel.Win32Exception) { }
    }
}
