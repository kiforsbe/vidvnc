import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_FILENAME,
  describeTrust,
  detectPlatform,
  groupFingerprint,
  secureAddress,
} from '../src/trust-model.js';
import { authorityNote, instructionsFor, reissueNote } from '../src/trust-instructions.js';

// Real user-agent strings, so detection is pinned against what browsers actually send.
const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ Safari asks for the desktop site by default and reports a Mac.
  ipadAsMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  ipadLegacy:
    'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  unrecognised: 'SomeBrowser/1.0 (Toaster OS)',
};

const FP =
  'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90';

test('detects each platform from its own user agent', () => {
  const cases = [
    [UA.iphoneSafari, 0, 'ios'],
    [UA.iphoneChrome, 0, 'ios'],
    [UA.ipadLegacy, 5, 'ios'],
    [UA.ipadAsMac, 5, 'ios'],
    [UA.androidChrome, 5, 'android'],
    [UA.androidFirefox, 5, 'android'],
    [UA.windowsEdge, 0, 'windows'],
    [UA.windowsChrome, 10, 'windows'],
    [UA.macSafari, 0, 'macos'],
    [UA.linuxFirefox, 0, 'linux'],
    [UA.chromeOs, 0, 'other'],
    [UA.unrecognised, 0, 'other'],
  ];
  for (const [userAgent, maxTouchPoints, expected] of cases)
    assert.equal(detectPlatform({ userAgent, maxTouchPoints }), expected, userAgent);
});

test('an iPad that reports a Mac is told apart from a real Mac only by touch capability', () => {
  assert.equal(detectPlatform({ userAgent: UA.ipadAsMac, maxTouchPoints: 5 }), 'ios');
  assert.equal(detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: 0 }), 'macos');
  assert.equal(detectPlatform({ userAgent: UA.macSafari }), 'macos');
});

test('Android is not mistaken for Linux, though its user agent says Linux', () => {
  assert.equal(detectPlatform({ userAgent: UA.androidChrome, maxTouchPoints: 5 }), 'android');
});

test('detection is total: missing or odd input gives the generic platform, never a throw', () => {
  for (const input of [
    undefined,
    null,
    {},
    { userAgent: null },
    { userAgent: 42 },
    { userAgent: '' },
  ])
    assert.equal(detectPlatform(input), 'other');
  assert.equal(detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: 'lots' }), 'macos');
});

test('every platform id detection can return has instructions', () => {
  for (const userAgent of Object.values(UA)) {
    const id = detectPlatform({ userAgent, maxTouchPoints: 0 });
    assert.equal(instructionsFor(id).id, id);
  }
});

test('grouping the fingerprint never changes a character: the groups concatenate to the reported value', () => {
  const groups = groupFingerprint(FP);
  assert.equal(groups.join(''), FP);
  assert.equal(groups.length, 8);
  for (const group of groups)
    assert.ok(group.length <= 12, 'chunks small enough to compare by eye');
  assert.equal(groupFingerprint(FP.toLowerCase()).join(''), FP.toLowerCase());
});

test('a value that is not a SHA-256 colon-hex fingerprint is not grouped', () => {
  for (const bad of [
    null,
    undefined,
    '',
    'nope',
    FP.slice(0, -3),
    `${FP}:00`,
    FP.replaceAll(':', ''),
    7,
  ])
    assert.equal(groupFingerprint(bad), null, String(bad));
});

test('the secure address is built from the hostname and the reported port only', () => {
  assert.equal(
    secureAddress({ hostname: '192.168.1.20', httpsPort: 4383 }),
    'https://192.168.1.20:4383/',
  );
  assert.equal(
    secureAddress({ hostname: 'host.example', httpsPort: 8443 }),
    'https://host.example:8443/',
  );
  assert.equal(secureAddress({ hostname: '[::1]', httpsPort: 4383 }), 'https://[::1]:4383/');
});

test('the port is omitted when it is 443', () => {
  assert.equal(
    secureAddress({ hostname: '192.168.1.20', httpsPort: 443 }),
    'https://192.168.1.20/',
  );
});

test('no address is offered without a usable hostname and port', () => {
  for (const port of [null, undefined, 0, -1, 70000, 4383.5, '4383', NaN])
    assert.equal(secureAddress({ hostname: '192.168.1.20', httpsPort: port }), null, String(port));
  for (const hostname of ['', null, undefined, 'a b', 'host/evil', 'user@host'])
    assert.equal(secureAddress({ hostname, httpsPort: 4383 }), null, String(hostname));
});

// --- the state matrix -------------------------------------------------------------------

const ok = (body) => ({ httpStatus: 200, body });
const CONTEXT = { hostname: '192.168.1.20' };
const requiredBody = (extra = {}) => ({
  active: true,
  enrolmentStatus: 'required',
  strategy: 'windows-self-signed',
  fingerprint: FP,
  httpsPort: 4383,
  message: 'server sentence',
  download: '/api/trust/anchor',
  ...extra,
});

test('required: shows the fingerprint exactly as reported, asks for the comparison, offers the download and the install steps', () => {
  const view = describeTrust(ok(requiredBody()), CONTEXT);
  assert.equal(view.state, 'required');
  assert.equal(view.fingerprint.text, FP);
  assert.equal(view.fingerprint.groups.join(''), FP);
  assert.match(view.compare, /host/i);
  assert.match(view.compare, /match/i);
  assert.deepEqual(view.download, { href: '/api/trust/anchor', filename: ANCHOR_FILENAME });
  assert.equal(view.showInstructions, true);
  assert.equal(view.secure.href, 'https://192.168.1.20:4383/');
  assert.equal(view.strategy, 'windows-self-signed');
  assert.equal(view.retry, false);
});

test('unknown: nothing to install, points at the administrator, still shows the fingerprint and the secure address', () => {
  const view = describeTrust(
    ok(requiredBody({ enrolmentStatus: 'unknown', strategy: 'provided', download: undefined })),
    CONTEXT,
  );
  assert.equal(view.state, 'unknown');
  assert.equal(view.download, null);
  assert.equal(view.showInstructions, false);
  assert.equal(view.compare, null);
  assert.match(view.message, /nothing to install/i);
  assert.match(view.message, /administrator/i);
  assert.equal(view.fingerprint.text, FP);
  assert.equal(view.secure.href, 'https://192.168.1.20:4383/');
});

test('not-required: says no enrolment is needed, shows the fingerprint and the secure address, offers nothing to install', () => {
  const view = describeTrust(
    ok(requiredBody({ enrolmentStatus: 'not-required', download: undefined })),
    CONTEXT,
  );
  assert.equal(view.state, 'not-required');
  assert.match(view.message, /no enrolment|nothing to install/i);
  assert.equal(view.download, null);
  assert.equal(view.showInstructions, false);
  assert.equal(view.fingerprint.text, FP);
  assert.equal(view.secure.href, 'https://192.168.1.20:4383/');
});

test('inactive: says HTTPS is not running, with no download, no steps, no address and no fingerprint', () => {
  const body = {
    active: false,
    enrolmentStatus: null,
    strategy: null,
    fingerprint: null,
    httpsPort: null,
    message: 'HTTPS is not running on this host, so there is no certificate to install.',
  };
  for (const outcome of [ok(body), { httpStatus: 503, body: { error: 'x' } }]) {
    const view = describeTrust(outcome, CONTEXT);
    assert.equal(view.state, 'inactive');
    assert.match(view.title + view.message, /HTTPS is not running/i);
    assert.equal(view.download, null);
    assert.equal(view.showInstructions, false);
    assert.equal(view.secure, null);
    assert.equal(view.fingerprint, null);
    assert.equal(view.retry, true, 'a host that starts HTTPS later can be re-checked');
  }
});

test('a failed status fetch is a plain recoverable error, never a blank result and never a claim about HTTPS', () => {
  for (const outcome of [
    { httpStatus: null, body: null },
    { httpStatus: 500, body: null },
    { httpStatus: 404, body: { error: 'x' } },
    { httpStatus: 200, body: null },
    { httpStatus: 200, body: 'text' },
    { httpStatus: 200, body: [] },
    { httpStatus: 200, body: {} },
    undefined,
  ]) {
    const view = describeTrust(outcome, CONTEXT);
    assert.equal(view.state, 'error', JSON.stringify(outcome));
    assert.equal(view.retry, true);
    assert.ok(view.title.length > 0 && view.message.length > 0);
    assert.equal(view.download, null);
    assert.equal(view.showInstructions, false);
    assert.equal(view.secure, null);
    assert.doesNotMatch(view.title + view.message, /HTTPS is not running/i);
  }
});

test('no state except required produces a download, even when the response carries one', () => {
  const bodies = {
    unknown: requiredBody({ enrolmentStatus: 'unknown' }),
    'not-required': requiredBody({ enrolmentStatus: 'not-required' }),
    inactive: requiredBody({ active: false, enrolmentStatus: null }),
    unrecognised: requiredBody({ enrolmentStatus: 'surprise' }),
    'no status': requiredBody({ enrolmentStatus: null }),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const view = describeTrust(ok(body), CONTEXT);
    assert.notEqual(view.state, 'required', name);
    assert.equal(view.download, null, name);
    assert.equal(view.showInstructions, false, name);
  }
});

test('required without something safe to offer becomes unavailable, not a broken install page', () => {
  for (const body of [
    requiredBody({ download: undefined }),
    requiredBody({ download: 'https://evil.example/anchor' }),
    requiredBody({ download: '//evil.example/anchor' }),
    requiredBody({ download: '\\\\evil\\anchor' }),
    requiredBody({ download: 7 }),
    requiredBody({ fingerprint: null }),
    requiredBody({ fingerprint: 'not-a-fingerprint' }),
  ]) {
    const view = describeTrust(ok(body), CONTEXT);
    assert.equal(view.state, 'unavailable', JSON.stringify(body));
    assert.equal(view.download, null);
    assert.equal(view.showInstructions, false);
    assert.equal(view.retry, true);
  }
});

test('an unrecognised enrolment status is unavailable rather than guessed at', () => {
  const view = describeTrust(ok(requiredBody({ enrolmentStatus: 'surprise' })), CONTEXT);
  assert.equal(view.state, 'unavailable');
});

test('an active host that reports no usable port offers no secure address, whatever the page was loaded from', () => {
  for (const httpsPort of [null, undefined, 'abc', 0]) {
    const view = describeTrust(ok(requiredBody({ httpsPort })), {
      hostname: '192.168.1.20',
      // Anything else a page could know about itself must not leak into the address.
      port: '4382',
      host: '192.168.1.20:4382',
    });
    assert.equal(view.secure, null, String(httpsPort));
  }
});

test('the secure address uses the reported port, and leaves it out for 443', () => {
  assert.equal(
    describeTrust(ok(requiredBody({ httpsPort: 8443 })), CONTEXT).secure.href,
    'https://192.168.1.20:8443/',
  );
  assert.equal(
    describeTrust(ok(requiredBody({ httpsPort: 443 })), CONTEXT).secure.href,
    'https://192.168.1.20/',
  );
});

test('page text never claims more than is known: no "safe" download, no secure-connection claim', () => {
  const texts = [];
  const collect = (value) => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  const outcomes = [
    ok(requiredBody()),
    ok(requiredBody({ enrolmentStatus: 'unknown' })),
    ok(requiredBody({ enrolmentStatus: 'not-required' })),
    ok(requiredBody({ active: false, enrolmentStatus: null })),
    ok(requiredBody({ enrolmentStatus: 'surprise' })),
    { httpStatus: null, body: null },
  ];
  for (const outcome of outcomes) {
    const view = describeTrust(outcome, CONTEXT);
    // The address is a URL and the fingerprint hex, not prose.
    collect({
      ...view,
      secure: view.secure && view.secure.label,
      fingerprint: null,
      download: null,
    });
  }
  for (const id of ['ios', 'android', 'windows', 'macos', 'linux', 'other'])
    for (const strategy of ['windows-self-signed', 'mkcert', 'provided'])
      collect(instructionsFor(id, strategy));
  collect(authorityNote('mkcert'));
  for (const strategy of ['windows-self-signed', 'mkcert', 'provided', null])
    collect(reissueNote(strategy));
  assert.ok(texts.length > 50, 'the scan actually covered the page text');
  for (const text of texts) {
    assert.doesNotMatch(text, /\bsafe(ly)?\b/i, text);
    assert.doesNotMatch(
      text,
      /(connection|download|page|site)\s+(is|are)\s+(secure|trusted)/i,
      text,
    );
    assert.doesNotMatch(text, /\byour connection is\b/i, text);
  }
});

// --- wording that stays inside what is known ----------------------------------------------

test('the comparison rule is kept, and what it covers is said honestly and separately', () => {
  const view = describeTrust(ok(requiredBody()), CONTEXT);
  assert.match(view.compare, /if they differ, do not install the certificate/i);
  assert.match(view.compare, /character for character/);
  // What the comparison does not prove, and the check that goes further.
  assert.match(view.compareScope, /host reports|matches the one on the host/i);
  assert.match(view.compareScope, /does not by itself prove/i);
  assert.match(view.compareScope, /file you download/i);
  assert.match(view.compareScope, /certificate viewer/i);
  assert.match(view.compareScope, /where your device shows one/i);
  for (const state of ['unknown', 'not-required']) {
    const other = describeTrust(ok(requiredBody({ enrolmentStatus: state })), CONTEXT);
    assert.equal(other.compareScope, null, state);
  }
});

test('not-required does not state as fact that every device already trusts the certificate', () => {
  const view = describeTrust(ok(requiredBody({ enrolmentStatus: 'not-required' })), CONTEXT);
  assert.match(view.message, /should accept/i);
  assert.doesNotMatch(view.message, /devices accept|already trusts|always/i);
  assert.match(view.message, /nothing to install/i);
});

test('describing a response never throws: a body that cannot be read becomes the error view', () => {
  const hostile = {
    httpStatus: 200,
    get body() {
      throw new Error('cannot read');
    },
  };
  const trap = {
    httpStatus: 200,
    body: {
      get active() {
        throw new Error('boom');
      },
    },
  };
  for (const outcome of [hostile, trap]) {
    const view = describeTrust(outcome, CONTEXT);
    assert.equal(view.state, 'error');
    assert.equal(view.retry, true);
    assert.equal(view.download, null);
  }
});
