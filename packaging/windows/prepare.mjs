// Explicit preparation step; building never downloads or creates credentials itself.
// - Downloads pinned runtime installers and the optional Node.js bundle into .deps/downloads
//   and verifies their SHA-256.
// - Creates the self-signed MSIX development certificate in .deps/signing if it is missing.
//   The certificate is written as files only; no Windows certificate store is changed.
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

// The development certificate's subject must equal the MSIX publisher.
const pfx = path.join(root, inputs.msix.certificate);
const cer = pfx.replace(/\.pfx$/i, '.cer');
if (existsSync(pfx) && existsSync(cer)) {
  console.log(`Development certificate already exists: ${pfx}`);
} else {
  mkdirSync(path.dirname(pfx), { recursive: true });
  const [pfxTemporary, cerTemporary] = [pfx, cer].map((file) => `${file}.${randomUUID()}.tmp`);
  const script = `
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(3072)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new($env:VIDVNC_SUBJECT, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
$usages = [System.Security.Cryptography.OidCollection]::new()
[void]$usages.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $false))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false))
$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(2))
[System.IO.File]::WriteAllBytes($env:VIDVNC_PFX, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
[System.IO.File]::WriteAllBytes($env:VIDVNC_CER, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
$certificate.Thumbprint
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
          VIDVNC_PFX: pfxTemporary,
          VIDVNC_CER: cerTemporary,
        },
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Creating the development certificate failed: ${result.stderr}`);
    renameSync(cerTemporary, cer);
    renameSync(pfxTemporary, pfx);
    console.log(
      `Created development certificate ${inputs.msix.publisher} (thumbprint ${result.stdout.trim()}): ${pfx}`,
    );
  } finally {
    rmSync(pfxTemporary, { force: true });
    rmSync(cerTemporary, { force: true });
  }
}
