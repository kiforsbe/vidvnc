// Builds every Windows package: npm run package
// Runs prepare.mjs first (pinned downloads and the development certificate; both are skipped
// when already present), then each build.mjs variant in turn, since they share staging
// directories. Writes, under out/installers/<target>/<version>/:
//   windows-cli     the unsigned ZIP, with and without the prerequisite installers
//   windows-server  the MSIX with and without bundled Node.js, each also as a ZIP with the
//                   prerequisite installers (--include-runtime-installers also writes the MSIX)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = (name) => path.join(root, 'packaging/windows', name);
const VARIANTS = [
  ['windows-cli'],
  ['windows-cli', '--include-runtime-installers'],
  ['windows-server', '--include-runtime-installers'],
  ['windows-server', '--include-runtime-installers', '--include-node'],
];

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
console.log('\nPackages:');
for (const target of new Set(VARIANTS.map(([name]) => name))) {
  const directory = path.join(root, 'out/installers', target, version);
  if (!existsSync(directory)) continue;
  for (const name of readdirSync(directory)
    .filter((file) => /\.(zip|msix)$/i.test(file))
    .sort())
    console.log(
      `  ${path.relative(root, path.join(directory, name))} (${(statSync(path.join(directory, name)).size / 2 ** 20).toFixed(1)} MiB)`,
    );
}
