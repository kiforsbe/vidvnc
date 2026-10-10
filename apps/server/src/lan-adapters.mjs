import { detectMacosLanAdapters } from './macos-lan-adapters.mjs';
import { detectWindowsLanAdapters } from './windows-lan-adapters.mjs';

// The LAN adapter provider for this platform. Each returns the rows local-session-scope.mjs
// reads; where there is none, detection fails and the standing password stays loopback-only.
// `env` is called on each detection, because it may create folders.
export function lanAdapterDetector({
  platform = process.platform,
  executable,
  env = () => process.env,
  windows = detectWindowsLanAdapters,
  macos = detectMacosLanAdapters,
} = {}) {
  if (platform === 'win32') return () => windows();
  if (platform === 'darwin') return () => macos({ executable, env: env() });
  return async () => {
    throw new Error(`LAN detection is unavailable on ${platform}`);
  };
}
