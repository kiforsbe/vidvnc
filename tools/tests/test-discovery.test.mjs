import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testFiles } from '../test.mjs';
import { excluded } from '../format.mjs';

test('test discovery recurses into subdirectories but prunes excluded ones, like format.mjs does', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'vidvnc-test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'nested/included.test.mjs'), '');
  // Every directory name format.mjs prunes should be pruned here too, even though
  // each one contains a matching .test.mjs file that would otherwise be discovered.
  for (const name of excluded) {
    await mkdir(path.join(root, name, 'inner'), { recursive: true });
    await writeFile(path.join(root, name, 'inner', 'excluded.test.mjs'), '');
  }
  const found = await testFiles(pathToFileURL(`${root}/`));
  const names = found.map((f) => f.name);
  assert.deepEqual(names, ['included.test.mjs']);
});
