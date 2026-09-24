import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDiagnostics, takeDiagnosticsCapability } from '../src/diagnostics-auth.js';

test('diagnostics bootstrap removes the fragment while preserving the selected stream', () => {
  const replaced = [];
  const location = { hash: '#capability=abc', pathname: '/diagnostics', search: '?stream=x' };
  const history = { replaceState: (...args) => replaced.push(args) };
  assert.equal(takeDiagnosticsCapability(location, history), 'abc');
  assert.deepEqual(replaced, [[null, '', '/diagnostics?stream=x']]);
});

test('diagnostics bootstrap gives no authority to a bare or unrelated link', () => {
  const replaced = [];
  const history = { replaceState: (...args) => replaced.push(args) };
  assert.equal(
    takeDiagnosticsCapability({ hash: '', pathname: '/diagnostics', search: '' }, history),
    null,
  );
  assert.equal(
    takeDiagnosticsCapability(
      { hash: '#other=abc', pathname: '/diagnostics', search: '' },
      history,
    ),
    null,
  );
  assert.deepEqual(replaced, [
    [null, '', '/diagnostics'],
    [null, '', '/diagnostics'],
  ]);
});

test('diagnostics fetch sends the capability only as a bearer header', async () => {
  const calls = [];
  await fetchDiagnostics(
    (...args) => {
      calls.push(args);
      return Promise.resolve({ status: 200 });
    },
    'stream x',
    'secret',
    undefined,
  );
  assert.deepEqual(calls, [
    [
      '/api/diagnostics?stream=stream%20x',
      {
        headers: { authorization: 'Bearer secret' },
        signal: undefined,
      },
    ],
  ]);
});
