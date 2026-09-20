import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeDevelopmentManifest } from './runtime.mjs';
import { buildHost, buildWorker, hostTarget } from './host-build.mjs';

const configuration = process.argv[2] || 'Debug';
if (process.argv.length > 3 || !['Debug', 'Release'].includes(configuration))
  throw new Error('Usage: node tools/debug/prepare.mjs [Debug|Release]');
if (process.platform !== 'win32') throw new Error('Windows host preparation requires Windows');
const root = fileURLToPath(new URL('../../', import.meta.url));
buildWorker(root, configuration);
buildHost(root, configuration);
const target = hostTarget(root, configuration);
const filename = path.join(path.dirname(target), 'runtime.json');
writeDevelopmentManifest({
  root,
  configuration,
  filename,
  sdk: process.env.GSTREAMER_ROOT || path.join(root, '.deps/gstreamer'),
});
console.log(`Prepared ${configuration} host: ${target}\nRuntime manifest: ${filename}`);
