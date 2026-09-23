import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Fixed, read-only command: no setting, CIDR, address, or request data is interpolated.
const DISCOVER = `
$ErrorActionPreference = 'Stop'
$adapters = @(Get-NetAdapter -Physical -IncludeHidden -ErrorAction Stop)
$profiles = @(Get-NetConnectionProfile -ErrorAction Stop)
$addresses = @(Get-NetIPAddress -AddressState Preferred -ErrorAction Stop)
$rows = foreach ($adapter in $adapters) {
  $profile = $profiles | Where-Object { $_.InterfaceIndex -eq $adapter.InterfaceIndex } | Select-Object -First 1
  foreach ($address in ($addresses | Where-Object { $_.InterfaceIndex -eq $adapter.InterfaceIndex })) {
    [pscustomobject]@{
      medium = [int]$adapter.NdisPhysicalMedium
      physical = [bool]$adapter.HardwareInterface
      status = [string]$adapter.Status
      profile = if ($null -eq $profile) { 'Unknown' } else { [string]$profile.NetworkCategory }
      address = [string]$address.IPAddress
      prefixLength = [int]$address.PrefixLength
    }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
`;

export function normalizeWindowsLanRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid Windows LAN metadata');
  return rows.map((row) => ({
    kind: row.medium === 14 ? 'ethernet' : row.medium === 9 ? 'wifi' : 'unknown',
    physical: row.physical === true,
    up: row.status === 'Up',
    profile: row.profile === 'Private' ? 'Private' : 'Public',
    address: row.address,
    prefixLength: row.prefixLength,
  }));
}

export async function detectWindowsLanAdapters() {
  if (process.platform !== 'win32') throw new Error('Windows LAN detection is unavailable');
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', DISCOVER],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout);
  return normalizeWindowsLanRows(parsed);
}
