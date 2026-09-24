import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DiagnosticsCapabilities } from '../src/diagnostics-capabilities.mjs';
import { createDiagnosticsHttp } from '../src/diagnostics-http.mjs';

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
