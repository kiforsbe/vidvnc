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
    readonly TextBlock detail = new() { Text = "Checking your display and graphics hardware…", TextWrapping = TextWrapping.Wrap };
    readonly TextBox address = new() { Header = "Open this address on your other device", IsReadOnly = true };
    readonly TextBox password = new() { IsReadOnly = true, FontFamily = new FontFamily("Cascadia Mono"), FontSize = 24 };
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
        Closed += async (_, _) => { closing = true; CloseIdentify(); await StopServer(); };
        _ = StartServer();
    }
    // Starts sharing. `sharingMode` is "local" (the default) or "remote"; the server applies it
    // and reports in the ready message if remote access could not be turned on.
    async Task StartServer(string sharingMode = "local")
    {
        if (closing || starting || server is not null) return;
        starting = true;
        requestedSharing = sharingMode == "remote" ? "remote" : "local";
        sharingNotice = null;
        Process? child = null;
        ServerJob? job = null;
        try
        {
            var runtime = RuntimeManifest.Load(ManifestFilename());
            var start = runtime.ServerStartInfo(Environment.GetEnvironmentVariable("VIDVNC_INSPECT") == "1");
            start.ArgumentList.Add("--await-owner");
            job = new ServerJob();
            child = Process.Start(start) ?? throw new InvalidOperationException("Unable to start the server.");
            job.Assign(child);
            server = child;
            UpdateSharingIndicator();
            // Exactly the approval lines the server's owner gate accepts (owner-start.mjs).
            await child.StandardInput.WriteLineAsync(requestedSharing == "remote"
                ? "{\"type\":\"start\",\"sharing\":\"remote\"}" : "{\"type\":\"start\",\"sharing\":\"local\"}");
            await child.StandardInput.FlushAsync();
            var errors = child.StandardError.ReadToEndAsync();
            while (await child.StandardOutput.ReadLineAsync() is { } line)
            {
                using var document = JsonDocument.Parse(line);
                var ready = document.RootElement;
                if (ready.GetProperty("type").GetString() == "policy-result") { ReceivePolicyResult(ready); continue; }
                if (ready.GetProperty("type").GetString() == "access-result") { ReceiveAccessResult(ready); continue; }
                if (ready.GetProperty("type").GetString() == "session-result") { ReceiveSessionResult(ready); continue; }
                if (ready.GetProperty("type").GetString() is "client-setup-result" or "connection-once-result" or "session-password-result" or "client-command-result" or "diagnostics-capability-result") { ReceiveClientResult(ready); continue; }
                if (ready.GetProperty("type").GetString() == "clients") { UpdateClients(ready); continue; }
                if (ready.GetProperty("type").GetString() == "tls-regenerate-result") { ReceiveTlsRegenerateResult(ready); continue; }
                // The status tick carries the TLS report alongside the sessions; both are
                // views of the same snapshot, so they are read from the same message.
                if (ready.GetProperty("type").GetString() == "status") { UpdateSessions(ready); UpdateTlsStatus(ready); UpdateCodeStatus(ready); continue; }
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
                // `ready.urls` can be empty while HTTPS is pending or failed. The separate
                // owner-only TLS field supplies viewer and local trust roots explicitly.
                UpdateTlsStatus(ready);
                password.Text = ready.GetProperty("password").GetString() ?? "";
                sharingNotice = ready.TryGetProperty("sharingNotice", out var notice) ? notice.GetString() : null;
                displayDescription = $"{ready.GetProperty("width").GetInt32()} × {ready.GetProperty("height").GetInt32()} · {vendorLabel} {codecLabel}";
                if (ready.TryGetProperty("displays", out var displays)) UpdateDisplays(displays);
                if (ready.TryGetProperty("policy", out var policy)) UpdatePolicy(policy);
                if (ready.TryGetProperty("access", out var access)) UpdateAccess(access);
                if (ready.TryGetProperty("clients", out var clients)) UpdateClients(clients);
                SetSharing(true);
            }
            await child.WaitForExitAsync();
            if (server == child) server = null;
            if (!closing && !stopping)
            {
                heading.Text = "Sharing stopped"; password.Text = "";
                var error = await errors;
                detail.Text = child.ExitCode == 0 ? "Select Sharing is off in the navigation pane to start again." : error.Trim();
            }
        }
        catch (Exception error) { if (!closing) { heading.Text = "Unable to start sharing"; detail.Text = error.Message + "\nSelect Sharing is off in the navigation pane to try again."; } }
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
        UpdateSharingIndicator();
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
            if (!closing) { heading.Text = "Sharing is off"; detail.Text = "Your desktop is private. Select Sharing is off in the navigation pane to start sharing with a new password."; password.Text = ""; UpdateSharingIndicator(); }
        }
    }
}
