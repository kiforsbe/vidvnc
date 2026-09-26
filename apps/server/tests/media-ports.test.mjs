import test from 'node:test';
import assert from 'node:assert/strict';
import { iceBindEnvironment, mediaPortsEnvironment } from '../src/native-media.mjs';
import { validMediaPorts } from '../src/access-settings.mjs';

test('the worker gets the port range as VIDVNC_ICE_PORTS, and nothing when it is automatic', () => {
  assert.deepEqual(mediaPortsEnvironment({ min: 40000, max: 40049 }), {
    VIDVNC_ICE_PORTS: '40000-40049',
  });
  assert.deepEqual(mediaPortsEnvironment(null), {});
});

test('a media port range is 8 to 1000 unprivileged ports', () => {
  assert.equal(validMediaPorts(null), true);
  assert.equal(validMediaPorts({ min: 40000, max: 40049 }), true);
  for (const value of [
    { min: 40000, max: 40006 },
    { min: 1000, max: 1010 },
    { min: 40000, max: 41000 },
    { min: 40049, max: 40000 },
    { min: 40000, max: 40049, extra: 1 },
    { min: '40000', max: 40049 },
    [40000, 40049],
    undefined,
  ])
    assert.equal(validMediaPorts(value), false, JSON.stringify(value));
});

test('the worker is told to gather on loopback only when the relay carries its traffic', () => {
  assert.deepEqual(iceBindEnvironment('loopback'), { VIDVNC_ICE_BIND: 'loopback' });
  assert.deepEqual(iceBindEnvironment(null), {});
  assert.throws(() => iceBindEnvironment('any'), /Invalid ICE bind/);
});
