// Explicit preparation step; building never downloads or creates credentials itself.
// - Downloads pinned runtime installers and the optional Node.js bundle into .deps/downloads
//   and verifies their SHA-256.
// - Creates the self-signed MSIX development certificate if it is missing. Its key lives in
//   your own certificate store (Cert:\CurrentUser\My, exportable so you can back it up);
//   only the public .cer is written to .deps/signing. A passwordless .pfx left there by an
//   earlier version is moved into the store and deleted.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const inputs = JSON.parse(readFileSync(path.join(root, 'packaging/windows/inputs.json'), 'utf8'));
const downloads = path.join(root, '.deps/downloads');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function writeAtomically(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}

mkdirSync(downloads, { recursive: true });
for (const [id, prerequisite] of Object.entries(inputs.prerequisites)) {
  // NuGet-sourced installers arrive with the host restore and are verified at build time.
  for (const item of [prerequisite.installer, prerequisite.bundle].filter((entry) => entry?.url)) {
    const filename = path.join(downloads, item.file);
    if (existsSync(filename) && sha256(readFileSync(filename)) === item.sha256) {
      console.log(`${id}: ${item.file} already verified`);
      continue;
    }
    const response = await fetch(item.url);
    if (!response.ok)
      throw new Error(`${id}: download failed (${response.status}) from ${item.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== item.sha256)
      throw new Error(
        `${id}: SHA-256 mismatch for ${item.url}: expected ${item.sha256}, got ${actual}`,
      );
    writeAtomically(filename, bytes);
    console.log(`${id}: downloaded and verified ${item.file}`);
  }
}

// The development certificate's subject must equal the MSIX publisher. The build signs with
// the key in Cert:\CurrentUser\My whose thumbprint matches the .cer, so no key file is needed.
const cer = path.join(root, inputs.msix.certificate);
const legacyPfx = cer.replace(/\.cer$/i, '.pfx');
mkdirSync(path.dirname(cer), { recursive: true });
const cerTemporary = `${cer}.${randomUUID()}.tmp`;
const script = `
$ErrorActionPreference = 'Stop'
$X509 = 'System.Security.Cryptography.X509Certificates'
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]'Exportable, PersistKeySet, UserKeySet'
$store = New-Object "$X509.X509Store" 'My', 'CurrentUser'
$store.Open('ReadWrite')
try {
  if (Test-Path -LiteralPath $env:VIDVNC_LEGACY_PFX) {
    # An earlier version kept the key in a passwordless .pfx. Move it into the store unchanged.
    $certificate = New-Object "$X509.X509Certificate2" $env:VIDVNC_LEGACY_PFX, ([string]$null), $flags
    $certificate.FriendlyName = 'VidVNC development signing'
    $store.Add($certificate)
    [System.IO.File]::WriteAllBytes($env:VIDVNC_CER_OUT, $certificate.Export('Cert'))
    "imported $($certificate.Thumbprint)"
  } elseif (Test-Path -LiteralPath $env:VIDVNC_CER) {
    $public = New-Object "$X509.X509Certificate2" $env:VIDVNC_CER
    $found = @($store.Certificates.Find('FindByThumbprint', $public.Thumbprint, $false) | Where-Object HasPrivateKey)
    if (-not $found.Count) {
      throw "The signing key for certificate $($public.Thumbprint) is not in Cert:\\CurrentUser\\My. Restore it from your backup with Import-PfxCertificate -Exportable -CertStoreLocation Cert:\\CurrentUser\\My, or delete $($env:VIDVNC_CER) to create a new certificate."
    }
    "present $($public.Thumbprint)"
  } else {
    $rsa = [System.Security.Cryptography.RSA]::Create(3072)
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new($env:VIDVNC_SUBJECT, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
    $usages = [System.Security.Cryptography.OidCollection]::new()
    [void]$usages.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $false))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false))
    $created = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(2))
    # CreateSelfSigned's key is ephemeral; a round trip through PFX bytes, protected by a
    # one-off password that never leaves this process, persists it in the store.
    $password = [Guid]::NewGuid().ToString('N')
    $certificate = New-Object "$X509.X509Certificate2" $created.Export('Pfx', $password), $password, $flags
    $certificate.FriendlyName = 'VidVNC development signing'
    $store.Add($certificate)
    [System.IO.File]::WriteAllBytes($env:VIDVNC_CER_OUT, $certificate.Export('Cert'))
    "created $($certificate.Thumbprint)"
  }
} catch {
  # On stdout: an encoded command writes stderr as CLIXML, which buries the message.
  "error $($_.Exception.Message)"
  exit 1
} finally {
  $store.Close()
}
`;
try {
  const result = spawnSync(
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        VIDVNC_SUBJECT: inputs.msix.publisher,
        VIDVNC_CER: cer,
        VIDVNC_CER_OUT: cerTemporary,
        VIDVNC_LEGACY_PFX: legacyPfx,
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Preparing the development certificate failed: ${/^error (.*)$/m.exec(result.stdout)?.[1] ?? result.stderr}`,
    );
  const [action, thumbprint] = result.stdout.trim().split(/\s+/);
  if (existsSync(cerTemporary)) renameSync(cerTemporary, cer);
  if (action === 'imported') {
    rmSync(legacyPfx);
    console.log(
      `Moved the development certificate's key into Cert:\\CurrentUser\\My and deleted ${legacyPfx}`,
    );
  } else if (action === 'created') {
    console.log(`Created development certificate ${inputs.msix.publisher}`);
  } else {
    console.log('Development certificate already exists');
  }
  console.log(`  Certificate: ${cer}`);
  console.log(`  Thumbprint: ${thumbprint} (publish it, so people can check the .cer they trust)`);
  if (action !== 'present')
    console.log(
      '  Back up the key: Export-PfxCertificate -Cert Cert:\\CurrentUser\\My\\' +
        `${thumbprint} -FilePath <backup>.pfx -Password (Read-Host -AsSecureString)`,
    );
} finally {
  rmSync(cerTemporary, { force: true });
}
