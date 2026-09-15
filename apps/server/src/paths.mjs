import { homedir } from 'node:os';
import { join } from 'node:path';

// Per-user mutable settings, shared by the CLI server and the Windows host.
export function dataDirectory({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  return platform === 'win32'
    ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'VidVNC')
    : join(home, 'Library', 'Application Support', 'VidVNC');
}

export function settingsFiles(directory) {
  return {
    policy: join(directory, 'stream-policy.json'),
    access: join(directory, 'access-settings.json'),
    profileOrder: join(directory, 'profile-order.json'),
    instances: join(directory, 'instances'),
  };
}
