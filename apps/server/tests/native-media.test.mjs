import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeMedia, probe } from '../src/native-media.mjs';

test('the probe surfaces encoder backends beside the codec list', () => {
  const info = probe();
  assert.ok(Array.isArray(info.backends) && info.backends.length > 0);
  for (const backend of info.backends) {
    assert.ok(backend.id && backend.label);
    assert.ok(Array.isArray(backend.codecs) && backend.codecs.length > 0);
    for (const codec of backend.codecs) {
      const minimum = backend.minimums[codec];
      assert.ok(minimum.width > 0 && minimum.height > 0, `${backend.id} ${codec}`);
    }
  }
  // Every codec the host advertises must come from some backend, or codec selection would
  // offer a codec that nothing can actually encode.
  const supported = new Set(info.backends.flatMap((backend) => backend.codecs));
  for (const codec of info.codecs) assert.ok(supported.has(codec), codec);
});

// The worker refuses a source without the owner's lease (its viewers' input comes from the
// sandboxed network process), so these run with hostControl as the server does.
test('stop is idempotent, ignores other sessions and resolves after worker exit', async () => {
  const media = new NativeMedia({ hostControl: true });
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
  const media = new NativeMedia({ hostControl: true });
  await assert.rejects(media.offer('one', 'invalid'), /Invalid SDP/);
  await assert.rejects(media.offer('two', 'invalid'), /Invalid SDP/);
  media.stop('two');
});
