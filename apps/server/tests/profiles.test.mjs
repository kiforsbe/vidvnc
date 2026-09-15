import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseProfile, getProfile, profileNames } from '../src/profiles.mjs';

test('exposes fixed profiles with safe transport settings', () => {
  assert.deepEqual(profileNames(), [
    'auto',
    'iphone-720p-test',
    'desktop',
    'balanced',
    'mobile',
    'low-bandwidth',
  ]);
  assert.equal(getProfile('mobile').width, 1280);
  assert.equal(getProfile('mobile').height, 720);
  assert.equal(getProfile('mobile').fps, 15);
  assert.equal(getProfile('mobile').bitrateKbps, 2000);
  assert.equal(getProfile('mobile').mtu, 1200);
  assert.equal(getProfile('unknown'), null);
});
test('iPhone 720p experiment changes only resolution from the stable baseline', () => {
  const { name, width, height, ...settings } = getProfile('iphone-720p-test');
  const {
    name: baselineName,
    width: baselineWidth,
    height: baselineHeight,
    ...baseline
  } = getProfile('low-bandwidth');
  assert.deepEqual(settings, baseline);
  assert.equal(width, 1280);
  assert.equal(height, 720);
  assert.equal(chooseProfile(name, 'iPhone').name, name);
  assert.equal(chooseProfile('auto', 'iPhone').name, name);
});
test('auto chooses 720p test for iPhone and desktop for normal desktop browsers', () => {
  assert.equal(
    chooseProfile('auto', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)').name,
    'iphone-720p-test',
  );
  assert.equal(
    chooseProfile('auto', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)').name,
    'desktop',
  );
});
test('explicit profile selection is stable and unknown values use auto', () => {
  assert.equal(chooseProfile('balanced', 'iPhone').name, 'balanced');
  assert.equal(chooseProfile('low-bandwidth', 'Mac').name, 'low-bandwidth');
  assert.equal(chooseProfile('made-up', 'Mac').name, 'desktop');
});
