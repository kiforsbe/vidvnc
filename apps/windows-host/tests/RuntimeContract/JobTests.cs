using System.Diagnostics;
using VidVnc.Host;

static class JobTests
{
    static Process Launch(string mode)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false,
            CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardInput = true };
        start.ArgumentList.Add(mode);
        return Process.Start(start)!;
    }

    public static async Task<bool> RunMode(string[] args)
    {
        if (args.Length == 0) return false;
        if (args[0] == "--sleep") { await Task.Delay(TimeSpan.FromMinutes(1)); return true; }
        if (args[0] == "--child")
        {
            if (Console.ReadLine() != "start") return true;
            using var leaf = Launch("--sleep");
            Console.WriteLine(leaf.Id);
            await Task.Delay(TimeSpan.FromMinutes(1));
            return true;
        }
        if (args[0] == "--owner")
        {
            using var job = new ServerJob();
            using var child = Launch("--child");
            job.Assign(child);
            child.StandardInput.WriteLine("start"); child.StandardInput.Flush();
            Console.WriteLine(child.Id + "," + await child.StandardOutput.ReadLineAsync());
            await Task.Delay(TimeSpan.FromMinutes(1));
            return true;
        }
        throw new Exception("Unknown test mode");
    }

    public static async Task VerifyCleanup()
    {
        using var unrelated = Launch("--sleep");
        using var owner = Launch("--owner");
        Process? child = null, leaf = null;
        try
        {
            var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
            var ids = (line ?? throw new Exception("Owner did not start")).Split(',').Select(int.Parse).ToArray();
            child = Process.GetProcessById(ids[0]); leaf = Process.GetProcessById(ids[1]);
            owner.Kill(); // Deliberately not entireProcessTree: the OS job must do the cleanup.
            await Task.WhenAll(child.WaitForExitAsync(), leaf.WaitForExitAsync()).WaitAsync(TimeSpan.FromSeconds(5));
            if (unrelated.HasExited) throw new Exception("Unrelated process was terminated");
            Console.WriteLine("PASS forced owner exit kills child and grandchild, preserving unrelated process");
        }
        finally
        {
            foreach (var process in new[] { child, leaf, owner, unrelated })
                if (process is not null) { if (!process.HasExited) process.Kill(entireProcessTree: true); process.Dispose(); }
        }
    }
}
