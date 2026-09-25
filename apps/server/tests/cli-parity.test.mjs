import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessSettings } from '../src/access-settings.mjs';
import { commands, execute, executeLine } from '../src/cli/commands.mjs';
import { createOfflineContext } from '../src/cli/offline.mjs';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';
import { rawDisplays } from './fixtures/cli-displays.mjs';

const script = [
  'share 2 on',
  'display-default 2 balanced',
  'default-profile desktop',
  'audio off',
  'codecs set h264,av1',
  'encoder-backend amf',
  'client-mode options',
  'options add size 3840x2160',
  'options add framerate 60',
  'options add bitrate 8000',
  'access available',
  'connection-mode one-time-keys',
  'max-devices 3',
  'code-ttl 60',
  'code-source-attempts 2',
  'code-attempts 3',
  'session-password-attempts 1',
  'code-alphabet letters',
  'local-session-networks 192.168.50.0/24',
  'public-name "Office PC"',
  'profile add "Office desk"',
  'profile edit office-desk --name Office --description "Desk monitor" --size 2560x1440 --fps 60 --bitrate 12000',
  'profile edit office-desk --bitrate-mode vbr --quality high',
  'profile disable office-desk',
  'profile move balanced 1',
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function expectedFields(directory) {
  const policy = defaultStreamPolicy();
  const access = (await AccessSettings.open(join(directory, 'none.json'))).snapshot();
  const skip = (keys, ...excluded) => keys.filter((key) => !excluded.includes(key));
  return [
    ...skip(Object.keys(policy), 'schemaVersion', 'revision', 'profiles', 'allowedOptions').map(
      (key) => `policy.${key}`,
    ),
    'profiles[]',
    ...skip(Object.keys(policy.profiles[0]), 'id', 'frameDelivery').map((key) => `profile.${key}`),
    ...Object.keys(policy.allowedOptions).map((key) => `allowedOptions.${key}`),
    ...skip(Object.keys(access), 'revision').map((key) => `access.${key}`),
    'profileOrder',
  ].sort();
}

function changedFields(before, after) {
  const fields = [];
  for (const key of Object.keys(after.policy)) {
    if (['schemaVersion', 'revision', 'profiles', 'allowedOptions'].includes(key)) continue;
    if (!same(before.policy[key], after.policy[key])) fields.push(`policy.${key}`);
  }
  const ids = (policy) => policy.profiles.map((profile) => profile.id).sort();
  if (!same(ids(before.policy), ids(after.policy))) fields.push('profiles[]');
  for (const profile of after.policy.profiles) {
    const previous = before.policy.profiles.find((row) => row.id === profile.id);
    if (!previous) continue;
    for (const key of Object.keys(profile))
      if (!same(previous[key], profile[key])) fields.push(`profile.${key}`);
  }
  for (const key of Object.keys(after.policy.allowedOptions))
    if (!same(before.policy.allowedOptions[key], after.policy.allowedOptions[key]))
      fields.push(`allowedOptions.${key}`);
  for (const key of Object.keys(after.access))
    if (key !== 'revision' && !same(before.access[key], after.access[key]))
      fields.push(`access.${key}`);
  if (before.profileOrder !== after.profileOrder) fields.push('profileOrder');
  return fields;
}

test('every editable setting has a CLI command that changes it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await createOfflineContext({
    directory,
    logDirectory: join(directory, 'logs'),
    listDisplays: async () => rawDisplays(),
    probeCodecs: async () => ['h264', 'av1'],
    alive: () => false,
  });
  const state = async () => ({
    policy: context.policy(),
    access: context.access(),
    profileOrder: await readFile(join(directory, 'profile-order.json'), 'utf8').catch(() => null),
  });
  const covered = new Map();
  for (const line of script) {
    const before = await state();
    await executeLine(context, line);
    const fields = changedFields(before, await state());
    assert.notDeepEqual(fields, [], `${line} changed nothing`);
    for (const field of fields) if (!covered.has(field)) covered.set(field, line);
  }
  const missing = (await expectedFields(directory)).filter((field) => !covered.has(field));
  assert.deepEqual(missing, [], `No CLI command changes: ${missing.join(', ')}`);
});

test('every command has usage and help in both modes', async () => {
  for (const command of commands) {
    assert.ok(command.usage.startsWith(command.name), `${command.name} usage`);
    assert.ok(command.summary.endsWith('.'), `${command.name} summary`);
    for (const mode of ['live', 'offline']) {
      const { text } = await execute({ mode }, ['help', ...command.name.split(' ')]);
      assert.match(text, /^Usage: /, `${mode} help ${command.name}`);
    }
  }
});
