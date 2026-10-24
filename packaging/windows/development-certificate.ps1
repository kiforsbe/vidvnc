# Legacy removal only. New unsigned packages never invoke certificate-store operations.
[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory,Position=0)][ValidateSet('uninstall')][string]$Action,
      [Parameter(Mandatory)][string]$Thumbprint)
$ErrorActionPreference = 'Stop'
$reviewed = ($Thumbprint -replace '[\s:]', '').ToUpperInvariant()
if ($reviewed -notmatch '^[0-9A-F]{40}$') { throw 'Supply the reviewed legacy thumbprint (40 hexadecimal characters).' }
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Open PowerShell as administrator to remove legacy Local Machine trust.' }
$certificate = Get-Item -LiteralPath "Cert:\LocalMachine\TrustedPeople\$reviewed" -ErrorAction SilentlyContinue
if (!$certificate) { Write-Host "Not trusted: $reviewed"; return }
if ($certificate.Subject -ne 'CN=VidVNC Development') { throw 'This is not a legacy VidVNC development certificate.' }
if ($PSCmdlet.ShouldProcess("$($certificate.Subject) ($reviewed)", 'Remove legacy TrustedPeople certificate')) {
    Remove-Item -LiteralPath "Cert:\LocalMachine\TrustedPeople\$reviewed"
}
