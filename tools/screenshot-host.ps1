# Regenerates the README screenshot of the Windows host: starts the development build,
# waits for it to finish starting, saves its window (without the invisible resize border)
# as a PNG, then closes it.
#   npm run screenshot:host
#   powershell -ExecutionPolicy Bypass -File tools\screenshot-host.ps1 [-Seconds 8] [-Out path.png]
# Build the host first with npm run prepare:host. The image is in physical pixels, so its size
# follows the display scale. It shows this PC's name.
param(
  [int]$Seconds = 8,
  [string]$Out = (Join-Path (Split-Path $PSScriptRoot) 'docs\images\windows-host-overview.png'),
  [string]$Executable = (Join-Path (Split-Path $PSScriptRoot) 'apps\windows-host\bin\Debug\net10.0-windows10.0.26100.0\win-x64\VidVnc.Host.exe')
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Executable)) {
  throw "No host build at $Executable. Run npm run prepare:host first."
}
if (Get-Process -Name VidVnc.Host -ErrorAction SilentlyContinue) {
  throw 'VidVNC is already running. Close it first.'
}
$port = if ($env:VIDVNC_PORT) { [int]$env:VIDVNC_PORT } else { 4382 }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $port is in use. Stop the VidVNC server using it first."
}

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VidVncScreenshot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr hdc, uint flags);
}
'@
# Per-monitor DPI aware, so window sizes are physical pixels.
[void][VidVncScreenshot]::SetProcessDpiAwarenessContext([IntPtr](-4))

$process = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path $Executable) -PassThru
try {
  $deadline = (Get-Date).AddSeconds(30)
  while ($true) {
    $process.Refresh()
    if ($process.HasExited) { throw "The host exited with code $($process.ExitCode)." }
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
    if ((Get-Date) -gt $deadline) { throw 'The host window did not appear within 30 seconds.' }
    Start-Sleep -Milliseconds 250
  }
  # Let it start sharing and fill in displays before capturing.
  Start-Sleep -Seconds $Seconds
  $window = $process.MainWindowHandle

  $outer = New-Object VidVncScreenshot+RECT
  [void][VidVncScreenshot]::GetWindowRect($window, [ref]$outer)
  $visible = New-Object VidVncScreenshot+RECT
  # DWMWA_EXTENDED_FRAME_BOUNDS: the window without its invisible resize border.
  if ([VidVncScreenshot]::DwmGetWindowAttribute($window, 9, [ref]$visible, 16) -ne 0) { $visible = $outer }

  $full = New-Object System.Drawing.Bitmap ($outer.Right - $outer.Left), ($outer.Bottom - $outer.Top)
  $graphics = [System.Drawing.Graphics]::FromImage($full)
  $hdc = $graphics.GetHdc()
  # PW_RENDERFULLCONTENT captures WinUI's composition content even when covered.
  $printed = [VidVncScreenshot]::PrintWindow($window, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
  if (-not $printed) { throw 'Capturing the host window failed.' }

  $width = $visible.Right - $visible.Left
  $height = $visible.Bottom - $visible.Top
  $image = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($image)
  $graphics.DrawImage(
    $full,
    (New-Object System.Drawing.Rectangle 0, 0, $width, $height),
    ($visible.Left - $outer.Left), ($visible.Top - $outer.Top), $width, $height,
    [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose()
  $full.Dispose()
  New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
  $image.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $image.Dispose()
  "Saved ${width}x${height} screenshot to $Out"
} finally {
  if (-not $process.HasExited) {
    [void]$process.CloseMainWindow()
    if (-not $process.WaitForExit(15000)) {
      Stop-Process -Id $process.Id -Force
      Write-Warning 'The host did not close within 15 seconds and was stopped.'
    }
  }
}
