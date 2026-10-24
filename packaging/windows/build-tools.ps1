#requires -Version 7.4
# Product adapter: no signing, certificate-store operations or dependency downloads.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Request, [Parameter(Mandatory)][string]$Response)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$tools = Join-Path $root 'external/winbuildtools'
foreach ($file in @('VERSION','common/Tools.ps1','common/Artifacts.ps1','msi/package.ps1','msix/package.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $tools $file) -PathType Leaf)) {
        throw 'winbuildtools checkout is missing or incomplete. Run: git submodule update --init --recursive'
    }
}
. (Join-Path $tools 'common/Tools.ps1')
. (Join-Path $tools 'common/Artifacts.ps1')
$data = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json -AsHashtable
$result = switch ($data.operation) {
    'preflight' {
        if ($data.format -eq 'msix') { $null = Get-WbtSdkTool makeappx.exe }
        @{ Version = (Get-Content -LiteralPath (Join-Path $tools 'VERSION') -Raw).Trim() }
    }
    'run' {
        Invoke-WbtTool -Tool $data.tool -Arguments $data.arguments -LogPath $data.log
        @{ Success = $true }
    }
    'msi' {
        & (Join-Path $tools 'msi/package.ps1') -Config $data.config -PayloadDirectory $data.payload -Version $data.version -Architecture x64 -OutputDirectory $data.output
    }
    'msix' {
        & (Join-Path $tools 'msix/package.ps1') -PayloadDirectory $data.payload -Manifest $data.manifest -OutputDirectory $data.output
    }
    'inspect-msix' {
        & (Join-Path $tools 'msix/inspect.ps1') -Artifact $data.artifact -PayloadDirectory $data.payload -Manifest $data.manifest -OutputDirectory $data.output
    }
    'metadata' {
        $commit = (& git -C $root rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot determine source commit.' }
        $state = @(& git -C $root status --porcelain --untracked-files=normal --ignore-submodules=none)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot determine source cleanliness.' }
        Write-WbtArtifactManifest -Artifact $data.artifact -OutputPath $data.output -Version $data.version -SourceCommit $commit -SourceDirty:($state.Count -gt 0)
    }
    default { throw "Unknown build-tools operation: $($data.operation)" }
}
$json = $result | ConvertTo-Json -Depth 10
$stream = [IO.File]::Open($Response, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json); $stream.Write($bytes) }
finally { $stream.Dispose() }
