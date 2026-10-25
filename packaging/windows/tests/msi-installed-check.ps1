#requires -Version 7.4

<#
.SYNOPSIS
Read-only acceptance check for the installed MSI's Start-menu Uninstall entry.
.DESCRIPTION
Does not install, repair, launch or remove anything. Run after an authorized install.
UninstallLabel is the localized Windows context-menu label, without accelerator marks.
#>
param(
    [string]$Artifact,
    [string]$UninstallLabel = 'Uninstall'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (!$Artifact) {
    $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $Artifact = Join-Path $root "out/installers/windows-server/$version/VidVNC-$version-windows-x64-unsigned.msi"
}
. (Join-Path $root 'external/winbuildtools/msi/Database.ps1')
# MS-SHLLINK: skip the optional IDList, LinkInfo and StringData, then read the
# bounded DarwinDataBlock. Reading bytes never resolves or repairs the link.
# https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/48f8a4c4-99fe-4787-a39f-b1367103eba8
function Get-DarwinDescriptor([string]$Path) {
    $bytes=[IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 76 -or [BitConverter]::ToUInt32($bytes,0) -ne 76) { throw 'Invalid Shell link header.' }
    $flags=[BitConverter]::ToUInt32($bytes,20); $offset=76
    if ($flags -band 1) {
        if ($offset+2 -gt $bytes.Length) { throw 'Truncated Shell IDList.' }
        $offset+=2+[BitConverter]::ToUInt16($bytes,$offset)
    }
    if ($flags -band 2) {
        if ($offset+4 -gt $bytes.Length) { throw 'Truncated Shell LinkInfo.' }
        $size=[BitConverter]::ToUInt32($bytes,$offset)
        if ($size -lt 4 -or $size -gt $bytes.Length-$offset) { throw 'Invalid Shell LinkInfo size.' }
        $offset+=$size
    }
    foreach ($flag in @(4,8,16,32,64)) {
        if ($flags -band $flag) {
            if ($offset+2 -gt $bytes.Length) { throw 'Truncated Shell StringData.' }
            $count=[BitConverter]::ToUInt16($bytes,$offset)
            $offset+=2+$count*$(if ($flags -band 128) { 2 } else { 1 })
        }
    }
    while ($offset+4 -le $bytes.Length) {
        $size=[BitConverter]::ToUInt32($bytes,$offset)
        if ($size -lt 4) { return $null }
        if ($size -lt 8 -or $size -gt $bytes.Length-$offset) { throw 'Invalid Shell ExtraData size.' }
        if ([BitConverter]::ToUInt32($bytes,$offset+4) -eq 0xA0000006u) {
            if ($size -ne 788) { throw 'Invalid DarwinDataBlock size.' }
            $descriptor=[Text.Encoding]::Unicode.GetString($bytes,$offset+268,520).Split([char]0)[0]
            if (!$descriptor) { $descriptor=[Text.Encoding]::ASCII.GetString($bytes,$offset+8,260).Split([char]0)[0] }
            return $descriptor
        }
        $offset+=$size
    }
    throw 'Truncated Shell ExtraData.'
}
$installer=$null; $database=$null; $shell=$null; $apps=$null; $items=$null; $app=$null
try {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase([IO.Path]::GetFullPath($Artifact),0)
    $properties = @{}
    foreach ($row in Get-MsiRows $database Property @('Property','Value')) { $properties[$row.Property]=$row.Value }
    $product = $properties.ProductCode
    $cached = $installer.ProductInfo($product,'LocalPackage')
    if (!$cached -or !(Test-Path -LiteralPath $cached -PathType Leaf)) { throw 'The specified MSI product is not installed for this user.' }
    # Require the exact package, not a same-version installation of a previous build.
    $summary=$null
    try { $summary=$database.SummaryInformation(0); $packageCode=$summary.Property(9) }
    finally { Close-MsiCom $summary }
    if ($installer.ProductInfo($product,'PackageCode') -cne $packageCode) { throw 'The installed package differs from the MSI under test.' }
    Write-Host 'PASS exact MSI package is installed'

    $shortcuts = @(Get-MsiRows $database Shortcut @('Shortcut','Component_','Name'))
    if ($shortcuts.Count -ne 1) { throw 'Expected the single VidVNC application shortcut.' }
    $components = @(Get-MsiRows $database Component @('Component','ComponentId') |
        Where-Object Component -CEQ $shortcuts[0].Component_)
    if ($components.Count -ne 1) { throw 'The application shortcut component is missing.' }
    $executable = $installer.ComponentPath($product,$components[0].ComponentId)
    if (!$executable -or !(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'The registered shortcut target is missing.' }
    $identifiers=[Collections.Generic.List[string]]::new()
    $expectedIds=@(Get-MsiRows $database MsiShortcutProperty @('Shortcut_','PropertyKey','PropVariantValue') |
        Where-Object { $_.Shortcut_ -ceq $shortcuts[0].Shortcut -and $_.PropertyKey -ceq 'System.AppUserModel.ID' })
    $shell = New-Object -ComObject Shell.Application
    $shortcutName=($shortcuts[0].Name -split '\|')[-1]+'.lnk'
    foreach ($start in @([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'))) {
        foreach ($link in Get-ChildItem -LiteralPath $start -Filter $shortcutName -File -Recurse) {
            $target=$null
            try {
                $target=$installer.ShortcutTarget($link.FullName)
                if ($target.StringData(1) -ieq $product -and $target.StringData(3) -ieq $components[0].ComponentId) {
                    $descriptor=Get-DarwinDescriptor $link.FullName
                    if ($descriptor) { $identifiers.Add($descriptor) }
                    if ($expectedIds.Count -eq 1) {
                        $folder=$null; $linkItem=$null
                        try {
                            $folder=$shell.Namespace($link.DirectoryName); $linkItem=$folder.ParseName($link.Name)
                            $appId=$linkItem.ExtendedProperty('System.AppUserModel.ID')
                            if ($appId -cne $expectedIds[0].PropVariantValue) { throw 'Installed app identity differs from the MSI.' }
                            $identifiers.Add($appId)
                        } finally { Close-MsiCom $linkItem; Close-MsiCom $folder }
                    }
                }
            } finally { Close-MsiCom $target }
        }
    }

    $apps = $shell.Namespace('shell:AppsFolder'); $items=$apps.Items()
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($item in $items) {
        # Match the registered installed target as well as its name. An unrelated
        # MSIX or retained shortcut with the same display name must never pass.
        if ($item.Name -ceq $properties.ProductName -and ($item.Path -ieq $executable -or $item.Path -cin $identifiers)) { $matches.Add($item) }
        else { Close-MsiCom $item }
    }
    if ($matches.Count -ne 1) {
        foreach ($item in $matches) { Close-MsiCom $item }
        throw 'Expected exactly one Windows app catalog entry for the registered MSI shortcut.'
    }
    $app=$matches[0]
    $verbs=$null; $names=[Collections.Generic.List[string]]::new()
    try {
        $verbs=$app.Verbs()
        foreach ($verb in $verbs) {
            try { $names.Add($verb.Name.Replace('&','').Trim()) }
            finally { Close-MsiCom $verb }
        }
    } finally { Close-MsiCom $verbs }
    if ($UninstallLabel -notin $names) { throw 'Windows app catalog does not expose Uninstall for VidVNC.' }
    Write-Host 'PASS Windows app catalog exposes Uninstall for VidVNC'
    Write-Host 'Read-only Start-menu check passed; Finish launch and elevation still need interactive acceptance.'
} finally {
    Close-MsiCom $app; Close-MsiCom $items; Close-MsiCom $apps; Close-MsiCom $shell
    Close-MsiCom $database; Close-MsiCom $installer
}
