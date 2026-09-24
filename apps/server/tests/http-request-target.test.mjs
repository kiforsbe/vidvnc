import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestTarget } from '../src/http-request-target.mjs';

test('origin-form keeps a double slash as a path and preserves the query', () => {
  assert.deepEqual(parseRequestTarget('//example.test/x?y=1', 'http', '127.0.0.1:4382', 4382), {
    route: '//example.test/x',
    pathAndQuery: '//example.test/x?y=1',
    originForm: true,
  });
});

test('matching absolute-form URL yields only its path and query', () => {
  assert.deepEqual(
    parseRequestTarget('http://127.0.0.1:4382/api/key-start?x=1', 'http', '127.0.0.1:4382', 4382),
    { route: '/api/key-start', pathAndQuery: '/api/key-start?x=1', originForm: false },
  );
});

test('an omitted HTTPS Host port is accepted only on an actual port-443 socket', () => {
  assert.deepEqual(parseRequestTarget('/api/info', 'https', '127.0.0.1', 443), {
    route: '/api/info',
    pathAndQuery: '/api/info',
    originForm: true,
  });
  assert.throws(() => parseRequestTarget('/api/info', 'https', '127.0.0.1', 8443), {
    status: 421,
  });
});

test('unsupported forms and malformed or missing Host are refused', () => {
  for (const target of ['*', '127.0.0.1:4382', '/path#fragment'])
    assert.throws(
      () => parseRequestTarget(target, 'http', '127.0.0.1:4382', 4382),
      (error) => error.status === 400 || error.status === 421,
      target,
    );
  assert.throws(() => parseRequestTarget('/x', 'http', '', 4382), { status: 400 });
  assert.throws(() => parseRequestTarget('/x', 'http', 'evil@127.0.0.1:4382', 4382), {
    status: 400,
  });
});

test('target and Host must agree with the actual socket scheme and port', () => {
  const cases = [
    ['http://evil.example/api/key-start', '127.0.0.1:4382'],
    ['https://127.0.0.1:4382/api/key-start', '127.0.0.1:4382'],
    ['http://127.0.0.1:9999/api/key-start', '127.0.0.1:4382'],
    ['http://127.0.0.1:4382/api/key-start', '127.0.0.1:9999'],
  ];
  for (const [target, host] of cases)
    assert.throws(() => parseRequestTarget(target, 'http', host, 4382), { status: 421 }, target);
});
