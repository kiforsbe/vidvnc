import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin } from '../../src/tls/origin.mjs';

// Cross product: scheme x host-header port shape x Origin shape. Built as a table rather
// than as individual hand-written tests so the coverage is visibly complete and a missing
// combination shows up as a hole in the matrix rather than as a test nobody thought to write.
const NON_DEFAULT_PORT = '5001';
const OTHER_PORT = '9999';

const SCHEMES = ['http', 'https'];
const DEFAULT_PORT = { http: '80', https: '443' };

// The three shapes a Host header can take: the scheme's default port spelled out, a
// non-default port, and no port at all (the common case).
function portVariants(scheme) {
  const defaultPort = DEFAULT_PORT[scheme];
  return [
    {
      name: 'default port explicit in Host',
      hostHeader: `example.com:${defaultPort}`,
      // A browser omits the port from Origin whenever it is the scheme's default,
      // regardless of how the server's Host header happens to be spelled.
      matchingOrigin: `${scheme}://example.com`,
    },
    {
      name: 'non-default port in Host',
      hostHeader: `example.com:${NON_DEFAULT_PORT}`,
      matchingOrigin: `${scheme}://example.com:${NON_DEFAULT_PORT}`,
    },
    {
      name: 'no port in Host',
      hostHeader: 'example.com',
      matchingOrigin: `${scheme}://example.com`,
    },
  ];
}

function originVariants(scheme, matchingOrigin) {
  const otherScheme = scheme === 'https' ? 'http' : 'https';
  const matchingUrl = new URL(matchingOrigin);
  const matchingPort = matchingUrl.port; // '' when the matching origin omits the port
  return [
    { name: 'Origin matches', originHeader: matchingOrigin, expected: true },
    {
      name: 'Origin differs only by scheme',
      originHeader: `${otherScheme}://example.com${matchingPort ? ':' + matchingPort : ''}`,
      expected: false,
    },
    {
      // OTHER_PORT never coincides with matchingPort ('' or NON_DEFAULT_PORT), so this is
      // always a genuine mismatch.
      name: 'Origin differs only by port',
      originHeader: `${scheme}://example.com:${OTHER_PORT}`,
      expected: false,
    },
    {
      name: 'Origin points at another host',
      originHeader: `${scheme}://attacker.example${matchingPort ? ':' + matchingPort : ''}`,
      expected: false,
    },
    { name: 'Origin absent', originHeader: undefined, expected: true },
  ];
}

test('exhaustive table: scheme x Host port shape x Origin shape', async (t) => {
  for (const scheme of SCHEMES) {
    for (const port of portVariants(scheme)) {
      for (const origin of originVariants(scheme, port.matchingOrigin)) {
        const label = `${scheme}, ${port.name}, ${origin.name}`;
        await t.test(label, () => {
          assert.equal(
            isAllowedOrigin(scheme, port.hostHeader, origin.originHeader),
            origin.expected,
            `isAllowedOrigin(${scheme}, ${port.hostHeader}, ${origin.originHeader}) should be ${origin.expected}`,
          );
        });
      }
    }
  }
});

// The four cases the brief singles out explicitly, pinned as their own tests so they read
// clearly on their own and cannot be lost inside the generated matrix above.

test('an HTTPS request on 443 whose Origin carries no port is accepted', () => {
  assert.equal(isAllowedOrigin('https', 'example.com', 'https://example.com'), true);
  assert.equal(isAllowedOrigin('https', 'example.com:443', 'https://example.com'), true);
});

test('the same request would be rejected by a naive comparison that always appends the port', () => {
  const scheme = 'https';
  const hostHeader = 'example.com';
  const originHeader = 'https://example.com'; // what a real browser sends on the default port
  // Pin the regression this test exists to catch: a naive implementation built as
  // `originHeader === `${scheme}://${hostHeader}:443`` would compare against this string...
  const naiveExpectedOrigin = `${scheme}://${hostHeader}:443`;
  // ...which is not what the browser actually sent, so the naive comparison rejects it.
  assert.notEqual(originHeader, naiveExpectedOrigin);
  // The real implementation must accept it anyway. If isAllowedOrigin regresses to the naive
  // string-equality form, this assertion fails.
  assert.equal(isAllowedOrigin(scheme, hostHeader, originHeader), true);
});

test('an HTTP request whose Origin claims https on the same host is rejected', () => {
  assert.equal(isAllowedOrigin('http', 'example.com', 'https://example.com'), false);
});

test('a request with no Origin header is accepted (pins current behaviour; not changed by this task)', () => {
  assert.equal(isAllowedOrigin('http', 'example.com', undefined), true);
  assert.equal(isAllowedOrigin('https', 'example.com', undefined), true);
});
