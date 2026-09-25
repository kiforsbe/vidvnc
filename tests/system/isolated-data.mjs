import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway %LOCALAPPDATA% for a system test's server, so it never reads or writes the
// user's real VidVNC settings, approved clients or certificates. HTTPS is off there: these
// tests exercise the host pipe over loopback HTTP, not certificate provisioning, and a real
// certificate would make the plain-HTTP requests redirect to a listener the test can't trust.
export async function isolatedDataDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'vidvnc-system-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'VidVNC'), { recursive: true });
  await writeFile(join(root, 'VidVNC', 'tls-settings.json'), JSON.stringify({ mode: 'off' }));
  return root;
}
