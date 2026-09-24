using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using QRCoder;
using Windows.Storage.Streams;

namespace VidVnc.Host;

// The HTTPS section on the Settings page, and the two actions it offers.
//
// Everything here is a view of one thing the server sends: the `tls` object carried on the
// periodic `status` message (apps/server/src/tls/desktop-status.mjs). Nothing is inferred
// locally and nothing is cached across sharing sessions, so what this shows is always what
// the running listener actually reports.
//
// Two rules from the design govern this file:
//
//   * "TLS never degrades silently." When provisioning failed, the reason the server sent is
//     shown here, plainly, because this is where an operator looks to find out why HTTPS is
//     not working. The reason is already sanitized server-side; this file never has and
//     never asks for the raw failure text.
//   * The consequence of regenerating depends on which strategy is active: under
//     `windows-self-signed` the leaf certificate *is* the trust anchor, so every reissue
//     requires enrolling every device again; under `mkcert` the anchor is the CA, which a
//     reissue does not touch. The section names the strategy and states the consequence
//     next to the action, rather than leaving it to be discovered.
public sealed partial class HostWindow
{
    // The server's `tls` field, as a value type so an unchanged tick (one a second) can be
    // told from a real change and not rebuild the page under the user's cursor.
    sealed record TlsReport(
        string Mode, bool Active, int? Port, string? Strategy, string? EnrolmentStatus,
        string? Fingerprint, DateTimeOffset? Expiry, bool Expired, bool NeedsRenewal, string? Reason,
        bool HttpViewerEnabled, bool ViewerReady, string? ViewerUrl);

    TlsReport? tlsReport;
    // A currently bound local HTTP root, kept separate from viewer URLs: the enrolment page
    // is served unencrypted on purpose (a device
    // that does not trust this PC yet cannot fetch the anchor over a connection that anchor
    // exists to authenticate), so the QR code still needs this.
    string? plaintextAddress;
    bool tlsRegenerating;
    string? tlsError;
    TaskCompletionSource<JsonElement>? tlsReply;

    static string? FirstUrl(JsonElement parent, string property, string scheme)
    {
        if (!parent.TryGetProperty(property, out var urls) || urls.ValueKind != JsonValueKind.Array) return null;
        foreach (var item in urls.EnumerateArray())
            if (item.ValueKind == JsonValueKind.String && Uri.TryCreate(item.GetString(), UriKind.Absolute, out var uri) && uri.Scheme == scheme)
                return uri.GetLeftPart(UriPartial.Authority);
        return null;
    }

    void UpdateTlsStatus(JsonElement status)
    {
        if (!status.TryGetProperty("tls", out var tls) || tls.ValueKind != JsonValueKind.Object) return;
        var next = new TlsReport(
            Text(tls, "mode", "off"),
            tls.TryGetProperty("active", out var active) && active.ValueKind == JsonValueKind.True,
            // `port` is null whenever nothing is bound, and TryGetInt32 throws rather than
            // returning false when asked to read a JSON null, so the kind is checked first.
            tls.TryGetProperty("port", out var port) && port.ValueKind == JsonValueKind.Number &&
                port.TryGetInt32(out var portValue) ? portValue : null,
            Text(tls, "strategy") is { Length: > 0 } strategy ? strategy : null,
            Text(tls, "enrolmentStatus") is { Length: > 0 } enrolment ? enrolment : null,
            Text(tls, "fingerprint") is { Length: > 0 } fingerprint ? fingerprint : null,
            DateTimeOffset.TryParse(Text(tls, "expiry"), out var expiry) ? expiry : null,
            tls.TryGetProperty("expired", out var expired) && expired.ValueKind == JsonValueKind.True,
            tls.TryGetProperty("needsRenewal", out var renewal) && renewal.ValueKind == JsonValueKind.True,
            Text(tls, "reason") is { Length: > 0 } reason ? reason : null,
            tls.TryGetProperty("httpViewerEnabled", out var httpViewer) && httpViewer.ValueKind == JsonValueKind.True,
            tls.TryGetProperty("viewerReady", out var viewerReady) && viewerReady.ValueKind == JsonValueKind.True,
            FirstUrl(tls, "viewerUrls", "https") ?? FirstUrl(tls, "viewerUrls", "http"));
        var priorPlaintext = plaintextAddress;
        plaintextAddress = FirstUrl(tls, "localHttpUrls", "http");
        previewUrl = null;
        if (tls.TryGetProperty("viewerUrls", out var viewerUrls) && viewerUrls.ValueKind == JsonValueKind.Array)
            foreach (var item in viewerUrls.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String && Uri.TryCreate(item.GetString(), UriKind.Absolute, out var uri) && uri.Host is "127.0.0.1" or "::1")
                { previewUrl = uri.GetLeftPart(UriPartial.Authority); break; }
        // A failed regenerate leaves a message that has to outlive the tick it was set on
        // (status arrives once a second), but must not outlive the problem. It is cleared
        // when the server's own report actually *recovers* — an unhealthy report followed by
        // a healthy one — rather than on any healthy report at all: a refusal raised against
        // an already-healthy listener (asking to regenerate a supplied certificate, a broken
        // pipe) would otherwise be wiped within a second of being shown, before it could be
        // read.
        var recovered = next.Reason is null && tlsReport is { Reason: not null } && tlsError is not null;
        if (recovered) tlsError = null;
        var changed = tlsReport != next || recovered || priorPlaintext != plaintextAddress;
        tlsReport = next;
        ApplyTlsAddress();
        // Settings shows the full TLS section; Overview's "Connection security" note also
        // reads `tlsReport` (ConnectionSecurityNote), so a transition while looking at either
        // page must repaint it rather than leave a stale encrypted/unencrypted claim on screen.
        if (changed && currentPage is "Settings" or "Overview") RenderPage();
    }

    void ReceiveTlsRegenerateResult(JsonElement value) => tlsReply?.TrySetResult(value.Clone());

    // Viewer addresses come from the server's explicit viewer list, never from a local
    // trust root. In auto/provided mode a failed TLS listener yields no viewer address.
    void ApplyTlsAddress()
    {
        address.Text = tlsReport is { ViewerReady: true, ViewerUrl: { } viewer } ? viewer
            : tlsReport?.Reason?.StartsWith("HTTPS has not started yet.") == true
                ? "Waiting for HTTPS"
                : "HTTPS unavailable — check Settings";
        openPreview.IsEnabled = sharing && tlsReport?.ViewerReady == true && previewUrl is not null;
        connectDevice.IsEnabled = sharing && tlsReport?.ViewerReady == true;
    }

    // The enrolment page, always on the plaintext listener (the server leaves that one path
    // unredirected for exactly this reason).
    string? EnrolmentUrl() =>
        Uri.TryCreate(plaintextAddress, UriKind.Absolute, out var uri) ? new Uri(uri, "/trust").AbsoluteUri : null;

    // The Overview page's "Connection security" note. It used to be a fixed string written
    // before HTTPS existed, claiming pairing was always unencrypted HTTP — which the Settings
    // page's own HTTPS section could already be contradicting by the time a user read it.
    // `tlsReport` is null only in the brief window before the first status tick, where the
    // conservative (pre-HTTPS) wording is still the honest default.
    string ConnectionSecurityNote() => tlsReport is { Active: true, ViewerReady: true }
        ? "This preview uses HTTPS pairing, which is encrypted. Devices must install this PC's certificate once before connecting without a browser warning — see the HTTPS section below. Allow private-network firewall access only. Never forward its port to the Internet."
        : tlsReport is { HttpViewerEnabled: true, ViewerReady: true }
            ? "This preview uses LAN-only HTTP pairing, which is not encrypted. Allow private-network firewall access only. Never forward its port to the Internet."
            : "The viewer is waiting for HTTPS or HTTPS is unavailable. Local HTTP is only for trust enrollment; it cannot open a viewer. Check HTTPS in Settings.";

    static string TlsModeLabel(string mode) => mode switch
    {
        "auto" => "Automatic",
        "provided" => "Certificate you supplied",
        _ => "Off",
    };

    // Names the strategy, in words and by its own identifier: the identifier is what the CLI,
    // the log and the documentation all use, so the two together let a user match what they
    // see here against what they read anywhere else.
    static string TlsStrategyLabel(string? strategy) => strategy switch
    {
        "mkcert" => "Your mkcert local CA (mkcert)",
        "windows-self-signed" => "Self-signed by this PC (windows-self-signed)",
        "provided" => "The certificate you supplied (provided)",
        _ => "None",
    };

    static string TlsEnrolmentLabel(string? enrolmentStatus) => enrolmentStatus switch
    {
        "required" => "Devices must install this PC's certificate once, then compare the fingerprint below.",
        "not-required" => "Devices already trust this certificate. There is nothing to install.",
        "unknown" => "You supplied this certificate. If your devices already trust its issuer there is nothing to do; otherwise install your own CA on them.",
        _ => "",
    };

    string TlsExpiryText(TlsReport report) => report.Expiry is not DateTimeOffset expiry
        ? "Unknown"
        : expiry.ToLocalTime().ToString("d MMMM yyyy") +
          // Both facts, never just one: an already-expired certificate reports
          // `needsRenewal: false`, so a reader testing only that would say nothing at all
          // about the certificate that most needs attention.
          (report.Expired ? "  (expired)" : report.NeedsRenewal ? "  (renewal due soon)" : "");

    // Regenerating is offered only where it means something and is allowed. `off` has no
    // certificate to replace; `provided` is the operator's own certificate, which VidVNC
    // never replaces with a generated one. The server refuses both again on its own side,
    // but the point of disabling here is that a user is never invited to press something
    // that can only be rejected.
    static bool TlsRegenerateAllowed(TlsReport report) =>
        report.Mode != "off" && report.Mode != "provided" && report.Strategy != "provided";

    static string TlsRegenerateBlockedReason(TlsReport report) =>
        report.Mode == "off"
            ? "HTTPS is turned off, so there is no certificate to regenerate. Use the tls-mode command to turn it on."
            : "This host uses the certificate you supplied. VidVNC never replaces it — reissue it wherever it came from.";

    void RenderTls()
    {
        var content = new StackPanel { Spacing = HostSpacing.Row };
        content.Children.Add(Label("HTTPS", 16));
        var section = Card(content);
        section.Tag = "tls-section";
        page.Children.Add(section);

        if (tlsReport is not { } report)
        {
            content.Children.Add(Secondary("HTTPS status appears once sharing starts."));
            return;
        }

        content.Children.Add(TlsRow("Mode", TlsModeLabel(report.Mode), "tls-mode"));
        content.Children.Add(TlsRow(
            "Status",
            report.Active ? $"Running on port {report.Port}" : "Not running",
            "tls-active"));

        if (report.Reason is { } reason)
            content.Children.Add(new InfoBar
            {
                IsOpen = true,
                IsClosable = false,
                Tag = "tls-reason",
                // Still serving means the certificate in use is fine and only a re-check
                // failed; nothing serving at all is the state a user needs to act on.
                Severity = report.Active ? InfoBarSeverity.Warning : InfoBarSeverity.Error,
                Title = report.Active ? "The last certificate check failed" : "HTTPS is not running",
                Message = reason,
            });

        if (report.Active)
        {
            content.Children.Add(TlsRow("Certificate from", TlsStrategyLabel(report.Strategy), "tls-strategy"));
            content.Children.Add(TlsRow("Expires", TlsExpiryText(report), "tls-expiry"));
            content.Children.Add(TlsFingerprintRow(report));
            if (TlsEnrolmentLabel(report.EnrolmentStatus) is { Length: > 0 } enrolment)
                content.Children.Add(Secondary(enrolment));
            // `expired || needsRenewal`, never `needsRenewal` alone: the server reports the
            // two as mutually exclusive facts, so testing only the second silently ignores a
            // certificate that has already run out.
            if (report.Expired || report.NeedsRenewal)
                content.Children.Add(new InfoBar
                {
                    IsOpen = true,
                    IsClosable = false,
                    Tag = "tls-renewal",
                    Severity = report.Expired ? InfoBarSeverity.Error : InfoBarSeverity.Warning,
                    Title = report.Expired ? "This certificate has expired" : "This certificate expires soon",
                    Message = report.Expired
                        ? "Devices will refuse or warn about this connection until it is replaced."
                        : "It renews by itself on the next check. Regenerate now only if you would rather not wait.",
                });
        }

        content.Children.Add(DisplaySeparator());

        if (TlsReissueNote(report) is { Length: > 0 } note)
        {
            var noteLabel = Secondary(note);
            noteLabel.Tag = "tls-reissue-note";
            content.Children.Add(noteLabel);
        }

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = HostSpacing.Related };
        var allowed = TlsRegenerateAllowed(report);
        var regenerate = new Button
        {
            Content = tlsRegenerating ? "Regenerating…" : "Regenerate certificate",
            Tag = "tls-regenerate",
            IsEnabled = allowed && server is not null && !tlsRegenerating,
        };
        regenerate.Click += async (_, _) => await RegenerateCertificate();
        actions.Children.Add(regenerate);

        var showQr = new Button
        {
            Content = "Show enrolment QR code",
            Tag = "tls-enrolment-qr",
            IsEnabled = report.Active && EnrolmentUrl() is not null,
        };
        showQr.Click += async (_, _) => await ShowEnrolmentQr();
        actions.Children.Add(showQr);
        content.Children.Add(actions);

        if (!allowed)
        {
            var blocked = Secondary(TlsRegenerateBlockedReason(report));
            blocked.Tag = "tls-regenerate-blocked";
            content.Children.Add(blocked);
        }

        if (tlsError is { } error)
            content.Children.Add(new InfoBar
            {
                IsOpen = true,
                IsClosable = false,
                Tag = "tls-error",
                Severity = InfoBarSeverity.Error,
                Title = "The certificate was not regenerated",
                Message = error,
            });
    }

    // The cost of reissuing, stated where the action is, because it differs by strategy and
    // is the main reason the section names the strategy at all.
    static string TlsReissueNote(TlsReport report) => report.Strategy switch
    {
        "windows-self-signed" =>
            "This PC's certificate is its own trust anchor, so every reissue — including one caused by moving to a new network — means enrolling every device again.",
        "mkcert" =>
            "Your devices trust the mkcert local CA, not this certificate, so reissuing does not require enrolling them again.",
        // No strategy has won: provisioning has not finished yet, or it failed. HTTPS is
        // still configured, so regenerating remains the way out of a failed provision and
        // the action stays live — but the server would reissue from whichever strategy wins
        // next, which may well be the self-signed one whose leaf is its own trust anchor.
        // The consequence cannot be named precisely here, so it is stated conditionally
        // rather than omitted: an enabled regenerate button must never be the only thing on
        // screen. Tied to `TlsRegenerateAllowed` so the note appears exactly when the action
        // does, and stays absent for `off` and for a certificate the operator supplied.
        _ => TlsRegenerateAllowed(report)
            ? "VidVNC has not reported which certificate source is in use. If this PC's certificate turns out to be its own trust anchor, regenerating it means every enrolled device has to trust the new one again."
            : "",
    };

    static Grid TlsRow(string name, string value, string tag)
    {
        var row = new Grid { ColumnSpacing = HostSpacing.Card };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(Secondary(name));
        var text = Label(value);
        text.Tag = tag;
        Grid.SetColumn(text, 1);
        row.Children.Add(text);
        return row;
    }

    // The fingerprint is the only integrity check available before a device trusts anything,
    // so it is shown in full, in a monospaced face, and is copyable rather than something to
    // transcribe by eye.
    static Grid TlsFingerprintRow(TlsReport report)
    {
        var value = report.Fingerprint ?? "Unknown";
        var row = new Grid { ColumnSpacing = HostSpacing.Card };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(Secondary("Fingerprint"));
        var text = Label(value, 12);
        text.Tag = "tls-fingerprint";
        text.FontFamily = new FontFamily("Cascadia Mono");
        Grid.SetColumn(text, 1);
        row.Children.Add(text);
        var copy = CopyButton("Copy certificate fingerprint", () => value);
        copy.VerticalAlignment = VerticalAlignment.Top;
        Grid.SetColumn(copy, 2);
        row.Children.Add(copy);
        return row;
    }

    async Task RegenerateCertificate()
    {
        if (tlsRegenerating) return;
        tlsRegenerating = true;
        tlsError = null;
        if (currentPage == "Settings") RenderPage();
        var reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        tlsReply = reply;
        try
        {
            var child = server ?? throw new InvalidOperationException("Start sharing before regenerating the certificate.");
            await child.StandardInput.WriteLineAsync("{\"type\":\"tls-regenerate\"}");
            await child.StandardInput.FlushAsync();
            // Generous: issuing through Windows certificate tooling or mkcert shells out to
            // a real process, and the server bounds those itself at 30 seconds a step.
            var result = await reply.Task.WaitAsync(TimeSpan.FromSeconds(90));
            if (!result.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
                tlsError = Text(result, "reason", "The server refused to regenerate the certificate.");
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException)
        {
            tlsError = error.Message;
        }
        finally
        {
            tlsRegenerating = false;
            tlsReply = null;
            if (currentPage == "Settings") RenderPage();
        }
    }

    async Task ShowEnrolmentQr()
    {
        if (dialogOpen || EnrolmentUrl() is not { } url) return;
        dialogOpen = true;
        try { await CreateEnrolmentQrDialog(url).ShowAsync(); }
        finally { dialogOpen = false; }
    }

    ContentDialog CreateEnrolmentQrDialog(string url)
    {
        var body = new StackPanel { Spacing = HostSpacing.Row };
        body.Children.Add(Label("Scan this with the device you want to enrol. It opens this PC's enrolment page, which explains what to install for that device."));
        var image = new Image
        {
            Width = 236,
            Height = 236,
            Tag = "tls-qr-image",
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        body.Children.Add(image);
        // Rendering can fail (an image decoder that refuses the stream, a WinRT buffer
        // error). A blank square with no explanation is indistinguishable from one a camera
        // simply cannot read, so the failure is shown and the typed address is left as the
        // way through. ApplyQrSource observes its own faults, so discarding the task here
        // cannot swallow one.
        var qrFailure = Secondary("Could not generate the QR code. Open the address below on the device instead.");
        qrFailure.Tag = "tls-qr-failure";
        qrFailure.Visibility = Visibility.Collapsed;
        body.Children.Add(qrFailure);
        _ = ApplyQrSource(image, url, qrFailure);
        var link = new TextBox { Text = url, IsReadOnly = true, Tag = "tls-enrolment-url" };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(link, "Enrolment address");
        body.Children.Add(link);
        // Deliberately the unencrypted address: a device that does not trust this PC yet
        // cannot open the encrypted one without the very warning enrolment exists to remove.
        body.Children.Add(Secondary("This address is intentionally unencrypted — it is how a device that does not trust this PC yet can reach the page at all. Only the public certificate is served from it."));
        if (tlsReport?.Fingerprint is { } fingerprint)
        {
            var value = Label(fingerprint, 12);
            value.FontFamily = new FontFamily("Cascadia Mono");
            body.Children.Add(Secondary("Check that the page shows this fingerprint before trusting it:"));
            body.Children.Add(value);
        }
        var dialog = new ContentDialog
        {
            Title = "Enrol a device",
            Content = body,
            CloseButtonText = "Done",
            XamlRoot = navigation.XamlRoot,
        };
        dialog.Resources["ContentDialogMaxWidth"] = 560d;
        return dialog;
    }

    // Never throws: its only caller starts it without awaiting, so an escaping exception
    // would be an unobserved fault and the user would be left looking at an empty square.
    internal static async Task ApplyQrSource(Image image, string url, TextBlock? failure = null)
    {
        try
        {
            var bytes = EnrolmentQrPng(url);
            var stream = new InMemoryRandomAccessStream();
            var writer = new DataWriter(stream);
            writer.WriteBytes(bytes);
            await writer.StoreAsync();
            await writer.FlushAsync();
            writer.DetachStream();
            writer.Dispose();
            stream.Seek(0);
            var bitmap = new BitmapImage();
            await bitmap.SetSourceAsync(stream);
            image.Source = bitmap;
        }
        catch (Exception)
        {
            image.Visibility = Visibility.Collapsed;
            if (failure is not null) failure.Visibility = Visibility.Visible;
        }
    }

    // Rendered on this machine, offline. A QR code for a LAN address must never be fetched
    // from a web service: that would hand this PC's private address to a third party and
    // give the host app a reason to reach the Internet that it otherwise does not have.
    internal static byte[] EnrolmentQrPng(string text)
    {
        var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
        using var code = new PngByteQRCode(data);
        return code.GetGraphic(8);
    }
}
