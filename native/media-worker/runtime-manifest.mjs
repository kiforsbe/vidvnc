import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function packagedWorkerEnvironment(runtime, userData, inherited = process.env) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) => !/^(GST_|GSTREAMER_|NODE_|VIDVNC_MEDIA_WORKER$|PATH$)/i.test(key),
    ),
  );
  const systemRoot = Object.entries(inherited).find(
    ([key]) => key.toUpperCase() === 'SYSTEMROOT',
  )?.[1];
  if (!systemRoot) throw new Error('SystemRoot is required for the Windows media runtime');
  const identity = createHash('sha256').update(runtime.root).digest('hex').slice(0, 16);
  return {
    ...env,
    PATH: [runtime.mediaBin, path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter),
    GST_PLUGIN_PATH_1_0: runtime.plugins,
    GST_PLUGIN_SYSTEM_PATH_1_0: '',
    GST_REGISTRY_1_0: path.join(userData, 'cache', `gstreamer-v1-${identity}.bin`),
    ...(runtime.scanner
      ? { GST_PLUGIN_SCANNER_1_0: runtime.scanner }
      : { GST_REGISTRY_FORK: 'no' }),
    VIDVNC_NATIVE_LOG: path.join(userData, 'logs', 'native-worker.log'),
  };
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function loadRuntimeManifest(filename) {
  const absolute = path.resolve(filename);
  const root = realpathSync(path.dirname(absolute));
  let data;
  try {
    data = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read runtime manifest ${absolute}: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Runtime manifest must be an object');
  for (const [field, allowed] of Object.entries({
    schemaVersion: [1],
    mode: ['packaged', 'development'],
    configuration: ['Debug', 'Release'],
    architecture: ['x64'],
  })) {
    if (!allowed.includes(data[field])) throw new Error(`Invalid runtime manifest ${field}`);
  }
  const result = {
    schemaVersion: data.schemaVersion,
    mode: data.mode,
    configuration: data.configuration,
    architecture: data.architecture,
    root,
  };
  for (const field of ['node', 'server', 'worker', 'mediaBin', 'plugins', 'scanner']) {
    // No node means the launcher runs the installed Node.js prerequisite.
    if ((field === 'scanner' || field === 'node') && data[field] === undefined) continue;
    const value = data[field];
    if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
      throw new Error(`Invalid runtime manifest ${field}: expected a path`);
    const candidate = path.resolve(root, value);
    if (
      data.mode === 'packaged' &&
      (path.win32.isAbsolute(value) ||
        path.posix.isAbsolute(value) ||
        /^[a-z]:/i.test(value) ||
        !contained(root, candidate))
    )
      throw new Error(`Invalid runtime manifest ${field}: path must stay inside the package`);
    try {
      const resolved = realpathSync(candidate);
      if (data.mode === 'packaged' && !contained(root, resolved))
        throw new Error('resolved path escapes the package');
      const directory = field === 'mediaBin' || field === 'plugins';
      const info = statSync(resolved);
      if (directory ? !info.isDirectory() : !info.isFile())
        throw new Error(`expected a ${directory ? 'directory' : 'file'}`);
      result[field] = resolved;
    } catch (error) {
      throw new Error(`Invalid runtime manifest ${field}: ${error.message}`);
    }
  }
  return Object.freeze(result);
}
