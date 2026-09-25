import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gstreamerProblem, jsDependencyProblem } from '../dependencies.mjs';

async function checkout(t, { manifest, lock, installed = {} }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidvnc-deps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  if (lock) await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
  for (const [name, version] of Object.entries(installed)) {
    await mkdir(path.join(directory, 'node_modules', name), { recursive: true });
    await writeFile(
      path.join(directory, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version }),
    );
  }
  return directory;
}
const manifest = { devDependencies: { prettier: '3.9.6' } };
const lock = {
  packages: {
    '': { devDependencies: { prettier: '3.9.6' } },
    'node_modules/prettier': { version: '3.9.6' },
  },
};

test('matching packages are up to date', async (t) => {
  assert.equal(
    jsDependencyProblem(await checkout(t, { manifest, lock, installed: { prettier: '3.9.6' } })),
    null,
  );
});

test('a missing, outdated or unlocked package is reported', async (t) => {
  assert.match(
    jsDependencyProblem(await checkout(t, { manifest, lock })),
    /prettier is not installed/,
  );
  assert.match(
    jsDependencyProblem(await checkout(t, { manifest, lock, installed: { prettier: '3.8.0' } })),
    /prettier is 3\.8\.0, the lockfile pins 3\.9\.6/,
  );
  assert.match(
    jsDependencyProblem(
      await checkout(t, {
        manifest: { devDependencies: { prettier: '3.10.0' } },
        lock,
        installed: { prettier: '3.9.6' },
      }),
    ),
    /disagree about prettier/,
  );
  assert.match(
    jsDependencyProblem(await checkout(t, { manifest })),
    /package-lock\.json is missing/,
  );
});

test('workspace links only need to exist', async (t) => {
  const directory = await checkout(t, {
    manifest: {},
    lock: {
      packages: { '': {}, 'node_modules/@vidvnc/server': { link: true, resolved: 'apps/server' } },
    },
  });
  assert.match(jsDependencyProblem(directory), /@vidvnc\/server is not installed/);
  await mkdir(path.join(directory, 'apps/server'), { recursive: true });
  await writeFile(path.join(directory, 'apps/server/package.json'), '{"version":"0.8.0"}');
  await mkdir(path.join(directory, 'node_modules/@vidvnc'), { recursive: true });
  await symlink(
    path.join(directory, 'apps/server'),
    path.join(directory, 'node_modules/@vidvnc/server'),
    'junction',
  );
  assert.equal(jsDependencyProblem(directory), null);
});

test('this checkout’s own packages match its lockfile', () => {
  assert.equal(jsDependencyProblem(), null);
});

test('the GStreamer SDK version is checked against the pinned version', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidvnc-gst-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'packaging/windows'), { recursive: true });
  await writeFile(
    path.join(directory, 'packaging/windows/inputs.json'),
    JSON.stringify({
      gstreamer: { version: '1.28.6', installer: { file: 'gst.exe', sha256: 'abc' } },
    }),
  );
  const sdk = path.join(directory, 'sdk');
  assert.match(gstreamerProblem({ directory, sdk }), /was not found.*Install GStreamer 1\.28\.6/);
  await mkdir(path.join(sdk, 'bin'), { recursive: true });
  assert.equal(gstreamerProblem({ directory, sdk }), null, 'no pkg-config file: the build decides');
  await mkdir(path.join(sdk, 'lib/pkgconfig'), { recursive: true });
  const pc = path.join(sdk, 'lib/pkgconfig/gstreamer-1.0.pc');
  await writeFile(pc, 'Name: GStreamer\nVersion: 1.26.0\n');
  assert.match(gstreamerProblem({ directory, sdk }), /is 1\.26\.0; VidVNC pins 1\.28\.6/);
  await writeFile(pc, 'Name: GStreamer\nVersion: 1.28.6\n');
  assert.equal(gstreamerProblem({ directory, sdk }), null);
});
