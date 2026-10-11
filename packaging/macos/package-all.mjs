// Builds both macOS packages: npm run package:macos [-- --no-notarize]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('./build.mjs', import.meta.url));
for (const target of ['macos-cli', 'macos-server']) {
  const result = spawnSync(process.execPath, [build, target, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
