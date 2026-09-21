using System.Diagnostics;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;

namespace VidVnc.Host;

public sealed partial class HostWindow : Window
{
    readonly TextBlock heading = new() { Text = "Getting your desktop ready", Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] };
    readonly TextBlock detail = new() { Text = "Checking your display and NVIDIA hardware…", TextWrapping = TextWrapping.Wrap };
    readonly TextBox address = new() { Header = "Open this address on your other device", IsReadOnly = true };
    readonly TextBox password = new() { IsReadOnly = true, FontFamily = new FontFamily("Cascadia Mono"), FontSize = 24 };
    readonly InfoBar notice = new() { IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Informational, Title = "Only on your trusted network", Message = "This preview uses HTTP pairing. Allow private-network firewall access only. Never forward its port to the Internet." };
    readonly Button action = new() { Content = "Stop sharing", IsEnabled = false };
    Process? server;
    bool closing;
    bool stopping;
    bool starting;
    string[] hostCodecs = ["h264"];
    // Encoder families this machine can actually encode with, as the server reported them.
    // Empty until the server is ready; the Codecs page then offers exactly these.
    (string Id, string Label)[] hostBackends = [];

    public HostWindow()
    {
        Title = "VidVNC";
        SystemBackdrop = new MicaBackdrop();
        BuildShell();
        action.Click += async (_, _) => { if (server is null) await StartServer(); else await StopServer(); };
        Closed += async (_, _) => { closing = true; CloseIdentify(); await StopServer(); };
        _ = StartServer();
    }
    async Task StartServer()
    {
        if (closing || starting || server is not null) return;
        starting = true;
        action.IsEnabled = false;
        Process? child = null;
        ServerJob? job = null;
        try
        {
            var adjacent = Path.Combine(AppContext.BaseDirectory, "runtime.json");
            // An installed manifest takes priority over inherited development overrides.
            var filename = File.Exists(adjacent) ? adjacent :
                Environment.GetEnvironmentVariable("VIDVNC_RUNTIME_MANIFEST") ?? adjacent;
            var runtime = RuntimeManifest.Load(filename);
            var start = runtime.ServerStartInfo(Environment.GetEnvironmentVariable("VIDVNC_INSPECT") == "1");
            start.ArgumentList.Add("--await-owner");
            job = new ServerJob();
            child = Process.Start(start) ?? throw new InvalidOperationException("Unable to start the server.");
            job.Assign(child);
            server = child;
            await child.StandardInput.WriteLineAsync("{\"type\":\"start\"}");
            await child.StandardInput.FlushAsync();
            var errors = child.StandardError.ReadToEndAsync();
            while (await child.StandardOutput.ReadLineAsync() is { } line)
            {
                using var document = JsonDocument.Parse(line);
                var ready = document.RootElement;
                if (ready.GetProperty("type").GetString() == "policy-result") { ReceivePolicyResult(ready); continue; }
                if (ready.GetProperty("type").GetString() == "access-result") { ReceiveAccessResult(ready); continue; }
                if (ready.GetProperty("type").GetString() == "session-result") { ReceiveSessionResult(ready); continue; }
                if (ready.GetProperty("type").GetString() is "client-setup-result" or "connection-once-result" or "client-command-result") { ReceiveClientResult(ready); continue; }
                if (ready.GetProperty("type").GetString() == "clients") { UpdateClients(ready); continue; }
                if (ready.GetProperty("type").GetString() == "status") { UpdateSessions(ready); continue; }
                if (ready.GetProperty("type").GetString() == "displays") { UpdateDisplays(ready.GetProperty("displays")); continue; }
                if (ready.GetProperty("type").GetString() != "ready") continue;
                if (ready.TryGetProperty("codecs", out var readyCodecs) && readyCodecs.ValueKind == JsonValueKind.Array)
                    hostCodecs = readyCodecs.EnumerateArray().Select(codec => codec.GetString()!).ToArray();
                if (ready.TryGetProperty("backends", out var readyBackends) && readyBackends.ValueKind == JsonValueKind.Array)
                    hostBackends = readyBackends.EnumerateArray()
                        .Select(backend => (backend.GetProperty("id").GetString()!, backend.GetProperty("label").GetString()!))
                        .ToArray();
                var codecLabel = string.Join(" / ", hostCodecs.Select(CodecLabel));
                // Name the GPU family that will actually encode. This used to read "NVIDIA"
                // unconditionally, which was wrong on every Intel and AMD machine.
                var vendorLabel = hostBackends.Length > 0 ? hostBackends[0].Label : "Hardware";
                heading.Text = "Your desktop is ready";
                detail.Text = $"{ready.GetProperty("width").GetInt32()} × {ready.GetProperty("height").GetInt32()} · {vendorLabel} {codecLabel}\nConnect from your browser. Keyboard and mouse start off.";
                address.Text = ready.GetProperty("urls")[0].GetString() ?? "";
                password.Text = ready.GetProperty("password").GetString() ?? "";
                displayDescription = $"{ready.GetProperty("width").GetInt32()} × {ready.GetProperty("height").GetInt32()} · {vendorLabel} {codecLabel}";
                if (ready.TryGetProperty("displays", out var displays)) UpdateDisplays(displays);
                if (ready.TryGetProperty("policy", out var policy)) UpdatePolicy(policy);
                if (ready.TryGetProperty("access", out var access)) UpdateAccess(access);
                if (ready.TryGetProperty("clients", out var clients)) UpdateClients(clients);
                previewUrl = ready.GetProperty("urls").EnumerateArray().Select(x => x.GetString()).FirstOrDefault(x => x?.StartsWith("http://127.0.0.1:") == true);
                SetSharing(true);
                action.Content = "Stop sharing"; action.IsEnabled = true;
            }
            await child.WaitForExitAsync();
            if (server == child) server = null;
            if (!closing && !stopping)
            {
                heading.Text = "Sharing stopped"; password.Text = "";
                var error = await errors;
                detail.Text = child.ExitCode == 0 ? "Start again when you’re ready." : error.Trim();
                action.Content = "Start sharing"; action.IsEnabled = true;
            }
        }
        catch (Exception error) { if (!closing) { heading.Text = "Unable to start sharing"; detail.Text = error.Message; action.Content = "Try again"; action.IsEnabled = true; } }
        finally
        {
            job?.Dispose();
            if (child is not null)
            {
                // Assignment can fail before job ownership is established. The gate prevents capture in that case.
                if (!child.HasExited) child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync();
                if (server == child) server = null;
                child.Dispose();
            }
            starting = false;
            policyReply?.TrySetException(new IOException("Server stopped before acknowledging settings."));
            accessReady = false;
            accessReply?.TrySetException(new IOException("Server stopped before acknowledging access settings."));
            foreach (var reply in sessionReplies.Values) reply.TrySetException(new IOException("Server stopped before acknowledging the session action."));
            foreach (var reply in clientReplies.Values) reply.TrySetException(new IOException("Server stopped before acknowledging the client action."));
            SetSharing(false);
        }
    }
    async Task StopServer()
    {
        var child = server; if (child is null || stopping) return; stopping = true;
        action.IsEnabled = false;
        try
        {
            await child.StandardInput.WriteLineAsync("{\"type\":\"stop\"}"); await child.StandardInput.FlushAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { await child.WaitForExitAsync(timeout.Token); } catch (OperationCanceledException) { child.Kill(entireProcessTree: true); }
        }
        catch (Exception error) when (error is InvalidOperationException or IOException) { }
        finally
        {
            server = null; stopping = false;
            if (!closing) { heading.Text = "Sharing is off"; detail.Text = "Your desktop is private. Start sharing to create a new password."; password.Text = ""; action.Content = "Start sharing"; action.IsEnabled = true; }
        }
    }
}
