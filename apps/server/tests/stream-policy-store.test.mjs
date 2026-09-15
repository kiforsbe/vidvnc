import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamPolicyStore } from '../src/stream-policy-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename: join(directory, 'stream-policy.json') };
}

test('save/reopen persists edits with monotonic revision and independent snapshots', async (t) => {
  const { filename } = await fixture(t);
  const store = await StreamPolicyStore.open(filename);
  const edit = store.snapshot();
  edit.profiles[0].description = 'My iPhone';
  assert.notEqual(store.snapshot().profiles[0].description, 'My iPhone');
  const committed = await store.replace(edit, 0);
  assert.equal(committed.revision, 1);
  committed.profiles[0].description = 'Mutation';
  const reopened = await StreamPolicyStore.open(filename);
  assert.equal(reopened.snapshot().profiles[0].description, 'My iPhone');
  assert.equal(reopened.snapshot().revision, 1);
});

test('simultaneous stale edits cannot overwrite an acknowledged save', async (t) => {
  const { filename } = await fixture(t);
  const store = await StreamPolicyStore.open(filename);
  const results = await Promise.allSettled([
    store.replace(store.snapshot(), 0),
    store.replace(store.snapshot(), 0),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot().revision, 1);
});

test('another store cannot overwrite a changed on-disk revision', async (t) => {
  const { filename } = await fixture(t);
  const a = await StreamPolicyStore.open(filename),
    b = await StreamPolicyStore.open(filename);
  await a.replace(a.snapshot(), 0);
  await assert.rejects(b.replace(b.snapshot(), 0), /changed|conflict/i);
  assert.equal(b.snapshot().revision, 0);
});

test('invalid edits leave previous file and in-memory configuration intact', async (t) => {
  const { filename } = await fixture(t);
  const store = await StreamPolicyStore.open(filename);
  await store.replace(store.snapshot(), 0);
  const before = await readFile(filename, 'utf8');
  const edit = store.snapshot();
  edit.defaultProfileId = 'missing';
  await assert.rejects(store.replace(edit, 1));
  assert.equal(await readFile(filename, 'utf8'), before);
  assert.equal(store.snapshot().revision, 1);
});

test('malformed, future and oversized files do not become permissive defaults', async (t) => {
  const { filename } = await fixture(t);
  for (const data of ['{broken', '{"schemaVersion":99}', ' '.repeat(65537)]) {
    await writeFile(filename, data);
    await assert.rejects(StreamPolicyStore.open(filename));
    assert.equal(await readFile(filename, 'utf8'), data);
  }
});

test('filesystem failure leaves memory unchanged and no temporary residue', async (t) => {
  const { directory } = await fixture(t);
  const parent = join(directory, 'parent');
  const store = await StreamPolicyStore.open(join(parent, 'stream-policy.json'));
  await writeFile(parent, 'not a directory');
  await assert.rejects(store.replace(store.snapshot(), 0));
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual(await readdir(directory), ['parent']);
});

test('queued edits are captured at submission rather than by reference', async (t) => {
  const { filename } = await fixture(t);
  const store = await StreamPolicyStore.open(filename);
  const edit = store.snapshot();
  edit.profiles[0].description = 'Submitted';
  const saving = store.replace(edit, 0);
  edit.profiles[0].description = 'Changed after submission';
  await saving;
  assert.equal(store.snapshot().profiles[0].description, 'Submitted');
});

test('existing lock fails closed and is not removed by a different writer', async (t) => {
  const { filename } = await fixture(t);
  const store = await StreamPolicyStore.open(filename);
  await writeFile(`${filename}.lock`, 'other owner');
  await assert.rejects(store.replace(store.snapshot(), 0), /being saved/);
  assert.equal(await readFile(`${filename}.lock`, 'utf8'), 'other owner');
  assert.equal(store.snapshot().revision, 0);
});
