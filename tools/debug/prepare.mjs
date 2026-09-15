import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeDevelopmentManifest } from './runtime.mjs';

const configuration = process.argv[2] || 'Debug';
if (process.argv.length > 3 || !['Debug', 'Release'].includes(configuration))
  throw new Error('Usage: node tools/debug/prepare.mjs [Debug|Release]');
if (process.platform !== 'win32') throw new Error('Windows host preparation requires Windows');
const root = fileURLToPath(new URL('../../', import.meta.url));
const project = path.join(root, 'apps/windows-host/VidVnc.Host.csproj');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  return result.stdout?.trim();
}
run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `build-native.cmd ${configuration}`]);
run('dotnet', ['build', project, '-c', configuration]);
const target = run(
  'dotnet',
  ['msbuild', project, `-p:Configuration=${configuration}`, '-getProperty:TargetPath'],
  true,
);
const filename = path.join(path.dirname(target), 'runtime.json');
writeDevelopmentManifest({
  root,
  configuration,
  filename,
  sdk: process.env.GSTREAMER_ROOT || path.join(root, '.deps/gstreamer'),
});
console.log(`Prepared ${configuration} host: ${target}\nRuntime manifest: ${filename}`);
