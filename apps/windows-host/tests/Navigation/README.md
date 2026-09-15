# Native navigation regression

This WinUI integration executable compiles the real host window and exercises
navigation between all five pages, including session arrival, expansion and
removal. It uses an absent runtime manifest so it never starts a media server.
It also verifies title-bar integration and shared light/dark/system themes.
Interactive dragging, caption-button hit testing and Snap Layouts remain manual checks.
Run on an interactive Windows desktop with the host development prerequisites.

From the repository root:

```powershell
dotnet build apps/windows-host/tests/Navigation/Navigation.csproj -c Debug
$testExe = (Resolve-Path 'apps/windows-host/tests/Navigation/bin/Debug/net10.0-windows10.0.26100.0/win-x64/Navigation.exe').Path
$testProcess = Start-Process -FilePath $testExe -WindowStyle Hidden -PassThru
if (-not $testProcess.WaitForExit(20000)) {
    Stop-Process -Id $testProcess.Id
    throw 'Navigation test timed out'
}
Get-Content (Join-Path (Split-Path $testExe) 'navigation-result.log')
if ($testProcess.ExitCode -ne 0) { throw 'Navigation regression failed' }
```

The regression originally failed with COM error `0x800F1000` while attaching
the shared summary to Sessions. Clearing the page before finding each control's
parent did not release ownership by its detached Overview card. The fix releases
the known card and scroll owners explicitly before clearing the page.
