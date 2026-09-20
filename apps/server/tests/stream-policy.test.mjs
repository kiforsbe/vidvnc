import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultStreamPolicy,
  validateStreamPolicy,
  resolveStreamPolicy,
} from '../src/stream-policy.mjs';
import { VIDEO_CODECS } from '../src/video-codecs.mjs';

test('seeds preserve working iPhone and desktop numeric plans', () => {
  const policy = defaultStreamPolicy();
  assert.equal(policy.profiles.length, 5);
  assert.deepEqual(resolveStreamPolicy(policy, { userAgent: 'iPhone' }).profile, {
    name: 'iphone-720p-test',
    width: 1280,
    height: 720,
    fps: 15,
    bitrateKbps: 1000,
    bitrateMode: 'cbr',
    quality: 'balanced',
    mtu: 1200,
  });
  assert.deepEqual(resolveStreamPolicy(policy, {}).profile, {
    name: 'desktop',
    width: 2560,
    height: 1440,
    fps: 30,
    bitrateKbps: 6000,
    bitrateMode: 'cbr',
    quality: 'balanced',
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
    bitrateMode: 'cbr',
    quality: 'balanced',
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

test('default policy allows every known video codec, in default order', () => {
  assert.deepEqual(defaultStreamPolicy().videoCodecs, ['av1', 'h265', 'h264']);
});

test('a policy without videoCodecs validates and receives the default list', () => {
  const policy = defaultStreamPolicy();
  delete policy.videoCodecs;
  assert.deepEqual(validateStreamPolicy(policy).videoCodecs, [...VIDEO_CODECS]);
});

test('video codec lists are rejected without H.264, with duplicates, unknown ids, or the wrong shape', () => {
  for (const videoCodecs of [['av1', 'h265'], ['h264', 'h264'], ['vp9', 'h264'], [], 'h264', [1]]) {
    const policy = defaultStreamPolicy();
    policy.videoCodecs = videoCodecs;
    assert.throws(() => validateStreamPolicy(policy));
  }
});

test('a policy allowing only H.264 is valid', () => {
  const policy = defaultStreamPolicy();
  policy.videoCodecs = ['h264'];
  assert.deepEqual(validateStreamPolicy(policy).videoCodecs, ['h264']);
});

test('default policy seeds every profile as cbr and balanced', () => {
  for (const profile of defaultStreamPolicy().profiles) {
    assert.equal(profile.bitrateMode, 'cbr');
    assert.equal(profile.quality, 'balanced');
  }
});

test('profiles without bitrate mode or quality upgrade to cbr and balanced without mutating input', () => {
  const policy = defaultStreamPolicy();
  for (const profile of policy.profiles) {
    delete profile.bitrateMode;
    delete profile.quality;
  }
  const upgraded = validateStreamPolicy(policy);
  for (const profile of upgraded.profiles) {
    assert.equal(profile.bitrateMode, 'cbr');
    assert.equal(profile.quality, 'balanced');
  }
  for (const profile of policy.profiles) {
    assert.equal(Object.hasOwn(profile, 'bitrateMode'), false);
    assert.equal(Object.hasOwn(profile, 'quality'), false);
  }
});

test('bitrate mode and quality are validated', () => {
  const policy = defaultStreamPolicy();
  Object.assign(policy.profiles[0], { bitrateMode: 'vbr', quality: 'high' });
  assert.doesNotThrow(() => validateStreamPolicy(policy));
  policy.profiles[0].bitrateMode = 'abr';
  assert.throws(() => validateStreamPolicy(policy), /Bitrate mode is invalid/);
  policy.profiles[0].bitrateMode = 'vbr';
  policy.profiles[0].quality = 'ultra';
  assert.throws(() => validateStreamPolicy(policy), /Quality is invalid/);
});

test('resolution carries bitrate mode and quality, and custom settings stay cbr and balanced', () => {
  const policy = defaultStreamPolicy();
  Object.assign(
    policy.profiles.find((p) => p.id === 'balanced'),
    {
      bitrateMode: 'vbr',
      quality: 'efficient',
    },
  );
  const named = resolveStreamPolicy(policy, { profileId: 'balanced' }).profile;
  assert.equal(named.bitrateMode, 'vbr');
  assert.equal(named.quality, 'efficient');
  policy.clientMode = 'options';
  const custom = resolveStreamPolicy(policy, {
    custom: { width: 1280, height: 720, fps: 15, bitrateKbps: 1000 },
  }).profile;
  assert.equal(custom.bitrateMode, 'cbr');
  assert.equal(custom.quality, 'balanced');
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
