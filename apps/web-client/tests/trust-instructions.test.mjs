import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../src/trust-model.js';
import {
  PLATFORMS,
  authorityNote,
  instructionsFor,
  reissueNote,
} from '../src/trust-instructions.js';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';

// Everything a user could read for one platform, as one string.
function textOf(instructions) {
  const out = [];
  const walk = (value) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(instructions);
  return out.join('\n');
}
const forUserAgent = (userAgent, maxTouchPoints = 0) =>
  instructionsFor(detectPlatform({ userAgent, maxTouchPoints }));

test('each platform gets its own instructions for its own user agent', () => {
  assert.match(textOf(forUserAgent(IPHONE).install), /VPN & Device Management/);
  assert.match(
    textOf(forUserAgent(MAC, 5).install),
    /VPN & Device Management/,
    'iPad reporting a Mac',
  );
  assert.match(textOf(forUserAgent(ANDROID, 5).install), /Install a certificate/);
  assert.match(textOf(forUserAgent(ANDROID, 5).install), /CA certificate/);
  const windows = textOf(forUserAgent(WINDOWS).install);
  assert.match(windows, /Install Certificate/);
  assert.match(windows, /Current User/);
  assert.match(windows, /Trusted Root Certification Authorities/);
  const mac = textOf(forUserAgent(MAC, 0).install);
  assert.match(mac, /Keychain Access/);
  assert.match(mac, /Always Trust/);
  assert.match(textOf(forUserAgent(LINUX).install), /update-ca-certificates/);
});

test('Windows has the built-in flow and the one-line alternative, and no script to download', () => {
  const windows = instructionsFor('windows');
  const text = textOf(windows);
  assert.match(text, /certutil -user -addstore Root VidVNC-trust\.crt/);
  assert.match(text, /Firefox/);
  assert.match(
    text,
    /enterprise/i,
    'Firefox needs enterprise roots enabled to use the Windows store',
  );
  assert.doesNotMatch(text, /\.ps1/);
});

test('Android says the wording varies and that Chrome uses the system store', () => {
  const text = textOf(instructionsFor('android'));
  assert.match(text, /Security/);
  assert.match(text, /Encryption & credentials/);
  assert.match(text, /vary|differ/i);
  assert.match(text, /Chrome/);
});

test('macOS has the separate trust-setting step as its own action', () => {
  const mac = instructionsFor('macos');
  assert.ok(mac.install.length >= 2, 'adding the certificate and trusting it are separate steps');
  const trust = mac.install.find((phase) => /Always Trust/.test(textOf(phase)));
  assert.ok(trust, 'a phase sets the trust setting');
  assert.equal(trust.required, true);
  assert.match(textOf(mac.install), /login|System/);
});

test('iOS has two separate actions in two Settings screens and marks the second as required', () => {
  const ios = instructionsFor('ios');
  assert.equal(ios.install.length, 2);
  const [profile, trust] = ios.install;
  assert.match(textOf(profile), /VPN & Device Management/);
  assert.match(textOf(profile), /Allow/);
  assert.match(textOf(trust), /Settings/);
  assert.match(textOf(trust), /General/);
  assert.match(textOf(trust), /About/);
  assert.match(textOf(trust), /Certificate Trust Settings/);
  assert.match(textOf(trust), /full trust/i);
  assert.equal(trust.required, true);
  assert.match(trust.title, /required/i);
  assert.notEqual(profile.required, true, 'the first action is not the one that is easy to miss');
  assert.match(profile.title, /1/);
  assert.match(trust.title, /2/);
});

test('iOS says explicitly that installing the profile alone is not enough', () => {
  const ios = instructionsFor('ios');
  assert.match(ios.warning, /not enough/i);
  assert.match(ios.warning, /warning/i);
  assert.match(ios.warning, /profile/i);
});

test('iOS tells the user to use Safari', () => {
  assert.match(textOf(instructionsFor('ios').install), /Safari/);
});

test('an unrecognised platform gets usable generic instructions, not nothing', () => {
  for (const id of ['other', 'not-a-platform', undefined, null, '']) {
    const generic = instructionsFor(id);
    assert.equal(generic.id, 'other');
    assert.ok(generic.install.length >= 1);
    const steps = generic.install.flatMap((phase) => phase.steps);
    assert.ok(steps.length >= 2, 'more than a single sentence');
    const text = textOf(generic);
    assert.match(text, /VidVNC-trust\.crt/, 'names the file');
    assert.match(text, /fingerprint/i, 'points at the fingerprint');
    assert.match(text, /trusted certificate authorities/i);
    assert.match(text, /update-ca-certificates|trust anchor/, 'carries a Linux hint');
    assert.match(text, /Firefox|Chromium/, 'warns about browsers with their own store');
    assert.ok(generic.uninstall.steps.length >= 1);
  }
});

test('Linux gives distribution-specific commands and warns about browsers with their own store', () => {
  const text = textOf(instructionsFor('linux'));
  assert.match(text, /update-ca-certificates/);
  assert.match(text, /trust anchor/);
  assert.match(text, /Firefox/);
  assert.match(text, /Chromium/);
});

test('uninstall instructions exist for every platform, with concrete steps', () => {
  assert.deepEqual(
    PLATFORMS.map((platform) => platform.id),
    ['ios', 'android', 'windows', 'macos', 'linux', 'other'],
  );
  for (const { id } of PLATFORMS) {
    const { uninstall } = instructionsFor(id);
    assert.ok(uninstall.steps.length >= 1, `${id} has removal steps`);
    for (const step of uninstall.steps)
      assert.ok(step.text.trim().length > 10, `${id}: ${step.text}`);
  }
  assert.match(textOf(instructionsFor('ios').uninstall), /Remove Profile/);
  assert.match(textOf(instructionsFor('ios').uninstall), /trust setting/i);
  assert.match(
    textOf(instructionsFor('android').uninstall),
    /User credentials|Trusted credentials/,
  );
  assert.match(textOf(instructionsFor('windows').uninstall), /certmgr\.msc/);
  assert.match(textOf(instructionsFor('windows').uninstall), /certutil -user -delstore Root/);
  assert.match(textOf(instructionsFor('macos').uninstall), /Keychain Access/);
  assert.match(textOf(instructionsFor('macos').uninstall), /Delete/);
  assert.match(
    textOf(instructionsFor('linux').uninstall),
    /update-ca-certificates|trust anchor --remove/,
  );
});

test('every platform is described consistently: a label, install phases with steps, an uninstall', () => {
  for (const { id, label } of PLATFORMS) {
    const instructions = instructionsFor(id);
    assert.ok(label.length > 0);
    assert.equal(instructions.label, label);
    assert.ok(instructions.install.length >= 1, id);
    for (const phase of instructions.install) {
      assert.ok(phase.steps.length >= 1, `${id} phase has steps`);
      for (const step of phase.steps) assert.equal(typeof step.text, 'string');
    }
  }
});

test('the desktop platforms let the user hash the downloaded file against the host screen', () => {
  for (const id of ['windows', 'macos', 'linux']) {
    const { check } = instructionsFor(id);
    assert.ok(check, `${id} has a file check`);
    assert.match(check.command, /VidVNC-trust\.crt/);
    assert.match(check.command, /256/);
  }
  assert.match(
    instructionsFor('windows').check.command,
    /certutil -hashfile VidVNC-trust\.crt SHA256/,
  );
});

test('the reissue consequence is worded by strategy and makes no claim for one it does not know', () => {
  assert.match(reissueNote('windows-self-signed'), /install/i);
  assert.match(reissueNote('windows-self-signed'), /remove/i);
  assert.match(reissueNote('mkcert'), /local certificate authority|local CA/i);
  assert.match(reissueNote('mkcert'), /normally|usually/i);
  assert.equal(reissueNote('provided'), null);
  assert.equal(reissueNote(null), null);
  assert.equal(reissueNote('something-new'), null);
});

// --- how the certificate is identified, by strategy ---------------------------------------

const IDS = ['ios', 'android', 'windows', 'macos', 'linux', 'other'];
const FALLBACK = /SHA-256 fingerprint \(shown above\)/;

test('every platform can be told to match the certificate by its fingerprint, for every strategy', () => {
  for (const strategy of ['windows-self-signed', 'mkcert', 'provided', undefined, null, 'new-one'])
    for (const id of IDS) {
      const { uninstall } = instructionsFor(id, strategy);
      assert.match(textOf(uninstall), FALLBACK, `${id} uninstall (${strategy})`);
    }
  // Install steps that make the person pick a certificate out of a list carry it too.
  for (const strategy of ['windows-self-signed', 'mkcert', 'provided', undefined])
    for (const id of ['ios', 'macos'])
      assert.match(textOf(instructionsFor(id, strategy).install), FALLBACK, `${id} install`);
});

test('the self-signed strategy names its certificate VidVNC, because that is what it is called', () => {
  for (const id of IDS)
    assert.match(textOf(instructionsFor(id, 'windows-self-signed').uninstall), /"VidVNC"/, id);
});

test('mkcert is identified as a certificate issued by mkcert, never as VidVNC, with the name hedged', () => {
  for (const id of IDS) {
    const instructions = instructionsFor(id, 'mkcert');
    const uninstall = textOf(instructions.uninstall);
    assert.match(uninstall, /issued by mkcert/, id);
    assert.match(uninstall, /mkcert <user>@<host>/, id);
    assert.match(uninstall, /can differ/, id);
    assert.doesNotMatch(textOf(instructions), /"VidVNC"|VidVNC certificate|VidVNC profile/, id);
  }
  assert.match(textOf(instructionsFor('ios', 'mkcert').install), /issued by mkcert/);
  assert.match(textOf(instructionsFor('macos', 'mkcert').install), /issued by mkcert/);
});

test('a provided certificate, or a strategy the page does not know, is identified by fingerprint only', () => {
  for (const strategy of ['provided', undefined, null, 'new-one'])
    for (const id of IDS) {
      const instructions = instructionsFor(id, strategy);
      assert.doesNotMatch(textOf(instructions), /"VidVNC"|VidVNC certificate|VidVNC profile/, id);
      assert.doesNotMatch(textOf(instructions), /mkcert/, id);
      assert.match(textOf(instructions.uninstall), /its name can differ/i, id);
    }
});

test('instructionsFor still answers by platform alone, and still falls back to generic', () => {
  assert.equal(instructionsFor('ios').id, 'ios');
  assert.equal(instructionsFor('nope', 'mkcert').id, 'other');
});

test('what mkcert asks a device to trust is said plainly, and only for mkcert', () => {
  const note = authorityNote('mkcert');
  assert.match(note, /certificate authority/i);
  assert.match(note, /any (website|site)/i);
  assert.match(note, /remov/i);
  assert.match(note, /undo/i);
  for (const strategy of ['windows-self-signed', 'provided', null, undefined, 'new-one'])
    assert.equal(authorityNote(strategy), null, String(strategy));
});

// --- what each platform checks before the person trusts anything ---------------------------

test('on desktop the file-hash check is a normal step, not an optional extra', () => {
  for (const id of ['windows', 'macos', 'linux']) {
    const { check } = instructionsFor(id);
    assert.doesNotMatch(check.text, /optional/i, id);
    assert.match(check.text, /do not install/i, id);
    assert.match(check.text, /host/i, id);
    assert.match(check.command, /VidVNC-trust\.crt/, id);
  }
});

test('iOS and Android get a hedged step to compare the fingerprint their own viewer shows', () => {
  for (const id of ['ios', 'android']) {
    const { check } = instructionsFor(id);
    assert.ok(check, `${id} has a check`);
    assert.equal(check.command, null, `${id} has no command to run`);
    assert.match(check.text, /certificate itself|certificate you are about to trust/i, id);
    assert.match(check.text, /SHA-256 fingerprint/, id);
    assert.match(check.text, /if your (device|version)/i, `${id} is hedged, not asserted`);
    assert.match(check.text, /do not install|remove/i, id);
  }
  assert.match(instructionsFor('ios').check.text, /before you tap Install/i);
});

test('the generic entry checks the certificate viewer and mentions the hash commands without running one', () => {
  const { check } = instructionsFor('other');
  assert.match(check.text, /SHA-256 fingerprint/);
  assert.match(check.text, /do not install/i);
  assert.match(check.text, /certutil -hashfile/);
  assert.match(check.text, /sha256sum/);
  assert.equal(check.command, null);
});
