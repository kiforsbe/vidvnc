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

// Review round 1, Important 1: the table above never gives `new URL()` anything it fails
// to parse, so the catch branch — "malformed Origin rejects" — was correct but completely
// unpinned. These two tables put attacker-controlled malformed input (Origin and Host,
// both client-supplied) through the same structural, cross-producted style rather than
// one-off tests, specifically so that (a) flipping the catch to `return true` and (b)
// removing the try/catch entirely each turn at least one row red. Both mutations were
// performed by hand against this file and confirmed red; see the fix report appended to
// task-8-report.md for the failing test names from each run.

const MALFORMED_ORIGIN_SHAPES = [
  { name: 'not a URL at all', build: () => 'not-a-url' },
  // The real value browsers send for an opaque origin (a sandboxed iframe, a `file:`
  // document, a redirect from one). It is not a URL, so it must reject, not be special-cased.
  { name: 'the literal string "null"', build: () => 'null' },
  { name: 'a scheme with no authority', build: (scheme) => `${scheme}://` },
  { name: 'whitespace embedded in the host', build: (scheme) => `${scheme}://exam ple.com` },
  {
    name: 'a control character embedded in the host',
    build: (scheme) => `${scheme}://exam\u0001ple.com`,
  },
];

test('malformed Origin headers are rejected, not silently accepted or thrown into the caller', async (t) => {
  for (const scheme of SCHEMES) {
    for (const shape of MALFORMED_ORIGIN_SHAPES) {
      const originHeader = shape.build(scheme);
      await t.test(`${scheme}, ${shape.name}`, () => {
        assert.equal(
          isAllowedOrigin(scheme, 'example.com', originHeader),
          false,
          `isAllowedOrigin(${scheme}, example.com, ${JSON.stringify(originHeader)}) should be false`,
        );
      });
    }
  }
});

// Host is attacker-influenced too (it is just a request header). Each shape is paired with
// the Origin value that makes its handling legible: a well-formed matching Origin where one
// exists, and the absent-Origin short-circuit to confirm that path never even looks at Host.
const MALFORMED_HOST_CASES = (scheme) => [
  {
    name: 'empty Host, Origin present: expected-origin construction fails, so this rejects',
    hostHeader: '',
    originHeader: `${scheme}://example.com`,
    expected: false,
  },
  {
    name: 'empty Host, Origin absent: the absent-Origin short-circuit never parses Host at all',
    hostHeader: '',
    originHeader: undefined,
    expected: true,
  },
  {
    name: 'bare ":443" Host, Origin present: no host to parse, so this rejects',
    hostHeader: ':443',
    originHeader: `${scheme}://example.com`,
    expected: false,
  },
  {
    name: 'bare ":443" Host, Origin absent: short-circuits before Host is touched',
    hostHeader: ':443',
    originHeader: undefined,
    expected: true,
  },
  {
    // request.headers.host is undefined when a request omits Host entirely (HTTP/1.0).
    // `${scheme}://${hostHeader}` stringifies this to the literal host "undefined", which
    // parses as an ordinary (if useless) hostname rather than throwing. In the real request
    // path this is already unreachable past the host allow-list check on the line above,
    // which this task does not touch — this row exists only to pin that the pure function
    // itself never throws or silently accepts just because Host was never sent.
    name: 'absent Host header, Origin present and matching the literal string "undefined"',
    hostHeader: undefined,
    originHeader: `${scheme}://undefined`,
    expected: true,
  },
  {
    name: 'absent Host header, Origin present but pointing elsewhere',
    hostHeader: undefined,
    originHeader: `${scheme}://example.com`,
    expected: false,
  },
  {
    name: 'absent Host header, Origin absent: short-circuits before Host is touched',
    hostHeader: undefined,
    originHeader: undefined,
    expected: true,
  },
  {
    // Review round 1, Important 2: userinfo in Host is stripped by URL parsing and never
    // reaches the hostname/port comparison, so it cannot smuggle a mismatch past the guard.
    name: 'Host decorated with userinfo, clean matching Origin: userinfo is inert',
    hostHeader: 'attacker@example.com',
    originHeader: `${scheme}://example.com`,
    expected: true,
  },
  {
    // Review round 1, Important 2, divergence #2: the old code string-compared the raw Host
    // header, so a path/query on Host could never match a clean Origin (browsers never send
    // a path in Origin). URL parsing strips the decoration from Host before comparing, so
    // this now accepts. Reviewed and accepted: the hostname-equality gate still holds, and a
    // browser cannot set Host from script (`fetch`/XHR treat it as a forbidden header name);
    // a non-browser client that could set it is not constrained by this guard regardless,
    // since it could just omit Origin, which both old and new code allow.
    name: 'Host decorated with a path, clean matching Origin: accepted (documented divergence)',
    hostHeader: 'example.com/foo',
    originHeader: `${scheme}://example.com`,
    expected: true,
  },
  {
    name: 'Host decorated with a query string, clean matching Origin: accepted (same divergence)',
    hostHeader: 'example.com?x=1',
    originHeader: `${scheme}://example.com`,
    expected: true,
  },
  {
    name: 'bracketed IPv6 Host with an explicit non-default port, Origin matches',
    hostHeader: `[::1]:${NON_DEFAULT_PORT}`,
    originHeader: `${scheme}://[::1]:${NON_DEFAULT_PORT}`,
    expected: true,
  },
  {
    // Confirms the default-port fix this task exists for also applies to IPv6 literals, not
    // just named hosts.
    name: 'bracketed IPv6 Host on the default port, Origin omits the port like a real browser would',
    hostHeader: `[::1]:${DEFAULT_PORT[scheme]}`,
    originHeader: `${scheme}://[::1]`,
    expected: true,
  },
];

test('malformed and decorated Host headers are handled predictably', async (t) => {
  for (const scheme of SCHEMES) {
    for (const testCase of MALFORMED_HOST_CASES(scheme)) {
      await t.test(`${scheme}, ${testCase.name}`, () => {
        assert.equal(
          isAllowedOrigin(scheme, testCase.hostHeader, testCase.originHeader),
          testCase.expected,
          `isAllowedOrigin(${scheme}, ${JSON.stringify(testCase.hostHeader)}, ${JSON.stringify(testCase.originHeader)}) should be ${testCase.expected}`,
        );
      });
    }
  }
});

// Review round 1, Important 2, divergences #1 and #3: hostname case and an inert trailing
// slash on Origin. Both are safe (DNS is case-insensitive; browsers never send a path in
// Origin) but were unenumerated in the original table. Pinned explicitly here.
test('hostname case differences and an inert trailing slash on Origin are accepted', async (t) => {
  for (const scheme of SCHEMES) {
    const cases = [
      {
        name: 'uppercase Host, lowercase Origin',
        hostHeader: 'EXAMPLE.com',
        originHeader: `${scheme}://example.com`,
      },
      {
        name: 'lowercase Host, uppercase Origin',
        hostHeader: 'example.com',
        originHeader: `${scheme}://EXAMPLE.com`,
      },
      {
        name: 'Origin with a trailing slash (browsers never send one; inert)',
        hostHeader: 'example.com',
        originHeader: `${scheme}://example.com/`,
      },
    ];
    for (const testCase of cases) {
      await t.test(`${scheme}, ${testCase.name}`, () => {
        assert.equal(isAllowedOrigin(scheme, testCase.hostHeader, testCase.originHeader), true);
      });
    }
  }
});
