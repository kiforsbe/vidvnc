#requires -Version 7.4
# Read-only consumer assertions against the actual produced MSI. Never installs or elevates.
[CmdletBinding()]
param([string]$Artifact, [string]$PreviousArtifact)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$version = (Get-Content -LiteralPath (Join-Path $root 'apps/server/package.json') -Raw | ConvertFrom-Json).version
if (!$Artifact) { $Artifact = Join-Path $root "out/installers/windows-server/$version/VidVNC-$version-windows-x64-unsigned.msi" }
$engine = Join-Path $root 'external/winbuildtools/msi'
foreach ($name in @('Configuration','Identity','Branding','Payload','Database','Registration','Maintenance','Scope','Presentation','Wizard','Semantics','Inspection')) { . (Join-Path $engine "$name.ps1") }
$snapshot = Read-MsiPackage ([IO.Path]::GetFullPath($Artifact))
$ui = Read-MsiMaintenanceUi ([IO.Path]::GetFullPath($Artifact))
$template = Get-Content -LiteralPath (Join-Path $root 'packaging/windows/msi.json') -Raw | ConvertFrom-Json
$namespace = [guid]$template.identityNamespace
function Check([bool]$Value, [string]$Message) { if (!$Value) { throw $Message }; Write-Host "PASS $Message" }
Check ($snapshot.Properties.ALLUSERS -ceq '2' -and $snapshot.Properties.MSIINSTALLPERUSER -ceq '1' -and $snapshot.Properties.WBTINSTALLSCOPE -ceq 'user') 'one package offers scope choice with per-user default'
Check ($snapshot.WordCount -eq 10) 'package permits least-privilege per-user installation'
Check (@($ui.Dialogs | Where-Object Dialog -ceq WbtScope).Count -eq 1) 'native scope dialog exists'
foreach ($scope in @('user','machine')) {
    Check (@($ui.RadioButtons | Where-Object { $_.Property -ceq 'WBTINSTALLSCOPE' -and $_.Value -ceq $scope }).Count -eq 1) "native radio option: $scope"
}
foreach ($selection in @(@('[ALLUSERS]','2',1), @('[MSIINSTALLPERUSER]','1',2), @('[MSIINSTALLPERUSER]','{}',3))) {
    Check (@($ui.Events | Where-Object { $_.Dialog_ -ceq 'WbtScope' -and $_.Control_ -ceq 'Continue' -and $_.Event -ceq $selection[0] -and $_.Argument -ceq $selection[1] -and [int]$_.Ordering -eq $selection[2] }).Count -eq 1) "scope event: $($selection[0])=$($selection[1])"
}
Check ($snapshot.Properties.MSIRESTARTMANAGERCONTROL -ceq '0') 'graceful servicing retained'
Check ($snapshot.Properties.UpgradeCode -ceq (Get-MsiGuid $namespace 'x64/upgrade')) 'legacy upgrade identity retained'
Check ($snapshot.Properties.ProductCode -ceq (Get-MsiGuid $namespace "x64/product/$version")) 'legacy versioned product identity retained'
Check ((@($snapshot.Directories | Where-Object Directory -ceq INSTALLFOLDER)[0].DefaultDir -split '\|')[-1] -ceq 'VidVNC') 'installation folder has no architecture suffix'
Check ((@($snapshot.Directories | Where-Object Directory -ceq APPMENUDIR)[0].DefaultDir -split '\|')[-1] -ceq 'VidVNC') 'Start-menu folder has no architecture suffix'
Check (@($ui.Dialogs | Where-Object Dialog -ceq WbtInstallDetails).Count -eq 0) 'installation Details is disabled'
Check (@($ui.Controls | Where-Object { $_.Control -ceq 'Details' -and $_.Type -ceq 'PushButton' }).Count -eq 0) 'Details buttons are absent'
Check (@($ui.Controls | Where-Object { $_.Type -in @('Edit','PathEdit') -and $_.Property -in @('WBTINSTALLPATH','INSTALLFOLDER') }).Count -eq 0) 'destination remains read-only'
Check (@($ui.Dialogs | Where-Object Dialog -ceq WbtOptions).Count -eq 0) 'fixed destination does not add a redundant Options page'
Check (@($ui.Events | Where-Object { $_.Dialog_ -ceq 'WbtScope' -and $_.Control_ -ceq 'Continue' -and $_.Event -ceq 'NewDialog' -and $_.Argument -ceq 'WbtReady' }).Count -eq 1) 'scope proceeds to one final Install review'
$progress = @($ui.InstallUi | Where-Object Action -ceq WbtProgress)
Check ($progress.Count -eq 1 -and [int]$progress[0].Sequence -gt 5 -and [int]$progress[0].Sequence -lt 25) 'progress starts immediately after consent before discovery and costing'
foreach ($name in @('WbtMaintenance','WbtRemove','WbtRepair','WbtUpgrade','WbtCancelConfirm',$snapshot.Properties.ErrorDialog)) {
    $dialog = @($ui.Dialogs | Where-Object Dialog -ceq $name)
    Check ($dialog.Count -eq 1 -and ([int]$dialog[0].Attributes -band 16) -eq 16) "later prompt retains modeless progress: $name"
}
Check (@($ui.Events | Where-Object { $_.Dialog_ -ceq 'WbtReady' -and $_.Control_ -ceq 'Next' -and $_.Event -ceq 'EndDialog' -and $_.Argument -ceq 'Return' }).Count -eq 1) 'installation retains an explicit final Install action'
Check (@($ui.Controls | Where-Object { $_.Control -ceq 'HeaderLogo' -and $_.Type -ceq 'Icon' -and $_.Text -ceq 'WbtUiLogo' }).Count -gt 0) 'native header uses the app logo'
$iconPath = Join-Path $root 'apps/windows-host/Assets/VidVnc.ico'
$iconBytes = Get-MsiBrandingBytes $iconPath
Check ($iconBytes[6] -eq 0 -and $iconBytes[7] -eq 0) 'wizard selects the canonical 256-pixel logo frame'
$iconHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($iconBytes))
Check ((Get-MsiBrandingHash ([IO.Path]::GetFullPath($Artifact)) WbtUiLogo) -ceq $iconHash) 'embedded high-resolution logo matches approved derived bytes'
foreach ($operation in @('Installed','Updated','Repaired','Removed')) {
    Check (@($ui.Controls | Where-Object { $_.Dialog_ -ceq 'WbtExit' -and $_.Control -ceq "Heading$operation" }).Count -eq 1) "operation-specific completion: $operation"
}
$launch = @($ui.Events | Where-Object Event -ceq MsiLaunchApp)
$hostFile = Get-MsiId F ([guid]$snapshot.Properties.UpgradeCode) 'x64/VidVnc.Host.exe'
Check ($launch.Count -eq 1 -and $launch[0].Argument -ceq ('[#' + $hostFile + ']')) 'launch uses the native unquoted installed-host File key'
Check ($snapshot.Properties.WBTLAUNCHAPP -ceq '1') 'Launch VidVNC is initially checked'
foreach ($condition in @('UILevel = 5','WBTLAUNCHAPP = 1','NOT Installed','NOT REMOVE','NOT REINSTALL','NOT ReplacedInUseFiles')) {
    Check ($launch[0].Condition.Contains($condition)) "launch condition: $condition"
}
# Evaluate only in-memory conditions on an isolated, unregistered copy. No action,
# installer navigation or application launch occurs during this regression check.
$stateRoot = Join-Path $root 'out/packaging/windows'
$fixture = Join-Path $stateRoot ('wizard-state-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$stateMsi = Join-Path $fixture 'conditions.msi'
$installer=$null; $session=$null; $database=$null; $previousUi=$null
try {
    New-MsiPreflightCopy ([IO.Path]::GetFullPath($Artifact)) $stateMsi
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase([IO.Path]::GetFullPath($Artifact),0)
    $conditions = @(Get-MsiRows $database ControlCondition @('Dialog_','Control_','Action','Condition'))
    Close-MsiCom $database; $database=$null
    $previousUi = $installer.UILevel; $installer.UILevel=2
    $session = $installer.OpenPackage($stateMsi,0)
    foreach ($property in @('Installed','REMOVE','REINSTALL','ReplacedInUseFiles')) { $session.Property($property)='' }
    $session.Property('UILevel')='5'; $session.Property('WBTLAUNCHAPP')='1'
    $session.Property('MsiSystemRebootPending')='1'
    Check ($session.EvaluateCondition($launch[0].Condition) -eq 1) 'unrelated machine pending reboot does not block Run'
    $session.Property('WBTLAUNCHAPP')=''
    Check ($session.EvaluateCondition($launch[0].Condition) -eq 0) 'clearing Launch VidVNC prevents launch'
    $session.Property('WBTLAUNCHAPP')='1'
    foreach ($expected in @(@('Launch',1),@('MessageInstalled',1),@('Restart',0))) {
        $show = @($conditions | Where-Object { $_.Dialog_ -ceq 'WbtExit' -and $_.Control_ -ceq $expected[0] -and $_.Action -ceq 'Show' })
        Check ($show.Count -eq 1 -and $session.EvaluateCondition($show[0].Condition) -eq $expected[1]) "machine pending reboot: visibility $($expected[0])=$($expected[1])"
    }
    $session.Property('ReplacedInUseFiles')='1'
    Check ($session.EvaluateCondition($launch[0].Condition) -eq 0) 'a real in-use replacement still blocks launch'
    foreach ($expected in @(@('Launch',0),@('MessageInstalled',0),@('Restart',1))) {
        $show = @($conditions | Where-Object { $_.Dialog_ -ceq 'WbtExit' -and $_.Control_ -ceq $expected[0] -and $_.Action -ceq 'Show' })
        Check ($show.Count -eq 1 -and $session.EvaluateCondition($show[0].Condition) -eq $expected[1]) "transaction restart: visibility $($expected[0])=$($expected[1])"
    }
} finally {
    Close-MsiCom $database; Close-MsiCom $session
    if ($installer -and $null -ne $previousUi) { $installer.UILevel=$previousUi }
    Close-MsiCom $installer
    # Retain the synthetic copy in ignored out/ with the other diagnostic inputs.
}
Check (@($ui.Controls | Where-Object { $_.Dialog_ -ceq 'WbtWelcome' -and $_.Text -like '*Close the application before continuing*' }).Count -eq 0) 'welcome does not claim the app is running'
Check (@($ui.Controls | Where-Object Type -ceq Hyperlink).Count -eq 0) 'external completion links remain disabled'
Check (@($ui.Dialogs | Where-Object Dialog -ceq WbtBrowse).Count -eq 0) 'custom destination browsing remains disabled'

function ComponentMap($Info) {
    $directories = @{}; foreach ($directory in $Info.Directories) { $directories[$directory.Directory] = $directory }
    $components = @{}; foreach ($component in $Info.Components) { $components[$component.Component] = $component }
    $result = @{}
    foreach ($file in $Info.Files) {
        $component = $components[$file.Component_]
        $parts = [Collections.Generic.List[string]]::new()
        $parts.Add(($file.FileName -split '\|')[-1])
        $directory = $component.Directory_
        $visited = @{}
        while ($directory -cne 'INSTALLFOLDER') {
            if (!$directory -or !$directories.ContainsKey($directory) -or $visited.ContainsKey($directory)) { throw 'Unexpected MSI directory chain' }
            $visited[$directory] = $true
            $parts.Insert(0, ($directories[$directory].DefaultDir -split '\|')[-1])
            $directory = $directories[$directory].Directory_Parent
        }
        $result[($parts -join '/')] = $component.ComponentId
    }
    return $result
}
$map = ComponentMap $snapshot
foreach ($path in $map.Keys) {
    if ($map[$path] -cne (Get-MsiGuid $namespace "x64/component/$path")) { throw "Changed component identity: $path" }
}
Write-Host "PASS all $($map.Count) component identities match the independent legacy algorithm"
if ($PreviousArtifact) {
    $previous = Read-MsiPackage ([IO.Path]::GetFullPath($PreviousArtifact))
    Check ($snapshot.Properties.UpgradeCode -ceq $previous.Properties.UpgradeCode) 'upgrade family matches previous actual MSI'
    $oldMap = ComponentMap $previous
    foreach ($path in $oldMap.Keys) {
        if ($map.ContainsKey($path) -and $map[$path] -cne $oldMap[$path]) { throw "Changed existing component: $path" }
    }
    Write-Host 'PASS surviving components match previous actual MSI'
}
Write-Host 'VidVNC MSI scope/identity checks passed without installation.'
