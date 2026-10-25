// Default Windows distribution: bundled-Node CLI ZIP and unsigned host MSI.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = (name) => path.join(root, 'packaging/windows', name);
const VARIANTS = [['windows-cli'], ['windows-server']];

function run(file, args = []) {
  console.log(`\n> node ${path.relative(root, file)} ${args.join(' ')}`.trimEnd());
  const result = spawnSync(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\nPackaging stopped: ${path.basename(file)} ${args.join(' ')} failed.`);
    process.exit(result.status ?? 1);
  }
}

run(script('prepare.mjs'));
for (const variant of VARIANTS) run(script('build.mjs'), variant);

const version = JSON.parse(
  readFileSync(path.join(root, 'apps/server/package.json'), 'utf8'),
).version;
console.log('\nDefault Windows packages built:');
for (const [target] of VARIANTS) {
  const filename = `${target === 'windows-server' ? 'VidVNC' : 'VidVNC-CLI'}-${version}-windows-x64-unsigned.${target === 'windows-server' ? 'msi' : 'zip'}`;
  console.log(`  ${path.join('out/installers', target, version, filename)}`);
}
