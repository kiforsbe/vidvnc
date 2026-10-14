import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DiagnosticsCapabilities } from '../src/diagnostics-capabilities.mjs';
import { createDiagnosticsHttp } from '../src/diagnostics-http.mjs';
import { LatencyProbes } from '../src/latency-probes.mjs';

test('private diagnostics listener is loopback-only and bearer-gates live data', async (t) => {
  let now = 1_000;
  const capabilities = new DiagnosticsCapabilities({ clock: () => now });
  const token = capabilities.issue().token;
  const server = createDiagnosticsHttp({
    diagnosticsCapabilities: capabilities,
    diagnostics: { snapshot: () => ({ label: 'private-stream-label' }) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/diagnostics')).status, 200);
  for (const asset of [
    '/diagnostics.js',
    '/diagnostics-auth.js',
    '/diagnostics.css',
    '/codec-preferences.js',
    '/profile-labels.js',
    '/latency-report.js',
    '/latency-probe-page.js',
    '/viewer/latency-probe.js',
  ])
    assert.equal((await fetch(base + asset)).status, 200, asset);
  assert.equal((await fetch(base + '/')).status, 404);
  assert.equal((await fetch(base + '/api/info')).status, 404);
  assert.equal((await fetch(base + '/api/diagnostics')).status, 403);
  assert.equal((await fetch(base + `/api/diagnostics?capability=${token}`)).status, 403);
  assert.equal(
    (await fetch(base + '/api/diagnostics', { headers: { cookie: `capability=${token}` } })).status,
    403,
  );
  const allowed = await fetch(base + '/api/diagnostics', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).label, 'private-stream-label');
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(
      base + '/api/diagnostics',
      {
        headers: { host: 'remote.example', authorization: `Bearer ${token}` },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(wrongHost, 403);
  now += 900_000;
  assert.equal(
    (await fetch(base + '/api/diagnostics', { headers: { authorization: `Bearer ${token}` } }))
      .status,
    403,
  );
});

test('Diagnostics starts a latency measurement for a live stream, one at a time', async (t) => {
  const capabilities = new DiagnosticsCapabilities();
  const token = capabilities.issue().token;
  const streams = {
    live: { sessionId: 's1', kind: 'video', state: 'live' },
    other: { sessionId: 's2', kind: 'video', state: 'live' },
    starting: { sessionId: 's1', kind: 'video', state: 'starting' },
  };
  const runtime = {
    diagnosticStreams: () => Object.keys(streams).map((id) => ({ id, label: id, state: 'live' })),
    diagnostics: () => null,
    registry: { subscription: (id) => streams[id] ?? null },
  };
  const latencyProbes = new LatencyProbes({
    isLive: (sessionId, streamId) =>
      streams[streamId]?.sessionId === sessionId && streams[streamId].state === 'live',
  });
  const server = createDiagnosticsHttp({
    diagnosticsCapabilities: capabilities,
    runtime,
    latencyProbes,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const measure = (body, { bearer = true, origin = base } = {}) =>
    fetch(base + '/api/diagnostics/latency-probe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const snapshot = (stream) =>
    fetch(`${base}/api/diagnostics?stream=${stream}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json());

  assert.equal((await measure({ streamId: 'live' }, { bearer: false })).status, 403);
  assert.equal((await measure({ streamId: 'live' }, { origin: null })).status, 403);
  assert.equal(
    (await measure({ streamId: 'live' }, { origin: 'http://evil.example' })).status,
    403,
  );
  assert.equal((await measure({ streamId: 'missing' })).status, 404);
  assert.equal((await measure({ streamId: 'starting' })).status, 404, 'not live');
  assert.equal((await measure('not json')).status, 400);
  assert.equal((await measure({ streamId: 7 })).status, 400);
  assert.equal((await measure({ streamId: 'live', pad: 'x'.repeat(1024) })).status, 413);
  assert.equal(latencyProbes.snapshot('live').active, null, 'nothing started so far');

  const started = await measure({ streamId: 'live' });
  assert.equal(started.status, 202);
  const { id, state } = await started.json();
  assert.equal(state, 'requested');
  const busy = await measure({ streamId: 'other' });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'A measurement is already running' });

  assert.deepEqual((await snapshot('live')).latencyProbe.active.id, id);
  assert.deepEqual((await snapshot('other')).latencyProbe, { active: null, history: [] });
  assert.equal(
    (
      await fetch(base + '/api/diagnostics', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, origin: base },
      })
    ).status,
    405,
    'the snapshot route stays GET-only',
  );

  const cancel = (body, { bearer = true, origin = base } = {}) =>
    fetch(base + '/api/diagnostics/latency-probe/cancel', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  assert.equal((await cancel({ id }, { bearer: false })).status, 403);
  assert.equal((await cancel({ id }, { origin: null })).status, 403);
  assert.equal((await cancel({ id }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await cancel('not json')).status, 400);
  assert.equal((await cancel({ id: 7 })).status, 400);
  assert.equal((await cancel({ id, extra: 1 })).status, 400);
  assert.equal((await cancel({ id, pad: 'x'.repeat(1024) })).status, 413);
  assert.equal((await cancel({ id: 'not-this-one' })).status, 404);
  assert.equal(latencyProbes.snapshot('live').active.id, id, 'still running so far');
  assert.equal(
    (await fetch(base + '/api/diagnostics/latency-probe/cancel')).status,
    405,
    'POST only',
  );
  assert.equal((await cancel({ id })).status, 204);
  const cancelled = (await snapshot('live')).latencyProbe;
  assert.equal(cancelled.active, null);
  assert.equal(cancelled.history[0].reason, 'host-cancelled');
  assert.equal((await cancel({ id })).status, 404, 'already ended');
});
