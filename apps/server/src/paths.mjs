import { join } from 'node:path';

// Per-user mutable settings, shared by the CLI server and the hosts. One definition with the
// media runtime's, so settings and logs always land in the same folder.
export { dataDirectory } from '@vidvnc/media-worker/runtime-paths';

export function settingsFiles(directory) {
  return {
    policy: join(directory, 'stream-policy.json'),
    access: join(directory, 'access-settings.json'),
    approvedClients: join(directory, 'approved-clients.json'),
    profileOrder: join(directory, 'profile-order.json'),
    tls: join(directory, 'tls-settings.json'),
    instances: join(directory, 'instances'),
  };
}
