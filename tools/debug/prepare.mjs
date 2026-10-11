import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeDevelopmentManifest } from './runtime.mjs';
import { buildHost, buildWorker, hostTarget, macManifestPath } from './host-build.mjs';
import { defaultGStreamerRoot } from '../../native/media-worker/runtime-paths.mjs';

const configuration = process.argv[2] || 'Debug';
if (process.argv.length > 3 || !['Debug', 'Release'].includes(configuration))
  throw new Error('Usage: node tools/debug/prepare.mjs [Debug|Release]');
if (!['win32', 'darwin'].includes(process.platform))
  throw new Error('Host preparation requires Windows or macOS');
const root = fileURLToPath(new URL('../../', import.meta.url));
buildWorker(root, configuration);
buildHost(root, configuration);
const target = hostTarget(root, configuration);
// Windows keeps the manifest beside the host; the macOS app bundle is rebuilt by Xcode, so
// its manifest lives in out/macos-host, where the VidVNC scheme points.
const filename =
  process.platform === 'darwin'
    ? macManifestPath(root, configuration)
    : path.join(path.dirname(target), 'runtime.json');
writeDevelopmentManifest({
  root,
  configuration,
  filename,
  sdk: defaultGStreamerRoot({ root }),
});
console.log(`Prepared ${configuration} host: ${target}\nRuntime manifest: ${filename}`);
