import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';
import * as edits from '../src/cli/policy-edits.mjs';
import { MAIN, SIDE, displayRows } from './fixtures/cli-displays.mjs';

test('first-run seeding shares only the primary persistent display', () => {
  const policy = defaultStreamPolicy();
  const seeded = edits.seedDisplaySharing(policy, displayRows());
  assert.deepEqual(seeded.displaySharing, { [MAIN]: true });
  assert.equal(seeded.revision, policy.revision);
  assert.equal(policy.displaySharing, null);
  assert.equal(edits.seedDisplaySharing(seeded, displayRows()), seeded);
  const secondary = displayRows().filter((row) => !row.primary);
  assert.deepEqual(edits.seedDisplaySharing(policy, secondary).displaySharing, {});
});

test('display sharing, defaults, audio and client mode edit copies of the policy', () => {
  const displays = displayRows();
  const shared = edits.setDisplaySharing(defaultStreamPolicy(), displays, displays[1], true);
  assert.deepEqual(shared.displaySharing, { [MAIN]: true, [SIDE]: true });
  assert.deepEqual(edits.setDisplaySharing(shared, displays, displays[0], false).displaySharing, {
    [MAIN]: false,
    [SIDE]: true,
  });
  assert.throws(
    () => edits.setDisplaySharing(shared, displays, displays[2], true),
    /Display 3 has no stable identity and cannot be shared/,
  );
  const withDefault = edits.setDisplayDefault(shared, SIDE, 'mobile');
  assert.equal(withDefault.displayDefaults[SIDE], 'mobile');
  assert.equal(
    Object.hasOwn(edits.setDisplayDefault(withDefault, SIDE, null).displayDefaults, SIDE),
    false,
  );
  assert.throws(
    () => edits.setDisplayDefault(shared, SIDE, 'missing'),
    /Display default must refer to an available profile/,
  );
  assert.equal(edits.setDefaultProfile(shared, 'desktop').defaultProfileId, 'desktop');
  assert.throws(
    () => edits.setDefaultProfile(shared, 'missing'),
    /Default profile must refer to an available profile/,
  );
  assert.equal(edits.setAudio(shared, false).allowAudio, false);
  assert.equal(edits.setClientMode(shared, 'options').clientMode, 'options');
  assert.throws(() => edits.setClientMode(shared, 'free'), /Invalid client customization mode/);
});

test('profile IDs are slugs of the name that avoid collisions and reserved IDs', () => {
  assert.equal(edits.profileSlug('Office', new Set(['office', 'office-2'])), 'office-3');
  assert.equal(edits.profileSlug('  Café Screen!! ', new Set()), 'caf-screen');
  assert.equal(edits.profileSlug('***', new Set()), 'profile');
  assert.equal(edits.profileSlug('Auto', new Set()), 'auto-2');
  assert.equal(edits.profileSlug('Custom', new Set()), 'custom-2');
  assert.equal(edits.profileSlug('a'.repeat(60), new Set()).length, 48);
});

test('profiles are added, edited, duplicated, enabled and removed with host validation', () => {
  const { policy, profile } = edits.addProfile(defaultStreamPolicy(), { name: ' Office desk ' });
  assert.deepEqual(profile, {
    id: 'office-desk',
    name: 'Office desk',
    description: '',
    enabled: true,
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 4000,
    frameDelivery: 'fixed',
  });
  assert.deepEqual(policy.profiles.at(-1), profile);
  assert.throws(() => edits.addProfile(policy, { name: '   ' }), /Profile name is invalid/);
  const edited = edits.editProfile(policy, 'office-desk', {
    name: ' Desk ',
    fps: 60,
    enabled: false,
  });
  const last = edited.profiles.at(-1);
  assert.deepEqual([last.name, last.fps, last.enabled], ['Desk', 60, false]);
  assert.throws(
    () => edits.editProfile(policy, 'office-desk', { width: 1921 }),
    /Output dimensions must be even/,
  );
  assert.throws(
    () => edits.editProfile(policy, 'missing', { fps: 60 }),
    /Profile no longer exists/,
  );
  const copy = edits.duplicateProfile(policy, 'balanced');
  assert.deepEqual(
    [copy.profile.id, copy.profile.name, copy.profile.fps],
    ['copy-of-balanced', 'Copy of Balanced', 30],
  );
  const long = edits.editProfile(policy, 'office-desk', { name: 'L'.repeat(64) });
  assert.equal(edits.duplicateProfile(long, 'office-desk').profile.name.length, 64);
  assert.equal(
    edits.removeProfile(policy, 'office-desk').profiles.some((row) => row.id === 'office-desk'),
    false,
  );
  assert.equal(
    edits.setProfileEnabled(policy, 'mobile', false).profiles.find((row) => row.id === 'mobile')
      .enabled,
    false,
  );
});

test('removing or disabling a default profile asks to change the default first', () => {
  const policy = edits.setDisplayDefault(
    edits.setDefaultProfile(defaultStreamPolicy(), 'desktop'),
    SIDE,
    'mobile',
  );
  assert.throws(() => edits.removeProfile(policy, 'desktop'), {
    message: 'Default profile must refer to an available profile; change the default first',
  });
  assert.throws(() => edits.setProfileEnabled(policy, 'mobile', false), {
    message: 'Display default must refer to an available profile; change the default first',
  });
  let onlyDesktop = defaultStreamPolicy();
  for (const id of ['iphone-720p-test', 'mobile', 'balanced', 'low-bandwidth'])
    onlyDesktop = edits.setProfileEnabled(onlyDesktop, id, false);
  assert.throws(
    () => edits.setProfileEnabled(onlyDesktop, 'desktop', false),
    /At least one profile must remain available/,
  );
});

test('video codecs are reordered but must keep H.264 enabled', () => {
  const shared = defaultStreamPolicy();
  assert.deepEqual(edits.setVideoCodecs(shared, ['h264', 'av1']).videoCodecs, ['h264', 'av1']);
  assert.throws(() => edits.setVideoCodecs(shared, ['av1']), /H\.264 must stay enabled/);
});

test('allowed options add and remove values without duplicates or empty lists', () => {
  const policy = defaultStreamPolicy();
  assert.deepEqual(
    edits
      .addAllowedOption(policy, 'size', { width: 3840, height: 2160 })
      .allowedOptions.resolutions.at(-1),
    { width: 3840, height: 2160 },
  );
  assert.deepEqual(
    edits.addAllowedOption(policy, 'framerate', 60).allowedOptions.frameRates,
    [15, 30, 60],
  );
  assert.deepEqual(
    edits.removeAllowedOption(policy, 'bitrate', 1000).allowedOptions.bitratesKbps,
    [2000, 4000, 6000],
  );
  assert.throws(
    () => edits.addAllowedOption(policy, 'framerate', 30),
    /That option is already allowed/,
  );
  assert.throws(
    () => edits.removeAllowedOption(policy, 'size', { width: 800, height: 600 }),
    /That option is not in the allowed list/,
  );
  const single = edits.removeAllowedOption(policy, 'framerate', 15);
  assert.throws(
    () => edits.removeAllowedOption(single, 'framerate', 30),
    /Frame rates requires 1–64 choices/,
  );
  assert.throws(
    () => edits.addAllowedOption(policy, 'framerate', 61),
    /Frame rate must be an integer from 1 to 60/,
  );
});
