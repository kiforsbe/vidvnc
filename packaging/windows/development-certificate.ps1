<#
.SYNOPSIS
    Trusts, or stops trusting, the VidVNC self-signed development certificate on this PC.
.DESCRIPTION
    Windows installs the self-signed development MSIX only when its certificate is in
    Local Machine > Trusted People. "install" adds the certificate there and "uninstall"
    removes it. VidVNC packages that are already installed keep working either way.
    Run from PowerShell opened as administrator.
.PARAMETER Action
    install or uninstall.
.PARAMETER Certificate
    The public .cer file. Defaults to VidVNC-Development.cer next to this script (where the
    build puts both, beside the MSIX), otherwise the one "npm run package:prepare" creates.
.EXAMPLE
    .\packaging\windows\development-certificate.ps1 install
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\VidVNC-Development-Certificate.ps1 uninstall
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('install', 'uninstall')]
    [string] $Action,
    [string] $Certificate
)

$ErrorActionPreference = 'Stop'
$store = 'Cert:\LocalMachine\TrustedPeople'

if (-not $Certificate) {
    $Certificate = Join-Path $PSScriptRoot 'VidVNC-Development.cer'
    if (-not (Test-Path -LiteralPath $Certificate)) {
        $Certificate = Join-Path $PSScriptRoot '..\..\.deps\signing\vidvnc-development.cer'
    }
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Changing Local Machine certificates needs administrator rights. Open PowerShell as administrator and run this again.'
}
if (-not (Test-Path -LiteralPath $Certificate -PathType Leaf)) {
    throw "Certificate not found: $Certificate. Run 'npm run package:prepare', or pass -Certificate with the path to VidVNC-Development.cer."
}

$file = Get-PfxCertificate -LiteralPath $Certificate
$name = "$($file.Subject) ($($file.Thumbprint))"
$trusted = @(Get-ChildItem $store | Where-Object Thumbprint -eq $file.Thumbprint)

if ($Action -eq 'install') {
    if ($trusted.Count) {
        Write-Host "Already trusted: $name"
        return
    }
    Import-Certificate -FilePath $Certificate -CertStoreLocation $store | Out-Null
    Write-Host "Trusted $name until $($file.NotAfter.ToString('yyyy-MM-dd')). You can now open the VidVNC .msix to install it."
}
else {
    if (-not $trusted.Count) {
        Write-Host "Not trusted on this PC: $name"
        return
    }
    $trusted | Remove-Item
    Write-Host "Removed $name from Trusted People."
}
