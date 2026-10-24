import { createHash } from 'node:crypto';

// Preserve the previous v1 identities when supplying literal v2 GUIDs. The legacy
// namespace and normalization are a product servicing contract, not a new scheme.
function legacyGuid(namespace, scope) {
  const canonical = namespace.replace(/[{}]/g, '').toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(canonical))
    throw new Error('Invalid MSI identity namespace');
  const bytes = createHash('sha256')
    .update(`${canonical}/${scope.toLowerCase().replaceAll('\\', '/')}`)
    .digest()
    .subarray(0, 16);
  bytes[7] = (bytes[7] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  // .NET Guid(byte[]) stores the first three fields in little-endian order.
  const hex = (start, end, reverse = false) => {
    const field = Buffer.from(bytes.subarray(start, end));
    return (reverse ? field.reverse() : field).toString('hex');
  };
  return `{${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10)}-${hex(10, 16)}}`.toUpperCase();
}

export function resolveMsiConfiguration(template, { version, files }) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split('.').some((part, i) => Number(part) > [255, 255, 65534][i])
  )
    throw new Error('MSI version must be stable major.minor.patch within 255.255.65534');
  const config = structuredClone(template);
  const { identityNamespace } = config;
  delete config.identityNamespace;
  config.architecture = 'x64';
  config.product.upgradeCode = legacyGuid(identityNamespace, 'x64/upgrade');
  config.product.productCode = legacyGuid(identityNamespace, `x64/product/${version}`);
  config.payload.allowedFiles = [...files];
  config.components = Object.create(null);
  const seen = new Set();
  for (const file of files) {
    const relative = file.replaceAll('\\', '/');
    if (
      relative.includes(':') ||
      relative.split('/').some((part) => ['', '.', '..'].includes(part))
    )
      throw new Error(`Invalid MSI payload path: ${file}`);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate MSI payload path: ${file}`);
    seen.add(key);
    config.components[relative] = legacyGuid(identityNamespace, `x64/component/${relative}`);
  }
  return config;
}
