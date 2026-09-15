import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeMedia } from '../src/native-media.mjs';
test('stop is idempotent, ignores other sessions and resolves after worker exit', async () => {
  const media = new NativeMedia();
  const negotiation = media.offer('owner', 'invalid').catch(() => {});
  const child = media.active.child;
  await media.stop('someone-else');
  assert.equal(media.active.stopping, false);
  const closed = media.stop('owner');
  assert.equal(media.stop('owner'), closed);
  await closed;
  assert.equal(media.active, null);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await negotiation;
});
test('worker failure rejects negotiation and allows a clean retry', async () => {
  const media = new NativeMedia();
  await assert.rejects(media.offer('one', 'invalid'), /Invalid SDP/);
  await assert.rejects(media.offer('two', 'invalid'), /Invalid SDP/);
  media.stop('two');
});
