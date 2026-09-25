import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session-store.mjs';
import { ViewerAssetGrants, clearViewerCookie, viewerCookie } from '../src/viewer-asset-grants.mjs';

test('a viewer grant follows the live session without extending its idle lifetime', () => {
  let now = 0;
  const sessions = new SessionStore({ clock: () => now, sessionTtlMs: 20_000 });
  const id = sessions.connectApproved({ id: 'client-1', generation: 0 }, '127.0.0.1').sessionId;
  const grants = new ViewerAssetGrants();
  const value = grants.issue(id, '127.0.0.1');
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  now = 19_000;
  assert.equal(grants.allows('vidvnc-viewer=' + value, '::ffff:127.0.0.1', sessions), true);
  assert.equal(sessions.peek(id).lastSeenAt, 0);
  now = 20_000;
  assert.equal(grants.allows('vidvnc-viewer=' + value, '127.0.0.1', sessions), false);
});

test('a grant rejects malformed cookies and peers that do not own the session', () => {
  const sessions = new SessionStore();
  const id = sessions.connectApproved({ id: 'client-1', generation: 0 }, '127.0.0.1').sessionId;
  const grants = new ViewerAssetGrants();
  const value = grants.issue(id, '127.0.0.1');
  const header = 'vidvnc-viewer=' + value;
  assert.equal(grants.allows('theme=dark; ' + header, '127.0.0.1', sessions), true);
  for (const malformed of [
    undefined,
    '',
    header + '; ' + header,
    'vidvnc-viewer=' + value + '!',
    'vidvnc-viewer="' + value + '"',
    'x'.repeat(4097),
  ])
    assert.equal(grants.allows(malformed, '127.0.0.1', sessions), false);
  assert.equal(grants.allows(header, '192.168.1.1', sessions), false);
  assert.equal(grants.allows(header, null, sessions), false);
  const mismatched = grants.issue(id, '192.168.1.1');
  assert.equal(grants.allows('vidvnc-viewer=' + mismatched, '192.168.1.1', sessions), false);
});

test('reissue, revoke, session disconnect, and shutdown invalidate grants', () => {
  const sessions = new SessionStore();
  const id = sessions.connectApproved({ id: 'client-1', generation: 0 }, '127.0.0.1').sessionId;
  const grants = new ViewerAssetGrants();
  const first = grants.issue(id, '127.0.0.1');
  const second = grants.issue(id, '127.0.0.1');
  assert.notEqual(first, second);
  assert.equal(grants.allows('vidvnc-viewer=' + first, '127.0.0.1', sessions), false);
  assert.equal(grants.allows('vidvnc-viewer=' + second, '127.0.0.1', sessions), true);
  grants.revoke(id);
  assert.equal(grants.allows('vidvnc-viewer=' + second, '127.0.0.1', sessions), false);
  const third = grants.issue(id, '127.0.0.1');
  sessions.disconnect(id);
  assert.equal(grants.allows('vidvnc-viewer=' + third, '127.0.0.1', sessions), false);
  grants.clear();
  assert.equal(grants.allows('vidvnc-viewer=' + third, '127.0.0.1', sessions), false);
});

test('viewer cookie is host-only, path-limited, HTTP-only and secure only on HTTPS', () => {
  const value = 'a'.repeat(43);
  assert.equal(
    viewerCookie(value, true),
    'vidvnc-viewer=' + value + '; Path=/viewer; HttpOnly; SameSite=Strict; Secure',
  );
  assert.equal(
    viewerCookie(value, false),
    'vidvnc-viewer=' + value + '; Path=/viewer; HttpOnly; SameSite=Strict',
  );
  assert.equal(
    clearViewerCookie(true),
    'vidvnc-viewer=; Path=/viewer; HttpOnly; SameSite=Strict; Max-Age=0; Secure',
  );
});
