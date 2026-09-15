import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultStreamPolicy,
  validateStreamPolicy,
  resolveStreamPolicy,
} from '../src/stream-policy.mjs';

test('seeds preserve working iPhone and desktop numeric plans', () => {
  const policy = defaultStreamPolicy();
  assert.equal(policy.profiles.length, 5);
  assert.deepEqual(resolveStreamPolicy(policy, { userAgent: 'iPhone' }).profile, {
    name: 'iphone-720p-test',
    width: 1280,
    height: 720,
    fps: 15,
    bitrateKbps: 1000,
    mtu: 1200,
  });
  assert.deepEqual(resolveStreamPolicy(policy, {}).profile, {
    name: 'desktop',
    width: 2560,
    height: 1440,
    fps: 30,
    bitrateKbps: 6000,
    mtu: 1200,
  });
});

test('explicit requests win over display defaults, then global defaults', () => {
  const policy = defaultStreamPolicy();
  policy.defaultProfileId = 'balanced';
  policy.displayDefaults['monitor-2'] = 'mobile';
  assert.equal(resolveStreamPolicy(policy, { displayId: 'monitor-2' }).profile.name, 'mobile');
  assert.equal(resolveStreamPolicy(policy, {}).profile.name, 'balanced');
  const explicit = resolveStreamPolicy(policy, { displayId: 'monitor-2', profileId: 'desktop' });
  assert.equal(explicit.profile.name, 'desktop');
  assert.equal(explicit.selectedBy, 'client');
});

test('unknown or disabled explicit profiles fail instead of selecting auto', () => {
  const policy = defaultStreamPolicy();
  policy.profiles.find((p) => p.id === 'desktop').enabled = false;
  assert.throws(() => resolveStreamPolicy(policy, { profileId: 'desktop' }), /not allowed/);
  assert.throws(() => resolveStreamPolicy(policy, { profileId: 'invented' }), /not allowed/);
  assert.notEqual(resolveStreamPolicy(policy, {}).profile.name, 'desktop');
});

test('host audio denial wins and clients may decline allowed audio', () => {
  const policy = defaultStreamPolicy();
  assert.equal(resolveStreamPolicy(policy, { audio: false }).audio.mode, 'off');
  policy.allowAudio = false;
  assert.equal(resolveStreamPolicy(policy, { audio: true }).audio.mode, 'off');
});

test('custom plans require approved mode and all approved dimensions, fps and bitrate', () => {
  const policy = defaultStreamPolicy();
  const custom = { width: 1280, height: 720, fps: 15, bitrateKbps: 1000 };
  assert.throws(() => resolveStreamPolicy(policy, { custom }), /customization/);
  policy.clientMode = 'options';
  assert.deepEqual(resolveStreamPolicy(policy, { custom }).profile, {
    name: 'custom',
    ...custom,
    mtu: 1200,
  });
  for (const change of [{ width: 1920 }, { fps: 60 }, { bitrateKbps: 5000 }, { mtu: 9000 }])
    assert.throws(() => resolveStreamPolicy(policy, { custom: { ...custom, ...change } }));
  assert.throws(() => resolveStreamPolicy(policy, { custom, profileId: 'balanced' }), /both/);
});

test('schema rejects invalid data and unsafe references', () => {
  for (const mutate of [
    (p) => (p.schemaVersion = 2),
    (p) => p.profiles.push({ ...p.profiles[0] }),
    (p) => (p.profiles[0].width = 1279),
    (p) => (p.profiles[0].fps = Infinity),
    (p) => (p.profiles[0].name = ' '),
    (p) => (p.profiles[0].frameDelivery = 'variable'),
    (p) => (p.defaultProfileId = 'missing'),
    (p) => {
      p.defaultProfileId = p.profiles[0].id;
      p.profiles[0].enabled = false;
    },
    (p) => (p.displayDefaults['monitor-2'] = 'missing'),
    (p) => (p.allowAudio = 'true'),
    (p) => p.profiles.forEach((profile) => (profile.enabled = false)),
    (p) => (p.unexpected = true),
  ]) {
    const policy = defaultStreamPolicy();
    mutate(policy);
    assert.throws(() => validateStreamPolicy(policy));
  }
});

test('custom named profile survives validation and does not mutate source through results', () => {
  const policy = defaultStreamPolicy();
  policy.profiles.push({
    ...policy.profiles[0],
    id: 'custom-office',
    name: 'Office',
    description: 'My profile',
    width: 1600,
    height: 900,
    bitrateKbps: 3000,
  });
  const clean = validateStreamPolicy(policy);
  clean.profiles[0].name = 'changed';
  assert.notEqual(policy.profiles[0].name, 'changed');
  const plan = resolveStreamPolicy(policy, { profileId: 'custom-office' });
  assert.equal(plan.profile.width, 1600);
  plan.profile.width = 2000;
  assert.equal(policy.profiles.at(-1).width, 1600);
});
