import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeManifest, packagedWorkerEnvironment } from './runtime-manifest.mjs';
import { runtimePaths } from './runtime-paths.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const runtimeManifest = process.env.VIDVNC_RUNTIME_MANIFEST
  ? loadRuntimeManifest(process.env.VIDVNC_RUNTIME_MANIFEST, { platform: process.platform })
  : undefined;
const { userData, sdkRoot, executable, logDirectory } = runtimePaths({
  root,
  manifest: runtimeManifest,
});
export { sdkRoot, executable, logDirectory };

export function workerEnvironment() {
  mkdirSync(logDirectory, { recursive: true });
  if (runtimeManifest?.mode === 'packaged') {
    mkdirSync(path.join(userData, 'cache'), { recursive: true });
    return packagedWorkerEnvironment(runtimeManifest, userData);
  }
  return {
    ...process.env,
    PATH: `${path.join(sdkRoot, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
    VIDVNC_NATIVE_LOG: path.join(logDirectory, 'native-worker.log'),
  };
}
