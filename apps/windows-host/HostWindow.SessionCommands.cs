using System.Text.Json;
using Microsoft.UI.Xaml.Controls;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    readonly Dictionary<string, TaskCompletionSource<JsonElement>> sessionReplies = new();
    readonly SemaphoreSlim sessionCommandGate = new(1, 1);

    async Task SendSessionCommand(string action, string sessionId, string? streamId)
    {
        if (!await sessionCommandGate.WaitAsync(0)) return;
        var requestId = Guid.NewGuid().ToString();
        try
        {
            var child = server ?? throw new InvalidOperationException("Sharing is not running.");
            var reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            sessionReplies.Add(requestId, reply);
            await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { type = "session-command", requestId, action, sessionId, streamId }));
            await child.StandardInput.FlushAsync();
            var result = await reply.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (!result.GetProperty("ok").GetBoolean())
                throw new InvalidOperationException(result.GetProperty("error").GetString() ?? "Session action failed.");
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException)
        {
            page.Children.Add(new InfoBar { IsOpen = true, Severity = InfoBarSeverity.Error, Message = error.Message });
        }
        finally { sessionReplies.Remove(requestId); sessionCommandGate.Release(); }
    }

    void ReceiveSessionResult(JsonElement message)
    {
        if (message.TryGetProperty("requestId", out var id) && id.GetString() is { } key && sessionReplies.TryGetValue(key, out var reply))
            reply.TrySetResult(message.Clone());
    }
}
