# Regenerates the screenshots of the Windows host in docs\images\windows-host: starts the
# development build, waits for it to finish starting, then opens every page and Connect a
# device's QR code through UI Automation and saves the whole window (without the invisible
# resize border) as a PNG for each, once with Settings > Appearance on Light and once on Dark
# (name-light.png, name-dark.png), then closes it. That Appearance choice isn't saved.
#   npm run screenshot:host
#   powershell -ExecutionPolicy Bypass -File tools\screenshot-host.ps1 [-Seconds 8] [-OutDir path] [-Themes Light,Dark]
# Build the host first with npm run prepare:host. The images are in physical pixels, so their
# size follows the display scale. They show this PC's name and addresses; the QR code holds a
# key that stops working when the host closes.
param(
  [int]$Seconds = 8,
  [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot) 'docs\images\windows-host'),
  [ValidateSet('Light', 'Dark')][string[]]$Themes = @('Light', 'Dark'),
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

Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VidVncScreenshot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@
# Per-monitor DPI aware, so window sizes are physical pixels.
[void][VidVncScreenshot]::SetProcessDpiAwarenessContext([IntPtr](-4))

# The pages in the order the navigation lists them, and the file each is saved to.
$pages = [ordered]@{
  'Overview' = 'overview'
  'Displays' = 'displays'
  'Streaming profiles' = 'streaming-profiles'
  'Sessions' = 'sessions'
  'Clients' = 'clients'
  'Access' = 'access'
  'Settings' = 'settings'
}

function Save-Window([IntPtr]$window, [string]$path) {
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
  if (-not $printed) { throw "Capturing the host window for $path failed." }

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
  $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $image.Dispose()
  "Saved ${width}x${height} $path"
}

# The first element under $root with this control type and name, waiting up to $timeout
# seconds for it (and, with -Enabled, for it to be enabled).
function Find-Element($root, [System.Windows.Automation.ControlType]$type, [string]$name, [int]$timeout = 15, [switch]$Enabled) {
  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)))
  $deadline = (Get-Date).AddSeconds($timeout)
  while ($true) {
    $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($element -and (-not $Enabled -or $element.Current.IsEnabled)) { return $element }
    if ((Get-Date) -gt $deadline) {
      $state = if ($element) { 'is not enabled' } else { 'was not found' }
      throw "'$name' $state within $timeout seconds."
    }
    Start-Sleep -Milliseconds 250
  }
}

function Invoke-Element($element) {
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    $pattern.Select()
  } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
  } else {
    throw "'$($element.Current.Name)' can't be selected or invoked."
  }
}

# Picks Light or Dark in Settings > Appearance.
function Set-Theme($root, [string]$theme) {
  Invoke-Element (Find-Element $root $listItem 'Settings')
  $combo = Find-Element $root ([System.Windows.Automation.ControlType]::ComboBox) 'Appearance'
  $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Invoke-Element (Find-Element $combo $listItem $theme)
  $pattern = $null
  if ($combo.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern) -and
      $pattern.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
    $pattern.Collapse()
  }
  Start-Sleep -Milliseconds 800
}

$button = [System.Windows.Automation.ControlType]::Button
$listItem = [System.Windows.Automation.ControlType]::ListItem
New-Item -ItemType Directory -Force $OutDir | Out-Null

# Closing the window would otherwise leave the host running in the notification area.
$env:VIDVNC_HOST_QUIT_ON_CLOSE = '1'
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
  # In front, so the window draws as active.
  [void][VidVncScreenshot]::SetForegroundWindow($window)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)

  foreach ($theme in $Themes) {
    Set-Theme $root $theme
    $suffix = $theme.ToLowerInvariant()
    foreach ($page in $pages.GetEnumerator()) {
      Invoke-Element (Find-Element $root $listItem $page.Key)
      Start-Sleep -Milliseconds 1200
      Save-Window $window (Join-Path $OutDir "$($page.Value)-$suffix.png")
    }

    # Connect a device from Overview: the session password's QR code when there is one,
    # otherwise a new one-time or client-registration code, which goes straight to its QR code.
    Invoke-Element (Find-Element $root $listItem 'Overview')
    Start-Sleep -Milliseconds 800
    Invoke-Element (Find-Element $root $button 'Connect a device' -Enabled)
    $showQr = Find-Element $root $button 'Show QR code'
    if ($showQr.Current.IsEnabled) {
      Invoke-Element $showQr
    } else {
      $generate = @('Generate one-time code', 'Generate client-registration code') |
        ForEach-Object { try { Find-Element $root $button $_ -timeout 1 } catch { $null } } |
        Where-Object { $_ } | Select-Object -First 1
      if (-not $generate) { throw 'Connect a device offers no QR code and no code to generate.' }
      Invoke-Element $generate
    }
    [void](Find-Element $root $button 'Back')
    # The QR code image is drawn asynchronously.
    Start-Sleep -Milliseconds 1500
    Save-Window $window (Join-Path $OutDir "connect-device-qr-$suffix.png")
    Invoke-Element (Find-Element $root $button 'Done')
    Start-Sleep -Milliseconds 500
  }
} finally {
  if (-not $process.HasExited) {
    [void]$process.CloseMainWindow()
    if (-not $process.WaitForExit(15000)) {
      Stop-Process -Id $process.Id -Force
      Write-Warning 'The host did not close within 15 seconds and was stopped.'
    }
  }
}
