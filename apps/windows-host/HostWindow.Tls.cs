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
        string? Fingerprint, DateTimeOffset? Expiry, bool Expired, bool NeedsRenewal, string? Reason);

    TlsReport? tlsReport;
    // The plaintext address the server reported at startup, kept even after `address` starts
    // showing the HTTPS one: the enrolment page is served unencrypted on purpose (a device
    // that does not trust this PC yet cannot fetch the anchor over a connection that anchor
    // exists to authenticate), so the QR code still needs this.
    string? plaintextAddress;
    bool tlsRegenerating;
    string? tlsError;
    TaskCompletionSource<JsonElement>? tlsReply;

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
            Text(tls, "reason") is { Length: > 0 } reason ? reason : null);
        var changed = tlsReport != next;
        tlsReport = next;
        ApplyTlsAddress();
        if (changed && currentPage == "Settings") RenderPage();
    }

    void ReceiveTlsRegenerateResult(JsonElement value) => tlsReply?.TrySetResult(value.Clone());

    // "The address shown and the QR code encode the HTTPS address once TLS is up" — the
    // address a user is told to open moves to HTTPS the moment the secure listener is really
    // bound, and moves back if it ever stops. `previewUrl` deliberately does not follow: it
    // is the loopback preview this app opens itself, the plaintext listener redirects it, and
    // the loopback-only diagnostics link is derived from it.
    void ApplyTlsAddress()
    {
        if (plaintextAddress is null) return;
        address.Text = SecureAddress() ?? plaintextAddress;
    }

    string? SecureAddress()
    {
        if (tlsReport is not { Active: true, Port: int port }) return null;
        if (!Uri.TryCreate(plaintextAddress, UriKind.Absolute, out var uri)) return null;
        // GetLeftPart(Authority) omits a port that is the scheme's default, matching what a
        // browser shows and what the server's own address formatting does.
        return new UriBuilder(uri) { Scheme = "https", Port = port }.Uri.GetLeftPart(UriPartial.Authority);
    }

    // The enrolment page, always on the plaintext listener (the server leaves that one path
    // unredirected for exactly this reason).
    string? EnrolmentUrl() =>
        Uri.TryCreate(plaintextAddress, UriKind.Absolute, out var uri) ? new Uri(uri, "/trust").AbsoluteUri : null;

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
        _ => "",
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
        _ = ApplyQrSource(image, url);
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

    static async Task ApplyQrSource(Image image, string url)
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
