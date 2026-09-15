# CLI Configuration Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every setting the WinUI host can change is changeable from the CLI server, both as live console commands and as offline `config` subcommands.

**Architecture:** One command table (`apps/server/src/cli/commands.mjs`) runs against a context interface. A live context wraps the running `PolicyController`, `AccessSettings`, `DisplayInventory` and `StreamRuntime`; an offline context opens the settings stores directly and refuses writes while a server instance is registered. Pure policy edit functions and selector resolution keep the command handlers small and testable.

**Tech Stack:** Node.js ESM (>=20.6), `node:test`, `node:assert/strict`, existing server stores. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-cli-configuration-parity-design.md`

## Global Constraints

- Node ESM, no new npm dependencies. Prettier style: single quotes, 100-column lines, 2-space indent. Run `npm run format:web` in the final task.
- A session's `sessionId` is its bearer credential. It must never appear in CLI output, errors, prompts or JSON.
- The `--desktop` owner-pipe protocol and HTTP routes are unchanged. No new network or IPC administration channel.
- Bitrates are entered as whole kbit/s; output shows Mbit/s.
- Offline exit codes: `0` success, `1` failure, `2` usage error.
- Do **not** run `git commit`. The user commits on request. Each task ends with the change left uncommitted.
- Run only the test files a task touches: `node --test apps/server/tests/<file>`. The final task runs the server suite once.
- Plan refinement of the spec's context interface: `updatePolicy(summary, edit, { yes })` replaces `savePolicy(candidate, { confirmDisconnect })`, because the spec requires the candidate to be rebuilt from the current policy after confirmation. Small helper modules not named in the spec: `cli/usage-error.mjs`, `cli/conflict-advice.mjs`, `instances.mjs`, and the test fixture `tests/fixtures/cli-displays.mjs`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/paths.mjs` (new) | Data folder and settings file locations |
| `apps/server/src/instances.mjs` (new) | Register the running server; list live registered instances |
| `apps/server/src/profile-order.mjs` (modify) | Add validated atomic `saveProfileOrder` |
| `apps/server/src/cli/usage-error.mjs` (new) | `UsageError` class (exit 2, help hint) |
| `apps/server/src/cli/tokenize.mjs` (new) | Quote-aware line splitting |
| `apps/server/src/cli/policy-edits.mjs` (new) | Pure policy candidate builders, first-run sharing seed |
| `apps/server/src/cli/resolve.mjs` (new) | Display/profile/session selectors, `SessionNumbers` |
| `apps/server/src/cli/format.mjs` (new) | Tables, labels, section formatters |
| `apps/server/src/cli/conflict-advice.mjs` (new) | Append mode advice to store conflict errors |
| `apps/server/src/cli/arguments.mjs` (new) | Flag parsing, argument counts, `on`/`off`, sizes, whole numbers |
| `apps/server/src/cli/commands.mjs` (new) | Command table assembly, `execute`, `executeLine`, help |
| `apps/server/src/cli/commands/settings.mjs` (new) | `displays`, `share`, `display-default`, `default-profile`, `audio`, `access` |
| `apps/server/src/cli/commands/profiles.mjs` (new) | `profiles`, `profile …`, `client-mode`, `options …`, `show` |
| `apps/server/src/cli/commands/sessions.mjs` (new) | `sessions`, `grant`, `revoke`, `stop`, `disconnect` (live only) |
| `apps/server/src/cli/offline.mjs` (new) | Offline context and `runOffline` |
| `apps/server/src/cli/console.mjs` (new) | Live context and readline console |
| `apps/server/src/main.mjs` (modify) | `config` dispatch, shared paths/seed, instance registration, console |
| `apps/server/tests/fixtures/cli-displays.mjs` (new) | Three-display inventory fixture |
| `apps/server/tests/instances.test.mjs` (new) | Paths and instance registry |
| `apps/server/tests/profile-order.test.mjs` (modify) | `saveProfileOrder` |
| `apps/server/tests/cli-tokenize.test.mjs` (new) | Tokenizer |
| `apps/server/tests/cli-policy-edits.test.mjs` (new) | Edit functions |
| `apps/server/tests/cli-resolve.test.mjs` (new) | Selectors |
| `apps/server/tests/cli-commands.test.mjs` (new) | Commands through the offline context |
| `apps/server/tests/cli-console.test.mjs` (new) | Live context, confirmation, sessions |
| `apps/server/tests/cli-offline.test.mjs` (new) | `main.mjs config …` subprocesses |
| `apps/server/tests/cli-parity.test.mjs` (new) | Every editable field has a command |
| `apps/server/tests/runtime-start-check.mjs` (modify) | Hardware check asserts instance file lifecycle |
| `package.json`, `README.md` (modify) | `npm run config` script, CLI documentation |

---

### Task 1: Settings paths and instance registry

**Files:**
- Create: `apps/server/src/paths.mjs`
- Create: `apps/server/src/instances.mjs`
- Test: `apps/server/tests/instances.test.mjs`

**Interfaces:**
- Produces: `dataDirectory({ env?, platform?, home? }) -> string`; `settingsFiles(directory) -> { policy, access, profileOrder, instances }`; `registerInstance(folder, { mode, port, pid?, now? }) -> release(): void`; `isAlive(pid, kill?) -> boolean`; `runningInstances(folder, { alive? }) -> Array<{ pid, file, mode, port }>`

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/instances.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory, settingsFiles } from '../src/paths.mjs';
import { isAlive, registerInstance, runningInstances } from '../src/instances.mjs';

test('settings live in the per-user VidVNC data folder', () => {
  assert.equal(
    dataDirectory({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\u' }),
    join('C:\\Users\\u\\AppData\\Local', 'VidVNC'),
  );
  assert.equal(
    dataDirectory({ env: {}, platform: 'win32', home: 'C:\\Users\\u' }),
    join('C:\\Users\\u', 'AppData', 'Local', 'VidVNC'),
  );
  assert.equal(
    dataDirectory({ env: {}, platform: 'darwin', home: '/Users/u' }),
    join('/Users/u', 'Library', 'Application Support', 'VidVNC'),
  );
  assert.deepEqual(settingsFiles('D'), {
    policy: join('D', 'stream-policy.json'),
    access: join('D', 'access-settings.json'),
    profileOrder: join('D', 'profile-order.json'),
    instances: join('D', 'instances'),
  });
});

test('registered instances are listed while alive and removed on release', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-instances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, 'instances');
  assert.deepEqual(runningInstances(folder), []);
  const release = registerInstance(folder, { mode: 'cli', port: 4382, pid: 4242, now: 1000 });
  assert.deepEqual(JSON.parse(await readFile(join(folder, '4242.json'), 'utf8')), {
    pid: 4242,
    startedAt: 1000,
    mode: 'cli',
    port: 4382,
  });
  assert.deepEqual(runningInstances(folder, { alive: (pid) => pid === 4242 }), [
    { pid: 4242, file: join(folder, '4242.json'), mode: 'cli', port: 4382 },
  ]);
  assert.deepEqual(runningInstances(folder, { alive: () => false }), []);
  release();
  release();
  assert.deepEqual(await readdir(folder), []);
});

test('unrelated files are skipped and unreadable files still mark a live PID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-instances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, 'instances');
  await mkdir(folder);
  await writeFile(join(folder, 'notes.txt'), 'x');
  await writeFile(join(folder, '77.json'), '{broken');
  assert.deepEqual(runningInstances(folder, { alive: () => true }), [
    { pid: 77, file: join(folder, '77.json'), mode: 'unknown', port: null },
  ]);
});

test('isAlive treats EPERM as running and other failures as gone', () => {
  const failing = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(isAlive(1, () => true), true);
  assert.equal(isAlive(1, failing('EPERM')), true);
  assert.equal(isAlive(1, failing('ESRCH')), false);
  assert.equal(isAlive(process.pid), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/instances.test.mjs`
Expected: FAIL with `Cannot find module '...src/paths.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/paths.mjs`:

```js
import { homedir } from 'node:os';
import { join } from 'node:path';

// Per-user mutable settings, shared by the CLI server and the Windows host.
export function dataDirectory({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  return platform === 'win32'
    ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'VidVNC')
    : join(home, 'Library', 'Application Support', 'VidVNC');
}

export function settingsFiles(directory) {
  return {
    policy: join(directory, 'stream-policy.json'),
    access: join(directory, 'access-settings.json'),
    profileOrder: join(directory, 'profile-order.json'),
    instances: join(directory, 'instances'),
  };
}
```

Create `apps/server/src/instances.mjs`:

```js
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Lets offline config commands detect a running server. A stale file (dead PID)
// is ignored; PID reuse can only cause a refusal, which fails safe.
export function registerInstance(folder, { mode, port, pid = process.pid, now = Date.now() }) {
  const file = join(folder, `${pid}.json`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, JSON.stringify({ pid, startedAt: now, mode, port }), { mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(file, { force: true });
  };
}

export function isAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function runningInstances(folder, { alive = isAlive } = {}) {
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const name of names.sort()) {
    const match = /^([1-9]\d{0,9})\.json$/.exec(name);
    if (!match || !alive(Number(match[1]))) continue;
    const file = join(folder, name);
    let details = {};
    try {
      details = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // An unreadable record still marks a live PID as running.
    }
    rows.push({
      pid: Number(match[1]),
      file,
      mode: typeof details.mode === 'string' ? details.mode : 'unknown',
      port: Number.isInteger(details.port) ? details.port : null,
    });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/server/tests/instances.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Leave uncommitted**

No commit (Global Constraints). Confirm with `git status --short` that only the three files above are new.

---

### Task 2: Save profile order

**Files:**
- Modify: `apps/server/src/profile-order.mjs`
- Test: `apps/server/tests/profile-order.test.mjs`

**Interfaces:**
- Consumes: existing `applyProfileOrder(filename, profiles)`
- Produces: `validProfileOrder(ids) -> boolean`; `saveProfileOrder(filename, ids) -> Promise<void>` (throws `Error('Invalid profile ordering')`)

- [ ] **Step 1: Write the failing test**

In `apps/server/tests/profile-order.test.mjs`, change the import line to:

```js
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
```

and

```js
import { applyProfileOrder, saveProfileOrder } from '../src/profile-order.mjs';
```

Append:

```js
test('saved profile order uses host validation, replaces atomically and round-trips', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'nested', 'profile-order.json');
  const profiles = [{ id: 'mobile' }, { id: 'balanced' }, { id: 'desktop' }];
  await saveProfileOrder(file, ['desktop', 'mobile']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), ['desktop', 'mobile']);
  assert.deepEqual(
    (await applyProfileOrder(file, profiles)).map((p) => p.id),
    ['desktop', 'mobile', 'balanced'],
  );
  for (const invalid of [
    ['mobile', 'mobile'],
    ['bad id'],
    [''],
    ['x'.repeat(65)],
    Array.from({ length: 65 }, (_, i) => `p${i}`),
    'mobile',
  ])
    await assert.rejects(saveProfileOrder(file, invalid), /Invalid profile ordering/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), ['desktop', 'mobile']);
  assert.deepEqual(await readdir(join(directory, 'nested')), ['profile-order.json']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/profile-order.test.mjs`
Expected: FAIL with `saveProfileOrder` not exported (SyntaxError on import).

- [ ] **Step 3: Write minimal implementation**

Replace `apps/server/src/profile-order.mjs` with:

```js
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Same rules as the host's ProfileOrderStore.
export function validProfileOrder(ids) {
  return (
    Array.isArray(ids) &&
    ids.length <= 64 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id))
  );
}

// Same presentation-only preference as the native host; never changes policy.
export async function applyProfileOrder(filename, profiles) {
  if (!filename) return profiles;
  let file;
  try {
    file = await open(filename, 'r');
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) return profiles;
    const ids = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    if (!validProfileOrder(ids)) return profiles;
    const available = new Map(profiles.map((profile) => [profile.id, profile]));
    return [
      ...ids.filter((id) => available.has(id)).map((id) => available.get(id)),
      ...profiles.filter((profile) => !ids.includes(profile.id)),
    ];
  } catch {
    // Missing/corrupt cosmetic preferences must not prevent a connection.
    return profiles;
  } finally {
    await file?.close();
  }
}

export async function saveProfileOrder(filename, ids) {
  if (!validProfileOrder(ids)) throw new Error('Invalid profile ordering');
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(JSON.stringify(ids));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/server/tests/profile-order.test.mjs`
Expected: PASS, 2 tests (existing test unchanged).

- [ ] **Step 5: Leave uncommitted**

No commit.

---

### Task 3: Usage errors and tokenizer

**Files:**
- Create: `apps/server/src/cli/usage-error.mjs`
- Create: `apps/server/src/cli/tokenize.mjs`
- Test: `apps/server/tests/cli-tokenize.test.mjs`

**Interfaces:**
- Produces: `class UsageError extends Error`; `MAX_LINE = 1024`; `tokenize(line: string) -> string[]` (throws `UsageError`)

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/cli-tokenize.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINE, tokenize } from '../src/cli/tokenize.mjs';
import { UsageError } from '../src/cli/usage-error.mjs';

test('tokenize splits on whitespace and keeps quoted text together', () => {
  assert.deepEqual(tokenize('  profile add "Office desk"  --fps 60 '), [
    'profile',
    'add',
    'Office desk',
    '--fps',
    '60',
  ]);
  assert.deepEqual(tokenize('profile edit x --description ""'), [
    'profile',
    'edit',
    'x',
    '--description',
    '',
  ]);
  assert.deepEqual(tokenize('name "say \\"hi\\" \\\\ ok"'), ['name', 'say "hi" \\ ok']);
  assert.deepEqual(tokenize('path C:\\temp'), ['path', 'C:\\temp']);
  assert.deepEqual(tokenize('a"b c"d'), ['ab cd']);
  assert.deepEqual(tokenize('\t'), []);
});

test('tokenize rejects unterminated quotes and overlong lines as usage errors', () => {
  assert.throws(
    () => tokenize('profile add "Office'),
    (error) => error instanceof UsageError && error.message === 'Unterminated quote.',
  );
  assert.throws(
    () => tokenize('x'.repeat(MAX_LINE + 1)),
    (error) =>
      error instanceof UsageError && error.message === 'Commands are limited to 1024 characters.',
  );
  assert.deepEqual(tokenize('x'.repeat(MAX_LINE)), ['x'.repeat(MAX_LINE)]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/cli-tokenize.test.mjs`
Expected: FAIL with `Cannot find module '...src/cli/tokenize.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/cli/usage-error.mjs`:

```js
// Syntax or argument mistakes: offline exit code 2 and a help hint.
export class UsageError extends Error {}
```

Create `apps/server/src/cli/tokenize.mjs`:

```js
import { UsageError } from './usage-error.mjs';

export const MAX_LINE = 1024;

// Double quotes group text; inside quotes, \" and \\ are escapes. Never evaluated.
export function tokenize(line) {
  if (line.length > MAX_LINE)
    throw new UsageError(`Commands are limited to ${MAX_LINE} characters.`);
  const tokens = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted && character === '\\' && ['"', '\\'].includes(line[index + 1])) {
      current += line[++index];
    } else if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (quoted) throw new UsageError('Unterminated quote.');
  if (started) tokens.push(current);
  return tokens;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/server/tests/cli-tokenize.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Leave uncommitted**

No commit.

### Task 4: Policy edit functions

**Files:**
- Create: `apps/server/tests/fixtures/cli-displays.mjs`
- Create: `apps/server/src/cli/policy-edits.mjs`
- Test: `apps/server/tests/cli-policy-edits.test.mjs`

**Interfaces:**
- Consumes: `validateStreamPolicy`, `defaultStreamPolicy` from `apps/server/src/stream-policy.mjs`; `DisplayInventory` rows (`{ id, name, primary, persistent, x, y, width, height, rotation, number }`)
- Produces (all return validated copies with an unchanged `revision`):
  - `NEW_PROFILE = { width: 1920, height: 1080, fps: 30, bitrateKbps: 4000 }`
  - `OPTION_KINDS = { size: 'resolutions', framerate: 'frameRates', bitrate: 'bitratesKbps' }`
  - `seedDisplaySharing(policy, displays) -> policy` (returns the same object when `displaySharing !== null`)
  - `setDisplaySharing(policy, displays, display, shared) -> policy`
  - `setDisplayDefault(policy, displayId, profileId | null) -> policy`
  - `setDefaultProfile(policy, profileId | 'auto') -> policy`
  - `setAudio(policy, boolean) -> policy`, `setClientMode(policy, 'profiles' | 'options') -> policy`
  - `profileSlug(name, takenIds: Set<string>) -> string`
  - `addProfile(policy, { name, description?, width?, height?, fps?, bitrateKbps?, enabled? }) -> { policy, profile }`
  - `editProfile(policy, id, changes) -> policy` (changes keys: `name, description, enabled, width, height, fps, bitrateKbps`)
  - `duplicateProfile(policy, id) -> { policy, profile }`
  - `removeProfile(policy, id) -> policy`, `setProfileEnabled(policy, id, boolean) -> policy`
  - `addAllowedOption(policy, kind, value) -> policy`, `removeAllowedOption(policy, kind, value) -> policy` (`value` is `{ width, height }` for `size`, a number otherwise)
- Fixture produces: `MAIN`, `SIDE`, `PROJECTOR` (64-hex IDs), `rawDisplays()`, `displayInventory()`, `displayRows()`. Numbers: Main 1 (primary), Side 2, Projector 3 (not persistent, name contains an ESC control character).

- [ ] **Step 1: Create the display fixture**

Create `apps/server/tests/fixtures/cli-displays.mjs`:

```js
import { DisplayInventory } from '../../src/displays.mjs';

export const MAIN = 'a'.repeat(64);
export const SIDE = 'b'.repeat(64);
export const PROJECTOR = 'c'.repeat(64);

export function rawDisplays() {
  return [
    { id: MAIN, name: 'Main', primary: true, persistent: true, x: 0, y: 0, width: 2560, height: 1440, rotation: 0 },
    { id: SIDE, name: 'Side', primary: false, persistent: true, x: 2560, y: 0, width: 1920, height: 1080, rotation: 0 },
    {
      id: PROJECTOR,
      name: 'Projector\u001b[31m',
      primary: false,
      persistent: false,
      x: 4480,
      y: 0,
      width: 1920,
      height: 1080,
      rotation: 0,
    },
  ];
}

export const displayInventory = () => new DisplayInventory(rawDisplays());
export const displayRows = () => displayInventory().rows;
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/tests/cli-policy-edits.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';
import * as edits from '../src/cli/policy-edits.mjs';
import { MAIN, SIDE, displayRows } from './fixtures/cli-displays.mjs';

test('first-run seeding shares only the primary persistent display', () => {
  const policy = defaultStreamPolicy();
  const seeded = edits.seedDisplaySharing(policy, displayRows());
  assert.deepEqual(seeded.displaySharing, { [MAIN]: true });
  assert.equal(seeded.revision, policy.revision);
  assert.equal(policy.displaySharing, null);
  assert.equal(edits.seedDisplaySharing(seeded, displayRows()), seeded);
  const secondary = displayRows().filter((row) => !row.primary);
  assert.deepEqual(edits.seedDisplaySharing(policy, secondary).displaySharing, {});
});

test('display sharing, defaults, audio and client mode edit copies of the policy', () => {
  const displays = displayRows();
  const shared = edits.setDisplaySharing(defaultStreamPolicy(), displays, displays[1], true);
  assert.deepEqual(shared.displaySharing, { [MAIN]: true, [SIDE]: true });
  assert.deepEqual(edits.setDisplaySharing(shared, displays, displays[0], false).displaySharing, {
    [MAIN]: false,
    [SIDE]: true,
  });
  assert.throws(
    () => edits.setDisplaySharing(shared, displays, displays[2], true),
    /Display 3 has no stable identity and cannot be shared/,
  );
  const withDefault = edits.setDisplayDefault(shared, SIDE, 'mobile');
  assert.equal(withDefault.displayDefaults[SIDE], 'mobile');
  assert.equal(Object.hasOwn(edits.setDisplayDefault(withDefault, SIDE, null).displayDefaults, SIDE), false);
  assert.throws(
    () => edits.setDisplayDefault(shared, SIDE, 'missing'),
    /Display default must refer to an available profile/,
  );
  assert.equal(edits.setDefaultProfile(shared, 'desktop').defaultProfileId, 'desktop');
  assert.throws(
    () => edits.setDefaultProfile(shared, 'missing'),
    /Default profile must refer to an available profile/,
  );
  assert.equal(edits.setAudio(shared, false).allowAudio, false);
  assert.equal(edits.setClientMode(shared, 'options').clientMode, 'options');
  assert.throws(() => edits.setClientMode(shared, 'free'), /Invalid client customization mode/);
});

test('profile IDs are slugs of the name that avoid collisions and reserved IDs', () => {
  assert.equal(edits.profileSlug('Office', new Set(['office', 'office-2'])), 'office-3');
  assert.equal(edits.profileSlug('  Café Screen!! ', new Set()), 'caf-screen');
  assert.equal(edits.profileSlug('***', new Set()), 'profile');
  assert.equal(edits.profileSlug('Auto', new Set()), 'auto-2');
  assert.equal(edits.profileSlug('Custom', new Set()), 'custom-2');
  assert.equal(edits.profileSlug('a'.repeat(60), new Set()).length, 48);
});

test('profiles are added, edited, duplicated, enabled and removed with host validation', () => {
  const { policy, profile } = edits.addProfile(defaultStreamPolicy(), { name: ' Office desk ' });
  assert.deepEqual(profile, {
    id: 'office-desk',
    name: 'Office desk',
    description: '',
    enabled: true,
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 4000,
    frameDelivery: 'fixed',
  });
  assert.deepEqual(policy.profiles.at(-1), profile);
  assert.throws(() => edits.addProfile(policy, { name: '   ' }), /Profile name is invalid/);
  const edited = edits.editProfile(policy, 'office-desk', { name: ' Desk ', fps: 60, enabled: false });
  const last = edited.profiles.at(-1);
  assert.deepEqual([last.name, last.fps, last.enabled], ['Desk', 60, false]);
  assert.throws(
    () => edits.editProfile(policy, 'office-desk', { width: 1921 }),
    /Output dimensions must be even/,
  );
  assert.throws(() => edits.editProfile(policy, 'missing', { fps: 60 }), /Profile no longer exists/);
  const copy = edits.duplicateProfile(policy, 'balanced');
  assert.deepEqual(
    [copy.profile.id, copy.profile.name, copy.profile.fps],
    ['copy-of-balanced', 'Copy of Balanced', 30],
  );
  const long = edits.editProfile(policy, 'office-desk', { name: 'L'.repeat(64) });
  assert.equal(edits.duplicateProfile(long, 'office-desk').profile.name.length, 64);
  assert.equal(
    edits.removeProfile(policy, 'office-desk').profiles.some((row) => row.id === 'office-desk'),
    false,
  );
  assert.equal(
    edits.setProfileEnabled(policy, 'mobile', false).profiles.find((row) => row.id === 'mobile')
      .enabled,
    false,
  );
});

test('removing or disabling a default profile asks to change the default first', () => {
  const policy = edits.setDisplayDefault(
    edits.setDefaultProfile(defaultStreamPolicy(), 'desktop'),
    SIDE,
    'mobile',
  );
  assert.throws(() => edits.removeProfile(policy, 'desktop'), {
    message: 'Default profile must refer to an available profile; change the default first',
  });
  assert.throws(() => edits.setProfileEnabled(policy, 'mobile', false), {
    message: 'Display default must refer to an available profile; change the default first',
  });
  let onlyDesktop = defaultStreamPolicy();
  for (const id of ['iphone-720p-test', 'mobile', 'balanced', 'low-bandwidth'])
    onlyDesktop = edits.setProfileEnabled(onlyDesktop, id, false);
  assert.throws(
    () => edits.setProfileEnabled(onlyDesktop, 'desktop', false),
    /At least one profile must remain available/,
  );
});

test('allowed options add and remove values without duplicates or empty lists', () => {
  const policy = defaultStreamPolicy();
  assert.deepEqual(
    edits.addAllowedOption(policy, 'size', { width: 3840, height: 2160 }).allowedOptions.resolutions.at(-1),
    { width: 3840, height: 2160 },
  );
  assert.deepEqual(edits.addAllowedOption(policy, 'framerate', 60).allowedOptions.frameRates, [15, 30, 60]);
  assert.deepEqual(
    edits.removeAllowedOption(policy, 'bitrate', 1000).allowedOptions.bitratesKbps,
    [2000, 4000, 6000],
  );
  assert.throws(() => edits.addAllowedOption(policy, 'framerate', 30), /That option is already allowed/);
  assert.throws(
    () => edits.removeAllowedOption(policy, 'size', { width: 800, height: 600 }),
    /That option is not in the allowed list/,
  );
  const single = edits.removeAllowedOption(policy, 'framerate', 15);
  assert.throws(() => edits.removeAllowedOption(single, 'framerate', 30), /Frame rates requires 1–64 choices/);
  assert.throws(
    () => edits.addAllowedOption(policy, 'framerate', 61),
    /Frame rate must be an integer from 1 to 60/,
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test apps/server/tests/cli-policy-edits.test.mjs`
Expected: FAIL with `Cannot find module '...src/cli/policy-edits.mjs'`.

- [ ] **Step 4: Write minimal implementation**

Create `apps/server/src/cli/policy-edits.mjs`:

```js
import { validateStreamPolicy } from '../stream-policy.mjs';

export const NEW_PROFILE = Object.freeze({ width: 1920, height: 1080, fps: 30, bitrateKbps: 4000 });
export const OPTION_KINDS = Object.freeze({
  size: 'resolutions',
  framerate: 'frameRates',
  bitrate: 'bitratesKbps',
});
const RESERVED_IDS = new Set(['auto', 'custom']);
const EDITABLE = ['name', 'description', 'enabled', 'width', 'height', 'fps', 'bitrateKbps'];

// Every edit returns a validated copy with the same revision; stores own revisions.
function edit(policy, change) {
  const next = structuredClone(policy);
  change(next);
  return validateStreamPolicy(next);
}

function withDefaultHint(apply) {
  try {
    return apply();
  } catch (error) {
    if (/^(Default profile|Display default) must refer/.test(error.message))
      error.message += '; change the default first';
    throw error;
  }
}

function findProfile(policy, id) {
  const profile = policy.profiles.find((row) => row.id === id);
  if (!profile) throw new Error('Profile no longer exists');
  return profile;
}

export function seedDisplaySharing(policy, displays) {
  if (policy.displaySharing !== null) return policy;
  const primary = displays.find((display) => display.primary && display.persistent);
  return edit(policy, (next) => {
    next.displaySharing = primary ? { [primary.id]: true } : {};
  });
}

export function setDisplaySharing(policy, displays, display, shared) {
  if (!display.persistent)
    throw new Error(`Display ${display.number} has no stable identity and cannot be shared`);
  return edit(seedDisplaySharing(policy, displays), (next) => {
    next.displaySharing[display.id] = shared;
  });
}

export function setDisplayDefault(policy, displayId, profileId) {
  return edit(policy, (next) => {
    if (profileId === null) delete next.displayDefaults[displayId];
    else next.displayDefaults[displayId] = profileId;
  });
}

export function setDefaultProfile(policy, profileId) {
  return edit(policy, (next) => {
    next.defaultProfileId = profileId;
  });
}

export function setAudio(policy, allowed) {
  return edit(policy, (next) => {
    next.allowAudio = allowed;
  });
}

export function setClientMode(policy, mode) {
  return edit(policy, (next) => {
    next.clientMode = mode;
  });
}

export function profileSlug(name, taken) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'profile';
  let id = base;
  for (let suffix = 2; taken.has(id) || RESERVED_IDS.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

export function addProfile(
  policy,
  {
    name,
    description = '',
    width = NEW_PROFILE.width,
    height = NEW_PROFILE.height,
    fps = NEW_PROFILE.fps,
    bitrateKbps = NEW_PROFILE.bitrateKbps,
    enabled = true,
  },
) {
  const profile = {
    id: profileSlug(name, new Set(policy.profiles.map((row) => row.id))),
    name: name.trim(),
    description: description.trim(),
    enabled,
    width,
    height,
    fps,
    bitrateKbps,
    frameDelivery: 'fixed',
  };
  return { policy: edit(policy, (next) => next.profiles.push(profile)), profile };
}

export function editProfile(policy, id, changes) {
  return withDefaultHint(() =>
    edit(policy, (next) => {
      const profile = findProfile(next, id);
      for (const [key, value] of Object.entries(changes)) {
        if (!EDITABLE.includes(key)) throw new Error(`Unknown profile field ${key}`);
        profile[key] = typeof value === 'string' ? value.trim() : value;
      }
    }),
  );
}

export function duplicateProfile(policy, id) {
  const source = findProfile(policy, id);
  const name = `Copy of ${source.name}`.slice(0, 64).trimEnd();
  const profile = {
    ...structuredClone(source),
    id: profileSlug(name, new Set(policy.profiles.map((row) => row.id))),
    name,
  };
  return { policy: edit(policy, (next) => next.profiles.push(profile)), profile };
}

export function removeProfile(policy, id) {
  return withDefaultHint(() =>
    edit(policy, (next) => {
      findProfile(next, id);
      next.profiles = next.profiles.filter((row) => row.id !== id);
    }),
  );
}

export function setProfileEnabled(policy, id, enabled) {
  return editProfile(policy, id, { enabled });
}

function optionKey(kind) {
  if (!Object.hasOwn(OPTION_KINDS, kind)) throw new Error(`Unknown option kind ${kind}`);
  return OPTION_KINDS[kind];
}

function sameOption(kind, left, right) {
  return kind === 'size' ? left.width === right.width && left.height === right.height : left === right;
}

export function addAllowedOption(policy, kind, value) {
  const key = optionKey(kind);
  if (policy.allowedOptions[key].some((row) => sameOption(kind, row, value)))
    throw new Error('That option is already allowed');
  return edit(policy, (next) => {
    next.allowedOptions[key].push(value);
  });
}

export function removeAllowedOption(policy, kind, value) {
  const key = optionKey(kind);
  if (!policy.allowedOptions[key].some((row) => sameOption(kind, row, value)))
    throw new Error('That option is not in the allowed list');
  return edit(policy, (next) => {
    next.allowedOptions[key] = next.allowedOptions[key].filter(
      (row) => !sameOption(kind, row, value),
    );
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test apps/server/tests/cli-policy-edits.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Leave uncommitted**

No commit.

---

### Task 5: Selector resolution

**Files:**
- Create: `apps/server/src/cli/resolve.mjs`
- Test: `apps/server/tests/cli-resolve.test.mjs`

**Interfaces:**
- Consumes: `UsageError` (Task 3); display rows fixture (Task 4)
- Produces:
  - `resolveDisplay(displays, selector: string) -> display` — `2`, `#2`, or ID prefix of 8–64 hex characters (case-insensitive). Bad syntax throws `UsageError`; unknown or ambiguous throws `Error`.
  - `resolveProfile(profiles, selector) -> profile` — exact ID first, then unique case-insensitive name.
  - `class SessionNumbers { number(sessionId) -> number; prune(activeIds: Set<string>) }` — numbers start at 1 and are never reused.
  - `resolveSession(rows, numbers, selector) -> row` — `rows` are `runtime.status().sessions` (`{ id, streams: [{ id }] }`); selector `#1`/`1` or a stream ID. Errors never contain a session ID.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/cli-resolve.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';
import {
  SessionNumbers,
  resolveDisplay,
  resolveProfile,
  resolveSession,
} from '../src/cli/resolve.mjs';
import { UsageError } from '../src/cli/usage-error.mjs';
import { MAIN, SIDE, displayRows } from './fixtures/cli-displays.mjs';

const usage = (error) => error instanceof UsageError;
const failure = (pattern) => (error) => !(error instanceof UsageError) && pattern.test(error.message);

test('displays resolve by number, #number or unique ID prefix', () => {
  const displays = displayRows();
  assert.equal(resolveDisplay(displays, '2').id, SIDE);
  assert.equal(resolveDisplay(displays, '#1').id, MAIN);
  assert.equal(resolveDisplay(displays, 'BBBBBBBB').id, SIDE);
  assert.throws(() => resolveDisplay(displays, '9'), failure(/^There is no display 9\. Use displays to list them\.$/));
  assert.throws(() => resolveDisplay(displays, 'dddddddd'), failure(/No display ID starts with dddddddd/));
  assert.throws(() => resolveDisplay(displays, 'left'), usage);
  assert.throws(() => resolveDisplay(displays, 'abc'), usage);
  const similar = [
    { ...displays[0], id: `abcdefab${'0'.repeat(56)}` },
    { ...displays[1], id: `abcdefab${'1'.repeat(56)}` },
  ];
  assert.throws(() => resolveDisplay(similar, 'abcdefab'), failure(/matches more than one display/));
});

test('profiles resolve by exact ID or unique case-insensitive name', () => {
  const { profiles } = defaultStreamPolicy();
  assert.equal(resolveProfile(profiles, 'balanced').id, 'balanced');
  assert.equal(resolveProfile(profiles, 'IPHONE 720P').id, 'iphone-720p-test');
  const twins = [...profiles, { ...profiles[1], id: 'other' }];
  assert.throws(() => resolveProfile(twins, 'MOBILE'), {
    message: 'More than one profile is named "MOBILE"; use its ID.',
  });
  assert.throws(() => resolveProfile(profiles, 'nope'), {
    message: 'No profile matches "nope". Use profiles to list them.',
  });
});

test('sessions resolve by console number or stream ID without echoing session IDs', () => {
  const numbers = new SessionNumbers();
  const rows = [
    { id: '11111111-1111-4111-8111-111111111111', streams: [{ id: 'stream-a' }] },
    { id: '22222222-2222-4222-8222-222222222222', streams: [] },
  ];
  assert.equal(resolveSession(rows, numbers, '#1'), rows[0]);
  assert.equal(resolveSession(rows, numbers, '2'), rows[1]);
  assert.equal(resolveSession(rows, numbers, 'stream-a'), rows[0]);
  numbers.prune(new Set([rows[1].id]));
  const third = { id: '33333333-3333-4333-8333-333333333333', streams: [] };
  assert.equal(resolveSession([rows[1], third], numbers, '#3'), third);
  assert.equal(numbers.number(rows[1].id), 2);
  assert.throws(
    () => resolveSession([rows[1], third], numbers, '#1'),
    (error) =>
      error.message === 'No connected device matches #1. Use sessions to list them.' &&
      !error.message.includes(rows[0].id),
  );
});
```

(`profiles[1]` is the default `mobile` profile, so `twins` has two profiles named "Mobile".)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/cli-resolve.test.mjs`
Expected: FAIL with `Cannot find module '...src/cli/resolve.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/cli/resolve.mjs`:

```js
import { UsageError } from './usage-error.mjs';

export function resolveDisplay(displays, selector) {
  const number = /^#?(\d{1,2})$/.exec(selector);
  if (number) {
    const display = displays.find((row) => row.number === Number(number[1]));
    if (!display) throw new Error(`There is no display ${number[1]}. Use displays to list them.`);
    return display;
  }
  if (!/^[a-f0-9]{8,64}$/i.test(selector))
    throw new UsageError(
      'Choose a display by number, for example 2, or by an ID prefix of at least 8 characters.',
    );
  const matches = displays.filter((row) => row.id.startsWith(selector.toLowerCase()));
  if (matches.length > 1) throw new Error(`Display ID ${selector} matches more than one display.`);
  if (!matches.length)
    throw new Error(`No display ID starts with ${selector}. Use displays to list them.`);
  return matches[0];
}

export function resolveProfile(profiles, selector) {
  const exact = profiles.find((profile) => profile.id === selector);
  if (exact) return exact;
  const named = profiles.filter((profile) => profile.name.toLowerCase() === selector.toLowerCase());
  if (named.length > 1) throw new Error(`More than one profile is named "${selector}"; use its ID.`);
  if (!named.length) throw new Error(`No profile matches "${selector}". Use profiles to list them.`);
  return named[0];
}

// Console numbers stand in for session IDs, which are bearer credentials.
export class SessionNumbers {
  #numbers = new Map();
  #next = 1;
  number(sessionId) {
    if (!this.#numbers.has(sessionId)) this.#numbers.set(sessionId, this.#next++);
    return this.#numbers.get(sessionId);
  }
  prune(activeIds) {
    for (const sessionId of this.#numbers.keys())
      if (!activeIds.has(sessionId)) this.#numbers.delete(sessionId);
  }
}

export function resolveSession(rows, numbers, selector) {
  for (const row of rows) numbers.number(row.id);
  const number = /^#?(\d{1,6})$/.exec(selector);
  const row = number
    ? rows.find((candidate) => numbers.number(candidate.id) === Number(number[1]))
    : rows.find((candidate) => candidate.streams.some((stream) => stream.id === selector));
  if (!row) throw new Error(`No connected device matches ${selector}. Use sessions to list them.`);
  return row;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/server/tests/cli-resolve.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Leave uncommitted**

No commit.

---

### Task 6: Command framework and offline context

**Files:**
- Create: `apps/server/src/cli/format.mjs`
- Create: `apps/server/src/cli/arguments.mjs`
- Create: `apps/server/src/cli/conflict-advice.mjs`
- Create: `apps/server/src/cli/commands.mjs`
- Create: `apps/server/src/cli/offline.mjs`
- Test: `apps/server/tests/cli-commands.test.mjs`

**Interfaces:**
- Consumes: `settingsFiles` (Task 1), `runningInstances`, `isAlive` (Task 1), `applyProfileOrder`, `saveProfileOrder` (Task 2), `tokenize`, `UsageError` (Task 3), `StreamPolicyStore`, `AccessSettings`, `DisplayInventory` (existing)
- Produces:
  - `format.mjs`: `clean(value) -> string` (removes control characters), `table(headers, rows) -> string`, `pairs(rows: [label, value][]) -> string`, `mbps(kbps) -> '4 Mbit/s'`, `size({ width, height }) -> '1920×1080'`, `accessLabel(value)`, `modeLabel(mode)`
  - `arguments.mjs`: `parseFlags(tokens, allowed: { [name]: 'value' | 'boolean' }) -> { positionals, flags }`, `expectArguments(positionals, min, max?)`, `onOff(value) -> boolean`, `parseSize(value) -> { width, height }`, `parseWhole(value, label) -> number`, `capitalize(text)`, `outcome(result, message) -> { text }`
  - `conflict-advice.mjs`: `withConflictAdvice(error, advice) -> error`
  - `commands.mjs`: `commands` (array of command specs), `findCommand(tokens)`, `execute(context, tokens) -> Promise<{ text, data?, json }>`, `executeLine(context, line)`
  - Command spec shape: `{ name, usage, summary, where: 'both' | 'live' | 'offline', flags?, json?, mayDisconnect?, run(context, { positionals, flags }) -> { text, data? } }`
  - Context interface (implemented by offline here, live in Task 9): `mode`, `policy()`, `updatePolicy(summary, edit, { yes }) -> Promise<{ applied, policy? }>`, `access()`, `saveAccess(value)`, `orderedProfiles()`, `saveProfileOrder(ids)`, `displays()`, `info() -> Promise<[label, value][]>`, and live-only `sessions`
  - `offline.mjs`: `createOfflineContext({ directory, logDirectory, listDisplays?, alive? })`, `runOffline(argv, { stdout, stderr, directory, logDirectory, listDisplays?, alive? }) -> Promise<0 | 1 | 2>`
- Later tasks add command groups in `apps/server/src/cli/commands/` and spread them into `commands`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/cli-commands.test.mjs`. Tasks 7 and 8 append tests to this file and use the imports that are unused here.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeLine } from '../src/cli/commands.mjs';
import { createOfflineContext, runOffline } from '../src/cli/offline.mjs';
import { UsageError } from '../src/cli/usage-error.mjs';
import { MAIN, SIDE, rawDisplays } from './fixtures/cli-displays.mjs';

async function offline(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await createOfflineContext({
    directory,
    logDirectory: join(directory, 'logs'),
    listDisplays: async () => rawDisplays(),
    alive: () => false,
    ...options,
  });
  return { directory, context, run: (line) => executeLine(context, line) };
}

function capture() {
  let text = '';
  return {
    stream: { write: (chunk) => ((text += chunk), true) },
    text: () => text,
  };
}

const usage = (pattern) => (error) => error instanceof UsageError && pattern.test(error.message);

test('help lists commands for the mode and explains a single command', async (t) => {
  const { run } = await offline(t);
  const list = (await run('help')).text;
  assert.match(list, /^Commands:\n  config help \[command\]\n      List commands/);
  assert.match(list, /config info/);
  assert.equal(
    (await run('help info')).text,
    'Usage: config info\nShow connection details and where settings and logs are stored.',
  );
  await assert.rejects(
    run('help nothing'),
    usage(/^Unknown command "nothing"\. Type config help for commands\.$/),
  );
});

test('usage errors carry a help hint', async (t) => {
  const { run } = await offline(t);
  await assert.rejects(
    run('frobnicate now'),
    usage(/^Unknown command "frobnicate"\. Type config help for commands\.$/),
  );
  await assert.rejects(run('info extra'), usage(/^Wrong number of arguments\. Type config help info\.$/));
  await assert.rejects(run('info --bogus'), usage(/^Unknown option --bogus\. Type config help info\.$/));
  await assert.rejects(run('info --json'), usage(/^Unknown option --json\./));
  await assert.rejects(run('help "open'), usage(/^Unterminated quote\. Type config help for commands\.$/));
  assert.deepEqual(await run('   '), { text: '', json: false });
});

test('info reports folders and running servers', async (t) => {
  const { run, directory } = await offline(t, { alive: (pid) => pid === 4242 });
  assert.match(
    (await run('info')).text,
    /^Data folder\s+.+\nLog folder\s+.+logs\nRunning servers\s+none$/,
  );
  await mkdir(join(directory, 'instances'));
  await writeFile(
    join(directory, 'instances', '4242.json'),
    JSON.stringify({ pid: 4242, startedAt: 1, mode: 'cli', port: 4382 }),
  );
  assert.match((await run('info')).text, /Running servers\s+PID 4242 \(cli, port 4382\)$/);
});

test('runOffline prints results and maps usage errors to 2 and failures to 1', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invoke = async (argv) => {
    const out = capture();
    const err = capture();
    const code = await runOffline(argv, {
      stdout: out.stream,
      stderr: err.stream,
      directory,
      logDirectory: join(directory, 'logs'),
      listDisplays: async () => rawDisplays(),
      alive: () => false,
    });
    return { code, stdout: out.text(), stderr: err.text() };
  };
  const help = await invoke([]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Commands:\n/);
  const unknown = await invoke(['nope']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stderr, 'Unknown command "nope". Type config help for commands.\n');
  await writeFile(join(directory, 'stream-policy.json'), '{"schemaVersion":9}');
  const broken = await invoke(['info']);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /missing or unknown fields/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/cli-commands.test.mjs`
Expected: FAIL with `Cannot find module '...src/cli/commands.mjs'`.

- [ ] **Step 3: Write the formatting and argument helpers**

Create `apps/server/src/cli/format.mjs`. `\p{Cc}` matches C0 and C1 control characters, including ESC:

```js
const ACCESS_LABELS = { approval: 'Require host approval', available: 'Allow when available' };
const MODE_LABELS = { profiles: 'Approved profiles only', options: 'Approved options' };

// Display names come from the OS; never pass terminal control sequences through.
export function clean(value) {
  return String(value).replace(/\p{Cc}/gu, '');
}

export function table(headers, rows) {
  const cells = [headers, ...rows].map((row) => row.map(clean));
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column].length)));
  return cells
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd())
    .join('\n');
}

export function pairs(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${clean(value)}`).join('\n');
}

export const mbps = (kbps) => `${Number((kbps / 1000).toFixed(3))} Mbit/s`;
export const size = ({ width, height }) => `${width}×${height}`;
export const accessLabel = (value) => ACCESS_LABELS[value];
export const modeLabel = (mode) => MODE_LABELS[mode];
```

Create `apps/server/src/cli/arguments.mjs`:

```js
import { UsageError } from './usage-error.mjs';

export function parseFlags(tokens, allowed) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (!Object.hasOwn(allowed, name)) throw new UsageError(`Unknown option --${name}.`);
    if (Object.hasOwn(flags, name)) throw new UsageError(`--${name} was given more than once.`);
    if (allowed[name] === 'boolean') {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value.`);
      flags[name] = true;
    } else {
      const value = inline ?? tokens[++index];
      if (value === undefined) throw new UsageError(`--${name} needs a value.`);
      flags[name] = value;
    }
  }
  return { positionals, flags };
}

export function expectArguments(positionals, min, max = min) {
  if (positionals.length < min || positionals.length > max)
    throw new UsageError('Wrong number of arguments.');
}

export function onOff(value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new UsageError('Use on or off.');
}

export function parseSize(value) {
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(value);
  if (!match) throw new UsageError('Sizes use WIDTHxHEIGHT, for example 1920x1080.');
  const size = { width: Number(match[1]), height: Number(match[2]) };
  if (size.width % 2 || size.height % 2) throw new Error('Output width and height must be even');
  return size;
}

export function parseWhole(value, label) {
  if (!/^\d{1,9}$/.test(value)) throw new UsageError(`${label} must be a whole number.`);
  return Number(value);
}

export const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export const outcome = (result, message) => ({
  text: result.applied ? message : 'No changes applied.',
});
```

Create `apps/server/src/cli/conflict-advice.mjs`:

```js
// Store conflicts are safe refusals; tell the user how to recover in this mode.
export function withConflictAdvice(error, advice) {
  if (error.code === 'EEXIST')
    error.message = `Settings are locked by another save (${error.path}). ${advice}`;
  else if (/changed|being saved/i.test(error.message)) error.message = `${error.message}. ${advice}`;
  return error;
}
```

- [ ] **Step 4: Write the command framework**

Create `apps/server/src/cli/commands.mjs`:

```js
import { tokenize } from './tokenize.mjs';
import { UsageError } from './usage-error.mjs';
import { expectArguments, parseFlags } from './arguments.mjs';
import { pairs } from './format.mjs';

const generalCommands = [
  {
    name: 'help',
    usage: 'help [command]',
    summary: 'List commands, or show how to use one.',
    where: 'both',
    run: (context, { positionals }) => ({ text: helpText(context.mode, positionals.join(' ')) }),
  },
  {
    name: 'info',
    usage: 'info',
    summary: 'Show connection details and where settings and logs are stored.',
    where: 'both',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      return { text: pairs(await context.info()) };
    },
  },
];

export const commands = [...generalCommands];

const ONLY = {
  live: 'Available only in the running server console.',
  offline: 'Available only as a config command.',
};

function helpText(mode, topic) {
  const prefix = mode === 'offline' ? 'config ' : '';
  const exact = commands.find((command) => command.name === topic);
  if (exact) {
    const notes = [];
    if (exact.where !== 'both' && exact.where !== mode) notes.push(ONLY[exact.where]);
    if (exact.mayDisconnect && mode === 'live')
      notes.push('Connected devices are disconnected when this applies; add --yes to skip the question.');
    if (exact.json && mode === 'offline') notes.push('Add --json for machine-readable output.');
    const usagePrefix = { offline: 'config ', live: '', both: prefix }[exact.where];
    return [`Usage: ${usagePrefix}${exact.usage}`, exact.summary, ...notes].join('\n');
  }
  const available = commands.filter((command) => command.where === 'both' || command.where === mode);
  const matching = topic
    ? available.filter((command) => command.name.startsWith(`${topic} `))
    : available;
  if (!matching.length) throw new UsageError(`Unknown command "${topic}".`);
  return [
    topic ? `${topic} commands:` : 'Commands:',
    ...matching.map((command) => `  ${prefix}${command.usage}\n      ${command.summary}`),
  ].join('\n');
}

export function findCommand(tokens) {
  const twoWords = tokens.slice(0, 2).join(' ');
  return (
    commands.find((command) => command.name === twoWords) ??
    commands.find((command) => command.name === tokens[0])
  );
}

function helpHint(context, command) {
  const help = context.mode === 'offline' ? 'config help' : 'help';
  return command && command.name !== 'help'
    ? ` Type ${help} ${command.name}.`
    : ` Type ${help} for commands.`;
}

export async function execute(context, tokens) {
  if (!tokens.length) return { text: '', json: false };
  const command = findCommand(tokens);
  try {
    if (!command) throw new UsageError(`Unknown command "${tokens[0]}".`);
    if (command.where === 'live' && context.mode !== 'live')
      throw new UsageError(`${command.name} is only available in the running server console.`);
    if (command.where === 'offline' && context.mode !== 'offline')
      throw new UsageError(`${command.name} is only available as config ${command.name}.`);
    const allowed = { ...command.flags };
    if (command.mayDisconnect) allowed.yes = 'boolean';
    if (command.json && context.mode === 'offline') allowed.json = 'boolean';
    const args = parseFlags(tokens.slice(command.name.split(' ').length), allowed);
    return { ...(await command.run(context, args)), json: args.flags.json === true };
  } catch (error) {
    if (error instanceof UsageError) error.message += helpHint(context, command);
    throw error;
  }
}

export async function executeLine(context, line) {
  let tokens;
  try {
    tokens = tokenize(line);
  } catch (error) {
    if (error instanceof UsageError) error.message += helpHint(context);
    throw error;
  }
  return execute(context, tokens);
}
```

- [ ] **Step 5: Write the offline context and runner**

Create `apps/server/src/cli/offline.mjs`:

```js
import { AccessSettings } from '../access-settings.mjs';
import { DisplayInventory } from '../displays.mjs';
import { isAlive, runningInstances } from '../instances.mjs';
import { settingsFiles } from '../paths.mjs';
import { applyProfileOrder, saveProfileOrder } from '../profile-order.mjs';
import { StreamPolicyStore } from '../stream-policy-store.mjs';
import { execute } from './commands.mjs';
import { withConflictAdvice } from './conflict-advice.mjs';
import { UsageError } from './usage-error.mjs';

const RETRY = 'Try again.';

async function defaultListDisplays() {
  // Loaded lazily: only display commands need the native worker.
  const { listDisplays } = await import('../native-media.mjs');
  return listDisplays();
}

export async function createOfflineContext({
  directory,
  logDirectory,
  listDisplays = defaultListDisplays,
  alive = isAlive,
}) {
  const files = settingsFiles(directory);
  const store = await StreamPolicyStore.open(files.policy);
  const access = await AccessSettings.open(files.access);
  let displays;
  const ensureStopped = () => {
    const [running] = runningInstances(files.instances, { alive });
    if (running)
      throw new Error(
        `VidVNC is running (PID ${running.pid}, ${running.file}). Type this command in its console instead.`,
      );
  };
  const saving = async (write) => {
    ensureStopped();
    try {
      return await write();
    } catch (error) {
      throw withConflictAdvice(error, RETRY);
    }
  };
  return {
    mode: 'offline',
    policy: () => store.snapshot(),
    updatePolicy: (summary, edit) =>
      saving(async () => {
        const current = store.snapshot();
        return { applied: true, policy: await store.replace(await edit(current), current.revision) };
      }),
    access: () => access.snapshot(),
    saveAccess: (value) => saving(() => access.replace(value, access.snapshot().revision)),
    orderedProfiles: () => applyProfileOrder(files.profileOrder, store.snapshot().profiles),
    saveProfileOrder: (ids) => saving(() => saveProfileOrder(files.profileOrder, ids)),
    async displays() {
      try {
        displays ??= new DisplayInventory(await listDisplays()).rows;
      } catch (error) {
        throw new Error(
          `Display information is unavailable: ${error.message}. Check that the media worker is installed and the NVIDIA driver is working.`,
        );
      }
      return displays;
    },
    async info() {
      const running = runningInstances(files.instances, { alive });
      return [
        ['Data folder', directory],
        ['Log folder', logDirectory],
        [
          'Running servers',
          running.length
            ? running
                .map((row) => `PID ${row.pid} (${row.mode}${row.port ? `, port ${row.port}` : ''})`)
                .join(', ')
            : 'none',
        ],
      ];
    },
  };
}

export async function runOffline(argv, { stdout, stderr, ...options }) {
  try {
    const context = await createOfflineContext(options);
    const result = await execute(context, argv.length ? argv : ['help']);
    if (result.json) stdout.write(`${JSON.stringify(result.data ?? null, null, 2)}\n`);
    else if (result.text) stdout.write(`${result.text}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test apps/server/tests/cli-commands.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 7: Leave uncommitted**

No commit.

---

### Task 7: Display, audio and access commands

**Files:**
- Modify: `apps/server/src/cli/format.mjs`
- Create: `apps/server/src/cli/commands/settings.mjs`
- Modify: `apps/server/src/cli/commands.mjs`
- Test: `apps/server/tests/cli-commands.test.mjs` (append)

**Interfaces:**
- Consumes: Task 4 edits, Task 5 resolvers, Task 6 helpers and context interface
- Produces:
  - `format.mjs`: `profileName(policy, id)`, `displayLabel(display) -> 'display 2 (Side)'`, `sharingState(policy, display) -> 'shared' | 'private' | 'unavailable'`, `formatDisplays(displays, policy)`, `formatAccess(access)`
  - `commands/settings.mjs`: `settingsCommands` — `displays`, `share`, `display-default`, `default-profile`, `audio`, `access`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/tests/cli-commands.test.mjs`:

```js
test('displays lists numbered displays with effective sharing and no control characters', async (t) => {
  const { run } = await offline(t);
  const { text } = await run('displays');
  assert.match(text, /^#\s+Name\s+Size\s+Position\s+Primary\s+Sharing\s+Default profile$/m);
  assert.match(text, /^1\s+Main\s+2560×1440\s+0,0\s+yes\s+shared\s+host default$/m);
  assert.match(text, /^2\s+Side\s+1920×1080\s+2560,0\s+private\s+host default$/m);
  assert.match(text, /^3\s+Projector\[31m\s+1920×1080\s+4480,0\s+unavailable\s+host default$/m);
  assert.match(text, /^Host default profile: Automatic · Desktop audio: on$/m);
  assert.equal(text.includes(String.fromCharCode(27)), false);
  const json = await run('displays --json');
  assert.equal(json.json, true);
  assert.deepEqual(
    json.data.map((row) => [row.number, row.shared, row.defaultProfileId]),
    [
      [1, true, null],
      [2, false, null],
      [3, false, null],
    ],
  );
});

test('share seeds the primary display, persists, and rejects unstable displays', async (t) => {
  const { run, directory } = await offline(t);
  assert.equal((await run('share 2 on')).text, 'Display 2 (Side) is now shared.');
  const saved = JSON.parse(await readFile(join(directory, 'stream-policy.json'), 'utf8'));
  assert.deepEqual(saved.displaySharing, { [MAIN]: true, [SIDE]: true });
  assert.equal((await run('share #1 off')).text, 'Display 1 (Main) is now private.');
  await assert.rejects(run('share 3 on'), /Display 3 has no stable identity/);
  await assert.rejects(run('share 9 on'), /There is no display 9/);
  await assert.rejects(run('share 2 maybe'), usage(/^Use on or off\. Type config help share\.$/));
  await assert.rejects(run('share 2'), usage(/^Wrong number of arguments\./));
  assert.equal((await run(`share ${SIDE.slice(0, 8)} off`)).text, 'Display 2 (Side) is now private.');
});

test('display commands explain an unavailable worker while other commands still work', async (t) => {
  const { run } = await offline(t, {
    listDisplays: async () => {
      throw new Error('spawn ENOENT');
    },
  });
  await assert.rejects(run('displays'), /Display information is unavailable: spawn ENOENT\./);
  assert.equal((await run('audio off')).text, 'Desktop audio is now off.');
});

test('display defaults, host default and audio persist through the policy store', async (t) => {
  const { run, context } = await offline(t);
  assert.equal((await run('display-default 2 mobile')).text, 'Display 2 (Side) now uses "Mobile".');
  assert.equal(context.policy().displayDefaults[SIDE], 'mobile');
  assert.equal(
    (await run('display-default 2 host')).text,
    'Display 2 (Side) now uses the host default.',
  );
  assert.equal(Object.hasOwn(context.policy().displayDefaults, SIDE), false);
  assert.equal(
    (await run('default-profile "iphone 720p"')).text,
    'The host default profile is now "iPhone 720p".',
  );
  assert.equal(context.policy().defaultProfileId, 'iphone-720p-test');
  assert.equal((await run('default-profile auto')).text, 'The host default profile is now Automatic.');
  assert.equal((await run('audio off')).text, 'Desktop audio is now off.');
  assert.equal(context.policy().allowAudio, false);
  assert.equal(context.policy().revision, 5);
  await assert.rejects(run('display-default 2 nope'), /No profile matches "nope"/);
});

test('access shows and saves the default for new connections', async (t) => {
  const { run } = await offline(t);
  assert.equal(
    (await run('access')).text,
    'Keyboard and mouse for new connections: Require host approval',
  );
  const saved = await run('access available --json');
  assert.equal(saved.json, true);
  assert.deepEqual(saved.data, { revision: 1, defaultControl: 'available' });
  await assert.rejects(run('access always'), usage(/^Use approval or available\./));
});

test('offline changes refuse while a server instance is alive but reads still work', async (t) => {
  const { run, directory } = await offline(t, { alive: (pid) => pid === 4242 });
  await mkdir(join(directory, 'instances'));
  await writeFile(
    join(directory, 'instances', '4242.json'),
    JSON.stringify({ pid: 4242, startedAt: 1, mode: 'desktop', port: 4382 }),
  );
  await assert.rejects(
    run('access available'),
    /VidVNC is running \(PID 4242, .+4242\.json\)\. Type this command in its console instead\./,
  );
  await assert.rejects(run('audio off'), /VidVNC is running/);
  assert.equal(
    (await run('access')).text,
    'Keyboard and mouse for new connections: Require host approval',
  );
  assert.match((await run('displays')).text, /Main/);
});

test('a stranded settings lock is reported with advice and left in place', async (t) => {
  const { run, directory } = await offline(t);
  const lock = join(directory, 'access-settings.json.lock');
  await writeFile(lock, '');
  await assert.rejects(
    run('access available'),
    /Settings are locked by another save \(.+access-settings\.json\.lock\)\. Try again\./,
  );
  assert.equal(await readFile(lock, 'utf8'), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test apps/server/tests/cli-commands.test.mjs`
Expected: the 4 Task 6 tests PASS; the 7 new tests FAIL with `Unknown command "displays"` (and similar).

- [ ] **Step 3: Add display and access formatting**

Append to `apps/server/src/cli/format.mjs`:

```js
export function profileName(policy, id) {
  return id === 'auto'
    ? 'Automatic'
    : (policy.profiles.find((profile) => profile.id === id)?.name ?? id);
}

export const displayLabel = (display) => `display ${display.number} (${clean(display.name)})`;

export function sharingState(policy, display) {
  if (!display.persistent) return 'unavailable';
  return policy.displaySharing?.[display.id] === true ? 'shared' : 'private';
}

export function formatDisplays(displays, policy) {
  if (!displays.length) return 'No displays found.';
  const rows = displays.map((display) => [
    display.number,
    display.name,
    size(display),
    `${display.x},${display.y}`,
    display.primary ? 'yes' : '',
    sharingState(policy, display),
    Object.hasOwn(policy.displayDefaults, display.id)
      ? profileName(policy, policy.displayDefaults[display.id])
      : 'host default',
  ]);
  return [
    table(['#', 'Name', 'Size', 'Position', 'Primary', 'Sharing', 'Default profile'], rows),
    `Host default profile: ${profileName(policy, policy.defaultProfileId)} · Desktop audio: ${policy.allowAudio ? 'on' : 'off'}`,
  ].join('\n');
}

export const formatAccess = (access) =>
  `Keyboard and mouse for new connections: ${accessLabel(access.defaultControl)}`;
```

- [ ] **Step 4: Add the settings command group**

Create `apps/server/src/cli/commands/settings.mjs`:

```js
import { UsageError } from '../usage-error.mjs';
import { capitalize, expectArguments, onOff, outcome } from '../arguments.mjs';
import { displayLabel, formatAccess, formatDisplays } from '../format.mjs';
import { resolveDisplay, resolveProfile } from '../resolve.mjs';
import * as edits from '../policy-edits.mjs';

export const settingsCommands = [
  {
    name: 'displays',
    usage: 'displays',
    summary: 'List displays with sharing and default profiles.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const displays = await context.displays();
      const policy = edits.seedDisplaySharing(context.policy(), displays);
      return {
        text: formatDisplays(displays, policy),
        data: displays.map((display) => ({
          ...display,
          shared: display.persistent && policy.displaySharing[display.id] === true,
          defaultProfileId: policy.displayDefaults[display.id] ?? null,
        })),
      };
    },
  },
  {
    name: 'share',
    usage: 'share <display> on|off',
    summary: 'Allow or stop sharing a display.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 2);
      const shared = onOff(positionals[1]);
      const display = resolveDisplay(await context.displays(), positionals[0]);
      const label = displayLabel(display);
      const result = await context.updatePolicy(
        `${shared ? 'Share' : 'Stop sharing'} ${label}`,
        async (policy) => {
          const displays = await context.displays();
          const current = displays.find((row) => row.id === display.id);
          if (!current) throw new Error(`${capitalize(label)} is no longer connected.`);
          return edits.setDisplaySharing(policy, displays, current, shared);
        },
        { yes: flags.yes === true },
      );
      return outcome(result, `${capitalize(label)} is now ${shared ? 'shared' : 'private'}.`);
    },
  },
  {
    name: 'display-default',
    usage: 'display-default <display> <profile>|host',
    summary: "Set a display's default profile, or use the host default.",
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 2);
      const display = resolveDisplay(await context.displays(), positionals[0]);
      const profile =
        positionals[1].toLowerCase() === 'host'
          ? null
          : resolveProfile(context.policy().profiles, positionals[1]);
      const label = displayLabel(display);
      const choice = profile ? `"${profile.name}"` : 'the host default';
      const result = await context.updatePolicy(
        `Use ${choice} for ${label}`,
        (policy) => edits.setDisplayDefault(policy, display.id, profile?.id ?? null),
        { yes: flags.yes === true },
      );
      return outcome(result, `${capitalize(label)} now uses ${choice}.`);
    },
  },
  {
    name: 'default-profile',
    usage: 'default-profile auto|<profile>',
    summary: 'Set the host default profile.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const profile =
        positionals[0].toLowerCase() === 'auto'
          ? null
          : resolveProfile(context.policy().profiles, positionals[0]);
      const choice = profile ? `"${profile.name}"` : 'Automatic';
      const result = await context.updatePolicy(
        `Use ${choice} as the host default profile`,
        (policy) => edits.setDefaultProfile(policy, profile?.id ?? 'auto'),
        { yes: flags.yes === true },
      );
      return outcome(result, `The host default profile is now ${choice}.`);
    },
  },
  {
    name: 'audio',
    usage: 'audio on|off',
    summary: 'Allow or block sharing desktop audio.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const allowed = onOff(positionals[0]);
      const state = allowed ? 'on' : 'off';
      const result = await context.updatePolicy(
        `Turn desktop audio ${state}`,
        (policy) => edits.setAudio(policy, allowed),
        { yes: flags.yes === true },
      );
      return outcome(result, `Desktop audio is now ${state}.`);
    },
  },
  {
    name: 'access',
    usage: 'access [approval|available]',
    summary: 'Show or set default keyboard and mouse access for new connections.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      if (positionals.length && !['approval', 'available'].includes(positionals[0]))
        throw new UsageError('Use approval or available.');
      const access = positionals.length
        ? await context.saveAccess(positionals[0])
        : context.access();
      return { text: formatAccess(access), data: access };
    },
  },
];
```

In `apps/server/src/cli/commands.mjs`, add the import after the `pairs` import:

```js
import { settingsCommands } from './commands/settings.mjs';
```

and replace `export const commands = [...generalCommands];` with:

```js
export const commands = [...generalCommands, ...settingsCommands];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test apps/server/tests/cli-commands.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 6: Leave uncommitted**

No commit.

---

### Task 8: Profile, client customization and show commands

**Files:**
- Modify: `apps/server/src/cli/format.mjs`
- Create: `apps/server/src/cli/commands/profiles.mjs`
- Modify: `apps/server/src/cli/commands.mjs`
- Test: `apps/server/tests/cli-commands.test.mjs` (append)

**Interfaces:**
- Consumes: Task 4 edits, Task 5 `resolveProfile`, Task 6 helpers, Task 7 `formatAccess`, `profileName`
- Produces:
  - `format.mjs`: `formatProfiles(profiles, policy)`, `formatOptions(policy)`, `optionLabel(kind, value)`
  - `commands/profiles.mjs`: `profileCommands` — `profiles`, `profile add|edit|duplicate|remove|enable|disable|move`, `client-mode`, `options`, `options add|remove`, `show`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/tests/cli-commands.test.mjs`:

```js
test('profiles list in client order; profile add uses host defaults and slug IDs', async (t) => {
  const { run, context } = await offline(t);
  assert.match(
    (await run('profiles')).text,
    /^1\s+iphone-720p-test\s+iPhone 720p\s+1280×720\s+15\s+1 Mbit\/s\s+yes\s+Conservative starting point for iPhone$/m,
  );
  assert.equal(
    (await run('profile add "Office desk" --fps 60 --description "Desk monitor"')).text,
    'Added profile "Office desk" with ID office-desk.',
  );
  assert.deepEqual(context.policy().profiles.at(-1), {
    id: 'office-desk',
    name: 'Office desk',
    description: 'Desk monitor',
    enabled: true,
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateKbps: 4000,
    frameDelivery: 'fixed',
  });
  assert.equal(
    (await run('profile add "Office desk" --disabled --size 1280x720 --bitrate 2500')).text,
    'Added profile "Office desk" with ID office-desk-2.',
  );
  await assert.rejects(run('profile add Wide --size 1921x1080'), /Output width and height must be even/);
  await assert.rejects(run('profile add Wide --size big'), usage(/^Sizes use WIDTHxHEIGHT/));
  await assert.rejects(run('profile add Fast --fps 61'), /Frame rate must be an integer from 1 to 60/);
});

test('profile edit, duplicate, enable, disable and remove follow host validation', async (t) => {
  const { run, context } = await offline(t);
  assert.equal(
    (
      await run(
        'profile edit balanced --name "Balanced HD" --size 1600x900 --fps 25 --bitrate 3500 --description Everyday --disabled',
      )
    ).text,
    'Updated profile "Balanced HD".',
  );
  assert.deepEqual(
    context.policy().profiles.find((profile) => profile.id === 'balanced'),
    {
      id: 'balanced',
      name: 'Balanced HD',
      description: 'Everyday',
      enabled: false,
      width: 1600,
      height: 900,
      fps: 25,
      bitrateKbps: 3500,
      frameDelivery: 'fixed',
    },
  );
  await assert.rejects(run('profile edit balanced'), usage(/^Give at least one change/));
  await assert.rejects(
    run('profile edit balanced --enabled --disabled'),
    usage(/^Use either --enabled or --disabled\./),
  );
  assert.equal(
    (await run('profile enable "balanced hd"')).text,
    'Profile "Balanced HD" is now available.',
  );
  assert.equal(
    (await run('profile duplicate balanced')).text,
    'Added profile "Copy of Balanced HD" with ID copy-of-balanced-hd.',
  );
  await run('default-profile desktop');
  await assert.rejects(
    run('profile remove desktop'),
    /Default profile must refer to an available profile; change the default first/,
  );
  await assert.rejects(run('profile disable desktop'), /change the default first/);
  assert.equal(
    (await run('profile remove copy-of-balanced-hd')).text,
    'Removed profile "Copy of Balanced HD".',
  );
  for (const id of ['iphone-720p-test', 'mobile', 'balanced', 'low-bandwidth'])
    await run(`profile disable ${id}`);
  await run('default-profile auto');
  await assert.rejects(run('profile disable desktop'), /At least one profile must remain available/);
  await assert.rejects(run('profile remove nope'), /No profile matches "nope"/);
});

test('profile move reorders only the presentation file', async (t) => {
  const { run, context, directory } = await offline(t);
  const revision = context.policy().revision;
  assert.equal((await run('profile move balanced 1')).text, 'Moved "Balanced" to position 1.');
  assert.equal((await run('profile move mobile down')).text, 'Moved "Mobile" to position 4.');
  const order = ['balanced', 'iphone-720p-test', 'desktop', 'mobile', 'low-bandwidth'];
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'profile-order.json'), 'utf8')), order);
  assert.deepEqual(
    (await run('profiles --json')).data.map((profile) => profile.id),
    order,
  );
  assert.equal(context.policy().revision, revision);
  await assert.rejects(run('profile move balanced up'), /Position must be from 1 to 5\./);
  await assert.rejects(run('profile move balanced sideways'), usage(/^Use up, down or a position number\./));
});

test('profile move refuses while a server instance is alive', async (t) => {
  const { run, directory } = await offline(t, { alive: () => true });
  await mkdir(join(directory, 'instances'));
  await writeFile(join(directory, 'instances', '99.json'), '{}');
  await assert.rejects(run('profile move balanced 1'), /VidVNC is running \(PID 99/);
});

test('client mode and allowed options edit the approved option lists', async (t) => {
  const { run, context } = await offline(t);
  assert.equal(
    (await run('client-mode options')).text,
    'Client customization is now Approved options.',
  );
  assert.equal((await run('options add size 3840x2160')).text, 'Allowed output size 3840×2160.');
  assert.equal((await run('options add framerate 60')).text, 'Allowed 60 fps.');
  assert.equal((await run('options remove bitrate 1000')).text, 'Removed 1 Mbit/s.');
  const options = context.policy().allowedOptions;
  assert.deepEqual(options.resolutions.at(-1), { width: 3840, height: 2160 });
  assert.deepEqual(options.frameRates, [15, 30, 60]);
  assert.deepEqual(options.bitratesKbps, [2000, 4000, 6000]);
  await assert.rejects(run('options add framerate 60'), /That option is already allowed/);
  await assert.rejects(run('options remove size 800x600'), /That option is not in the allowed list/);
  await run('options remove framerate 15');
  await run('options remove framerate 30');
  await assert.rejects(run('options remove framerate 60'), /Frame rates requires 1–64 choices/);
  await assert.rejects(run('options add colour 1'), usage(/^Choose size, framerate or bitrate\./));
  await assert.rejects(run('client-mode everything'), usage(/^Use profiles or options\./));
  assert.equal((await run('options --json')).data.clientMode, 'options');
  assert.equal(
    (await run('options')).text,
    [
      'Client customization: Approved options',
      'Output sizes: 960×540, 1280×720, 1920×1080, 2560×1440, 3840×2160',
      'Frame rates: 60 fps',
      'Video bitrates: 2, 4, 6 Mbit/s',
    ].join('\n'),
  );
});

test('show summarizes saved settings and --json returns policy, access and order', async (t) => {
  const { run } = await offline(t);
  await run('profile move desktop 1');
  const { data } = await run('show --json');
  assert.equal(data.profileOrder[0], 'desktop');
  assert.equal(data.access.defaultControl, 'approval');
  assert.equal(data.policy.schemaVersion, 1);
  const { text } = await run('show');
  assert.match(text, /^1\s+desktop\s+Desktop/m);
  assert.match(text, /^Client customization: Approved profiles only$/m);
  assert.match(text, /^Keyboard and mouse for new connections: Require host approval$/m);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test apps/server/tests/cli-commands.test.mjs`
Expected: the 11 earlier tests PASS; the 7 new tests FAIL with `Unknown command "profiles"` (and similar).

- [ ] **Step 3: Add profile and option formatting**

Append to `apps/server/src/cli/format.mjs`:

```js
export function formatProfiles(profiles, policy) {
  const rows = profiles.map((profile, index) => [
    index + 1,
    profile.id,
    profile.name,
    size(profile),
    profile.fps,
    mbps(profile.bitrateKbps),
    profile.enabled ? 'yes' : 'no',
    profile.description,
  ]);
  return [
    table(['#', 'ID', 'Name', 'Size', 'FPS', 'Bitrate', 'Available', 'Description'], rows),
    `Host default profile: ${profileName(policy, policy.defaultProfileId)}`,
  ].join('\n');
}

export function formatOptions(policy) {
  const { resolutions, frameRates, bitratesKbps } = policy.allowedOptions;
  const megabits = bitratesKbps.map((kbps) => Number((kbps / 1000).toFixed(3)));
  return [
    `Client customization: ${modeLabel(policy.clientMode)}`,
    `Output sizes: ${resolutions.map(size).join(', ')}`,
    `Frame rates: ${frameRates.join(', ')} fps`,
    `Video bitrates: ${megabits.join(', ')} Mbit/s`,
  ].join('\n');
}

export function optionLabel(kind, value) {
  if (kind === 'size') return `output size ${size(value)}`;
  return kind === 'framerate' ? `${value} fps` : mbps(value);
}
```

- [ ] **Step 4: Add the profile command group**

Create `apps/server/src/cli/commands/profiles.mjs`:

```js
import { UsageError } from '../usage-error.mjs';
import { expectArguments, outcome, parseSize, parseWhole } from '../arguments.mjs';
import {
  formatAccess,
  formatOptions,
  formatProfiles,
  modeLabel,
  optionLabel,
} from '../format.mjs';
import { resolveProfile } from '../resolve.mjs';
import * as edits from '../policy-edits.mjs';

const VALUE_FLAGS = { description: 'value', size: 'value', fps: 'value', bitrate: 'value' };
const confirmation = (flags) => ({ yes: flags.yes === true });

function profileValues(flags) {
  const values = {};
  if (flags.name !== undefined) values.name = flags.name;
  if (flags.description !== undefined) values.description = flags.description;
  if (flags.size !== undefined) Object.assign(values, parseSize(flags.size));
  if (flags.fps !== undefined) values.fps = parseWhole(flags.fps, 'Frame rate');
  if (flags.bitrate !== undefined) values.bitrateKbps = parseWhole(flags.bitrate, 'Bitrate');
  if (flags.enabled && flags.disabled) throw new UsageError('Use either --enabled or --disabled.');
  if (flags.enabled) values.enabled = true;
  if (flags.disabled) values.enabled = false;
  return values;
}

function parseOption(kind, value) {
  if (kind === 'size') return parseSize(value);
  if (kind === 'framerate') return parseWhole(value, 'Frame rate');
  if (kind === 'bitrate') return parseWhole(value, 'Bitrate');
  throw new UsageError('Choose size, framerate or bitrate.');
}

const toggleCommands = ['enable', 'disable'].map((action) => ({
  name: `profile ${action}`,
  usage: `profile ${action} <profile>`,
  summary: action === 'enable' ? 'Make a profile available to clients.' : 'Hide a profile from clients.',
  where: 'both',
  mayDisconnect: true,
  run: async (context, { positionals, flags }) => {
    expectArguments(positionals, 1);
    const profile = resolveProfile(context.policy().profiles, positionals[0]);
    const enabled = action === 'enable';
    const result = await context.updatePolicy(
      enabled ? `Make profile "${profile.name}" available` : `Hide profile "${profile.name}"`,
      (policy) => edits.setProfileEnabled(policy, profile.id, enabled),
      confirmation(flags),
    );
    return outcome(result, `Profile "${profile.name}" is now ${enabled ? 'available' : 'hidden'}.`);
  },
}));

const optionCommands = ['add', 'remove'].map((action) => ({
  name: `options ${action}`,
  usage: `options ${action} size WxH | framerate N | bitrate KBPS`,
  summary:
    action === 'add'
      ? 'Allow another output size, frame rate or bitrate.'
      : 'Remove an allowed output size, frame rate or bitrate.',
  where: 'both',
  mayDisconnect: true,
  run: async (context, { positionals, flags }) => {
    expectArguments(positionals, 2);
    const [kind, text] = positionals;
    const value = parseOption(kind, text);
    const label = optionLabel(kind, value);
    const result = await context.updatePolicy(
      `${action === 'add' ? 'Allow' : 'Remove'} ${label}`,
      (policy) =>
        action === 'add'
          ? edits.addAllowedOption(policy, kind, value)
          : edits.removeAllowedOption(policy, kind, value),
      confirmation(flags),
    );
    return outcome(result, `${action === 'add' ? 'Allowed' : 'Removed'} ${label}.`);
  },
}));

export const profileCommands = [
  {
    name: 'profiles',
    usage: 'profiles',
    summary: 'List streaming profiles in the order clients see them.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const profiles = await context.orderedProfiles();
      return { text: formatProfiles(profiles, context.policy()), data: profiles };
    },
  },
  {
    name: 'profile add',
    usage:
      'profile add <name> [--size WxH] [--fps N] [--bitrate KBPS] [--description TEXT] [--disabled]',
    summary: 'Create a profile. Defaults: 1920x1080, 30 fps, 4000 kbit/s, available.',
    where: 'both',
    mayDisconnect: true,
    flags: { ...VALUE_FLAGS, disabled: 'boolean' },
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const values = profileValues(flags);
      let created;
      const result = await context.updatePolicy(
        `Add profile "${positionals[0].trim()}"`,
        (policy) => {
          const added = edits.addProfile(policy, { ...values, name: positionals[0] });
          created = added.profile;
          return added.policy;
        },
        confirmation(flags),
      );
      return outcome(result, `Added profile "${created?.name}" with ID ${created?.id}.`);
    },
  },
  {
    name: 'profile edit',
    usage:
      'profile edit <profile> [--name TEXT] [--description TEXT] [--size WxH] [--fps N] [--bitrate KBPS] [--enabled|--disabled]',
    summary: 'Change a profile.',
    where: 'both',
    mayDisconnect: true,
    flags: { ...VALUE_FLAGS, name: 'value', enabled: 'boolean', disabled: 'boolean' },
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const changes = profileValues(flags);
      if (!Object.keys(changes).length)
        throw new UsageError('Give at least one change, for example --fps 60.');
      const profile = resolveProfile(context.policy().profiles, positionals[0]);
      const result = await context.updatePolicy(
        `Change profile "${profile.name}"`,
        (policy) => edits.editProfile(policy, profile.id, changes),
        confirmation(flags),
      );
      return outcome(result, `Updated profile "${changes.name?.trim() ?? profile.name}".`);
    },
  },
  {
    name: 'profile duplicate',
    usage: 'profile duplicate <profile>',
    summary: 'Copy a profile as "Copy of <name>".',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const profile = resolveProfile(context.policy().profiles, positionals[0]);
      let created;
      const result = await context.updatePolicy(
        `Duplicate profile "${profile.name}"`,
        (policy) => {
          const copy = edits.duplicateProfile(policy, profile.id);
          created = copy.profile;
          return copy.policy;
        },
        confirmation(flags),
      );
      return outcome(result, `Added profile "${created?.name}" with ID ${created?.id}.`);
    },
  },
  {
    name: 'profile remove',
    usage: 'profile remove <profile>',
    summary: 'Delete a profile.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const profile = resolveProfile(context.policy().profiles, positionals[0]);
      const result = await context.updatePolicy(
        `Remove profile "${profile.name}"`,
        (policy) => edits.removeProfile(policy, profile.id),
        confirmation(flags),
      );
      return outcome(result, `Removed profile "${profile.name}".`);
    },
  },
  ...toggleCommands,
  {
    name: 'profile move',
    usage: 'profile move <profile> up|down|<position>',
    summary: 'Change the order clients see profiles in. Never disconnects devices.',
    where: 'both',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 2);
      const profiles = await context.orderedProfiles();
      const profile = resolveProfile(profiles, positionals[0]);
      const from = profiles.indexOf(profile);
      const [, direction] = positionals;
      let target;
      if (direction === 'up') target = from - 1;
      else if (direction === 'down') target = from + 1;
      else if (/^\d{1,2}$/.test(direction)) target = Number(direction) - 1;
      else throw new UsageError('Use up, down or a position number.');
      if (target < 0 || target >= profiles.length)
        throw new Error(`Position must be from 1 to ${profiles.length}.`);
      const ids = profiles.map((row) => row.id);
      ids.splice(from, 1);
      ids.splice(target, 0, profile.id);
      await context.saveProfileOrder(ids);
      return { text: `Moved "${profile.name}" to position ${target + 1}.` };
    },
  },
  {
    name: 'client-mode',
    usage: 'client-mode profiles|options',
    summary: 'Let clients choose approved profiles only, or approved options.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const [mode] = positionals;
      if (!['profiles', 'options'].includes(mode)) throw new UsageError('Use profiles or options.');
      const label = modeLabel(mode);
      const result = await context.updatePolicy(
        `Set client customization to ${label}`,
        (policy) => edits.setClientMode(policy, mode),
        confirmation(flags),
      );
      return outcome(result, `Client customization is now ${label}.`);
    },
  },
  {
    name: 'options',
    usage: 'options',
    summary: 'Show client customization and the allowed options.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const policy = context.policy();
      return {
        text: formatOptions(policy),
        data: { clientMode: policy.clientMode, allowedOptions: policy.allowedOptions },
      };
    },
  },
  ...optionCommands,
  {
    name: 'show',
    usage: 'show',
    summary: 'Show all saved settings.',
    where: 'offline',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const policy = context.policy();
      const profiles = await context.orderedProfiles();
      const access = context.access();
      return {
        text: [
          formatProfiles(profiles, policy),
          formatOptions(policy),
          `${formatAccess(access)}\nDesktop audio: ${policy.allowAudio ? 'on' : 'off'}`,
        ].join('\n\n'),
        data: { policy, access, profileOrder: profiles.map((profile) => profile.id) },
      };
    },
  },
];
```

In `apps/server/src/cli/commands.mjs`, add after the settings import:

```js
import { profileCommands } from './commands/profiles.mjs';
```

and change the `commands` line to:

```js
export const commands = [...generalCommands, ...settingsCommands, ...profileCommands];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test apps/server/tests/cli-commands.test.mjs`
Expected: PASS, 18 tests.

- [ ] **Step 6: Leave uncommitted**

No commit.

---

### Task 9: Live context, console and session commands

**Files:**
- Modify: `apps/server/src/cli/format.mjs`
- Create: `apps/server/src/cli/commands/sessions.mjs`
- Modify: `apps/server/src/cli/commands.mjs`
- Create: `apps/server/src/cli/console.mjs`
- Test: `apps/server/tests/cli-console.test.mjs`
- Test: `apps/server/tests/cli-commands.test.mjs` (append)

**Interfaces:**
- Consumes: `PolicyController.replace(candidate, revision, disconnect)`, `AccessSettings.replace(value, revision)`, `DisplayInventory.rows`, `SessionStore.list()/disconnect()/password`, `StreamRuntime.status()/command({ action, sessionId, streamId })/control.revoke()/stopSession(sessionId)` (existing); Tasks 5–8
- Produces:
  - `format.mjs`: `formatSessions(status, numbers)`
  - `commands/sessions.mjs`: `sessionCommands` — `sessions`, `grant`, `revoke`, `stop`, `disconnect` (all `where: 'live'`)
  - `console.mjs`: `createLiveContext({ policy, access, inventory, runtime, sessionStore, profileOrderFile, directory, logDirectory, urls: () => string[], port, confirm })`; `startConsole({ input, output, errors?, createContext: ({ confirm }) => context }) -> { done: Promise<void>, close(): void }`
  - Confirmation rule: after a `[y/N]` prompt, the next input line is the answer (`y` or `yes`, case-insensitive, accepts); anything else, or end of input, declines. Lines after the answer queue as commands.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/tests/cli-commands.test.mjs`:

```js
test('live-only session commands are rejected offline with a hint', async (t) => {
  const { run } = await offline(t);
  await assert.rejects(
    run('sessions'),
    usage(/^sessions is only available in the running server console\. Type config help sessions\.$/),
  );
  assert.match(
    (await run('help grant')).text,
    /^Usage: grant <session>\n.+\nAvailable only in the running server console\.$/,
  );
  assert.doesNotMatch((await run('help')).text, /^ {2}config sessions$/m);
});
```

Create `apps/server/tests/cli-console.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessSettings } from '../src/access-settings.mjs';
import { PolicyController } from '../src/policy-controller.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { StreamPolicyStore } from '../src/stream-policy-store.mjs';
import { createLiveContext, startConsole } from '../src/cli/console.mjs';
import { displayInventory } from './fixtures/cli-displays.mjs';

// Real stores and session admission; only the media runtime is faked.
async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-console-'));
  const sessionStore = new SessionStore({ maxSessions: 2 });
  const calls = [];
  const policyFile = join(directory, 'stream-policy.json');
  const policy = new PolicyController(await StreamPolicyStore.open(policyFile), sessionStore, {
    shutdown: async () => {
      calls.push(['shutdown']);
    },
  });
  const access = await AccessSettings.open(join(directory, 'access-settings.json'));
  const streams = new Map();
  const runtime = {
    control: {
      revoke: async () => {
        calls.push(['revoke-all']);
      },
    },
    status: () => ({
      type: 'status',
      sessions: sessionStore.list().map((session) => ({
        id: session.sessionId,
        device: session.device,
        address: session.clientKey,
        health: 'Smooth',
        audio: true,
        control: 'View only',
        selectedStreamId: streams.get(session.sessionId)?.[0]?.id ?? null,
        streams: streams.get(session.sessionId) ?? [],
      })),
    }),
    command: async (command) => {
      calls.push(['command', command]);
    },
    stopSession: async (sessionId) => {
      calls.push(['stopSession', sessionId]);
    },
  };
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  const consoleSession = startConsole({
    input,
    output,
    errors: output,
    createContext: ({ confirm }) =>
      createLiveContext({
        policy,
        access,
        inventory: displayInventory(),
        runtime,
        sessionStore,
        profileOrderFile: join(directory, 'profile-order.json'),
        directory,
        logDirectory: join(directory, 'logs'),
        urls: () => ['http://192.168.1.2:4382', 'http://127.0.0.1:4382'],
        port: 4382,
        confirm,
      }),
  });
  t.after(async () => {
    if (!input.writableEnded) input.end();
    await consoleSession.done;
    sessionStore.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    policy,
    access,
    calls,
    streams,
    sessionStore,
    policyFile,
    done: consoleSession.done,
    all: () => text,
    end: () => input.end(),
    connect: (clientKey, userAgent) =>
      sessionStore.connect(sessionStore.password, clientKey, userAgent).sessionId,
    // Writes one line and waits until everything printed since then matches.
    async send(line, pattern) {
      const mark = text.length;
      input.write(`${line}\n`);
      for (let attempt = 0; attempt < 400 && !pattern.test(text.slice(mark)); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.match(text.slice(mark), pattern);
      return text.slice(mark);
    },
  };
}

test('live policy changes ask before disconnecting devices; declining keeps settings', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  await h.send(
    'audio off',
    /^Turn desktop audio off: 1 connected device will be disconnected\. Apply\? \[y\/N\] $/,
  );
  await h.send('n', /^No changes applied\.\n$/);
  assert.equal(h.policy.snapshot().allowAudio, true);
  assert.equal(h.sessionStore.list().length, 1);
  await h.send('audio off', /\[y\/N\] $/);
  await h.send('YES', /^Desktop audio is now off\.\n$/);
  assert.equal(h.policy.snapshot().allowAudio, false);
  assert.equal(h.sessionStore.list().length, 0);
  assert.deepEqual(h.calls, [['shutdown']]);
});

test('--yes skips the question, and nobody connected means no question', async (t) => {
  const h = await harness(t);
  const quiet = await h.send('client-mode options', /Client customization is now Approved options\.\n$/);
  assert.equal(quiet.includes('[y/N]'), false);
  h.connect('192.168.1.30', 'Mozilla/5.0 (Windows NT 10.0)');
  const skipped = await h.send('profile disable mobile --yes', /Profile "Mobile" is now hidden\.\n$/);
  assert.equal(skipped.includes('[y/N]'), false);
  assert.equal(h.sessionStore.list().length, 0);
});

test('end of input at the question applies nothing', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  await h.send('share 2 on', /\[y\/N\] $/);
  h.end();
  await h.done;
  assert.match(h.all(), /\[y\/N\] \nNo changes applied\.\n$/);
  assert.equal(h.policy.snapshot().displaySharing, null);
});

test('access and profile order save without disconnecting devices', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  const saved = await h.send(
    'access available',
    /^Keyboard and mouse for new connections: Allow when available\n$/,
  );
  assert.equal(saved.includes('[y/N]'), false);
  assert.equal(h.access.snapshot().defaultControl, 'available');
  await h.send('profile move balanced 1', /^Moved "Balanced" to position 1\.\n$/);
  assert.equal(h.sessionStore.list().length, 1);
});

test('session commands use console numbers and stream IDs and never print session IDs', async (t) => {
  const h = await harness(t);
  const phone = h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  const laptop = h.connect('192.168.1.30', 'Mozilla/5.0 (Windows NT 10.0)');
  h.streams.set(phone, [
    { id: 'stream-a', name: 'Main', width: 1280, height: 720, targetFps: 15, profile: 'iphone-720p-test' },
  ]);
  const list = await h.send('sessions', /Waiting for a display stream\.\n$/);
  assert.equal(
    list,
    [
      '#1  iPhone · 192.168.1.20 · Smooth · audio on · view only',
      '    Stream    Display  Size      Target  Profile',
      '    stream-a  Main     1280×720  15 fps  iphone-720p-test',
      '#2  Windows browser · 192.168.1.30 · Smooth · audio on · view only',
      '    Waiting for a display stream.',
      '',
    ].join('\n'),
  );
  await h.send('grant #2', /^Device #2 has not selected a display stream yet\.\n$/);
  await h.send('grant stream-a', /^Granted control to device #1\.\n$/);
  await h.send('stop stream-a', /^Stream stopped\.\n$/);
  await h.send('revoke', /^Control revoked\.\n$/);
  await h.send('revoke #1', /^Revoked control from device #1\.\n$/);
  await h.send('disconnect #2', /^Disconnected device #2\.\n$/);
  await h.send('disconnect #2', /^No connected device matches #2\. Use sessions to list them\.\n$/);
  await h.send('show', /^show is only available as config show\. Type help show\.\n$/);
  await h.send('info', /Password\s+[A-Z]{4}-[A-Z]{4}\n/);
  assert.deepEqual(h.calls, [
    ['command', { action: 'grant', sessionId: phone }],
    ['command', { action: 'stop-stream', sessionId: phone, streamId: 'stream-a' }],
    ['revoke-all'],
    ['command', { action: 'revoke', sessionId: phone }],
    ['stopSession', laptop],
  ]);
  assert.equal(h.all().includes(phone), false);
  assert.equal(h.all().includes(laptop), false);
});

test('a settings file changed elsewhere asks for a restart', async (t) => {
  const h = await harness(t);
  const other = await StreamPolicyStore.open(h.policyFile);
  await other.replace({ ...other.snapshot(), allowAudio: false }, 0);
  await h.send(
    'audio off',
    /^Configuration changed on disk; reload before saving\. Restart the server to reload settings\.\n$/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test apps/server/tests/cli-console.test.mjs apps/server/tests/cli-commands.test.mjs`
Expected: `cli-console.test.mjs` FAILS with `Cannot find module '...src/cli/console.mjs'`; the new commands test FAILS with `Unknown command "sessions"`; the 18 earlier commands tests PASS.

- [ ] **Step 3: Add session formatting**

Append to `apps/server/src/cli/format.mjs`:

```js
// Rows come from runtime.status(); row.id is a bearer credential and is never printed.
export function formatSessions(status, numbers) {
  numbers.prune(new Set(status.sessions.map((row) => row.id)));
  if (!status.sessions.length) return 'No connected devices.';
  return status.sessions
    .map((row) => {
      const control = row.control === 'Granted' ? 'control granted' : 'view only';
      const header = `#${numbers.number(row.id)}  ${clean(row.device)} · ${clean(row.address)} · ${row.health} · audio ${row.audio ? 'on' : 'off'} · ${control}`;
      if (!row.streams.length) return `${header}\n    Waiting for a display stream.`;
      const streams = table(
        ['Stream', 'Display', 'Size', 'Target', 'Profile'],
        row.streams.map((stream) => [
          stream.id,
          stream.name,
          stream.width && stream.height ? size(stream) : 'pending',
          stream.targetFps ? `${stream.targetFps} fps` : 'unknown',
          stream.profile,
        ]),
      );
      return `${header}\n${streams
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Add the session command group**

Create `apps/server/src/cli/commands/sessions.mjs`:

```js
import { capitalize, expectArguments } from '../arguments.mjs';
import { formatSessions } from '../format.mjs';
import { resolveSession } from '../resolve.mjs';

const findSession = (context, selector) =>
  resolveSession(context.sessions.status().sessions, context.sessions.numbers, selector);
const deviceLabel = (context, row) => `device #${context.sessions.numbers.number(row.id)}`;

export const sessionCommands = [
  {
    name: 'sessions',
    usage: 'sessions',
    summary: 'List connected devices and their display streams.',
    where: 'live',
    run: (context, { positionals }) => {
      expectArguments(positionals, 0);
      return { text: formatSessions(context.sessions.status(), context.sessions.numbers) };
    },
  },
  {
    name: 'grant',
    usage: 'grant <session>',
    summary: 'Give keyboard and mouse control to a device (#number or one of its stream IDs).',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 1);
      const row = findSession(context, positionals[0]);
      const label = deviceLabel(context, row);
      if (!row.selectedStreamId)
        throw new Error(`${capitalize(label)} has not selected a display stream yet.`);
      await context.sessions.grant(row.id);
      return { text: `Granted control to ${label}.` };
    },
  },
  {
    name: 'revoke',
    usage: 'revoke [session]',
    summary: 'Take back keyboard and mouse control, from anyone or from one device.',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      if (!positionals.length) {
        await context.sessions.revoke();
        return { text: 'Control revoked.' };
      }
      const row = findSession(context, positionals[0]);
      await context.sessions.revoke(row.id);
      return { text: `Revoked control from ${deviceLabel(context, row)}.` };
    },
  },
  {
    name: 'stop',
    usage: 'stop <stream-id>',
    summary: 'Stop one display stream without disconnecting the device.',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 1);
      const [streamId] = positionals;
      const row = context.sessions
        .status()
        .sessions.find((session) => session.streams.some((stream) => stream.id === streamId));
      if (!row) throw new Error(`No active stream ${streamId}. Use sessions to list them.`);
      await context.sessions.stopStream(row.id, streamId);
      return { text: 'Stream stopped.' };
    },
  },
  {
    name: 'disconnect',
    usage: 'disconnect <session>',
    summary: 'Disconnect a device (#number or one of its stream IDs).',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 1);
      const row = findSession(context, positionals[0]);
      const label = deviceLabel(context, row);
      await context.sessions.disconnect(row.id);
      return { text: `Disconnected ${label}.` };
    },
  },
];
```

In `apps/server/src/cli/commands.mjs`, add after the profiles import:

```js
import { sessionCommands } from './commands/sessions.mjs';
```

and change the `commands` line to:

```js
export const commands = [
  ...generalCommands,
  ...settingsCommands,
  ...profileCommands,
  ...sessionCommands,
];
```

- [ ] **Step 5: Write the live context and console**

Create `apps/server/src/cli/console.mjs`:

```js
import { createInterface } from 'node:readline';
import { applyProfileOrder, saveProfileOrder } from '../profile-order.mjs';
import { executeLine } from './commands.mjs';
import { withConflictAdvice } from './conflict-advice.mjs';
import { accessLabel } from './format.mjs';
import { SessionNumbers } from './resolve.mjs';

const RESTART = 'Restart the server to reload settings.';

// Same objects and save path as the host's owner pipe.
export function createLiveContext({
  policy,
  access,
  inventory,
  runtime,
  sessionStore,
  profileOrderFile,
  directory,
  logDirectory,
  urls,
  port,
  confirm,
}) {
  const saving = async (write) => {
    try {
      return await write();
    } catch (error) {
      throw withConflictAdvice(error, RESTART);
    }
  };
  return {
    mode: 'live',
    policy: () => policy.snapshot(),
    async updatePolicy(summary, edit, { yes = false } = {}) {
      const connected = sessionStore.list().length;
      let confirmed = false;
      if (connected) {
        confirmed =
          yes ||
          (await confirm(
            `${summary}: ${connected} connected device${connected === 1 ? '' : 's'} will be disconnected. Apply?`,
          ));
        if (!confirmed) return { applied: false };
      }
      // Rebuild after the question so waiting at the prompt cannot cause a revision conflict.
      const current = policy.snapshot();
      return saving(async () => ({
        applied: true,
        policy: await policy.replace(await edit(current), current.revision, confirmed),
      }));
    },
    access: () => access.snapshot(),
    saveAccess: (value) => saving(() => access.replace(value, access.snapshot().revision)),
    orderedProfiles: () => applyProfileOrder(profileOrderFile, policy.snapshot().profiles),
    saveProfileOrder: (ids) => saveProfileOrder(profileOrderFile, ids),
    displays: async () => inventory.rows,
    async info() {
      return [
        ['Connect', urls().join(', ')],
        ['Password', sessionStore.password],
        ['Diagnostics', `http://127.0.0.1:${port}/diagnostics (this PC only)`],
        ['Data folder', directory],
        ['Log folder', logDirectory],
        ['Default control', accessLabel(access.snapshot().defaultControl)],
      ];
    },
    sessions: {
      numbers: new SessionNumbers(),
      status: () => runtime.status(),
      grant: (sessionId) => runtime.command({ action: 'grant', sessionId }),
      revoke: (sessionId) =>
        sessionId === undefined
          ? runtime.control.revoke()
          : runtime.command({ action: 'revoke', sessionId }),
      stopStream: (sessionId, streamId) =>
        runtime.command({ action: 'stop-stream', sessionId, streamId }),
      async disconnect(sessionId) {
        sessionStore.disconnect(sessionId);
        await runtime.stopSession(sessionId);
      },
    },
  };
}

export function startConsole({ input, output, errors = output, createContext }) {
  const lines = [];
  let closed = false;
  let wake = () => {};
  const reader = createInterface({ input, terminal: false, crlfDelay: Infinity });
  reader.on('line', (line) => {
    lines.push(line);
    wake();
  });
  reader.on('close', () => {
    closed = true;
    wake();
  });
  const nextLine = async () => {
    while (!lines.length && !closed) await new Promise((resolve) => (wake = resolve));
    return lines.length ? lines.shift() : null;
  };
  const confirm = async (question) => {
    output.write(`${question} [y/N] `);
    const answer = await nextLine();
    if (answer === null) output.write('\n');
    return /^\s*y(es)?\s*$/i.test(answer ?? '');
  };
  const context = createContext({ confirm });
  const done = (async () => {
    // One command at a time; lines typed meanwhile wait in the queue.
    for (let line = await nextLine(); line !== null; line = await nextLine()) {
      if (!line.trim()) continue;
      try {
        const result = await executeLine(context, line);
        if (result.text) output.write(`${result.text}\n`);
      } catch (error) {
        errors.write(`${error.message}\n`);
      }
    }
  })();
  return { done, close: () => reader.close() };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test apps/server/tests/cli-console.test.mjs apps/server/tests/cli-commands.test.mjs`
Expected: PASS — 6 console tests and 19 commands tests.

- [ ] **Step 7: Leave uncommitted**

No commit.

---

### Task 10: Server integration, offline entry point and documentation

**Files:**
- Modify: `apps/server/src/main.mjs`
- Test: `apps/server/tests/cli-offline.test.mjs`
- Modify: `apps/server/tests/runtime-start-check.mjs` (hardware check, not in the portable runner)
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `dataDirectory`, `settingsFiles`, `registerInstance` (Task 1); `seedDisplaySharing` (Task 4); `accessLabel` (Task 6); `runOffline` (Task 6); `createLiveContext`, `startConsole` (Task 9)
- Produces: `node apps/server/src/main.mjs config <command> [arguments]`; `npm run config -- <command> [arguments]`; `instances/<pid>.json` written by every server process and removed on shutdown

- [ ] **Step 1: Write the failing subprocess test**

Create `apps/server/tests/cli-offline.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../src/paths.mjs';

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), 'vidvnc-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    LOCALAPPDATA: home,
    HOME: home,
    VIDVNC_MEDIA_WORKER: join(home, 'missing-worker.exe'),
  };
  delete env.VIDVNC_RUNTIME_MANIFEST;
  delete env.VIDVNC_LOG_DIR;
  const config = (...args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [main, 'config', ...args], { env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  return { data: dataDirectory({ env, home }), config };
}

test('config with no command prints help without starting a server', async (t) => {
  const { config } = await sandbox(t);
  const result = await config();
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Commands:\n/);
  assert.match(result.stdout, /config share <display> on\|off/);
  assert.doesNotMatch(result.stdout, /^ {2}config sessions$/m);
  assert.equal(result.stderr, '');
});

test('offline edits persist between invocations and --json reads them back', async (t) => {
  const { config } = await sandbox(t);
  assert.equal((await config('access', 'available')).code, 0);
  assert.equal(JSON.parse((await config('access', '--json')).stdout).defaultControl, 'available');
  const added = await config('profile', 'add', 'Office desk', '--fps', '60');
  assert.equal(added.code, 0);
  assert.equal(added.stdout, 'Added profile "Office desk" with ID office-desk.\n');
  assert.equal((await config('profile', 'move', 'office-desk', '1')).code, 0);
  const shown = JSON.parse((await config('show', '--json')).stdout);
  assert.equal(shown.profileOrder[0], 'office-desk');
  assert.equal(shown.policy.profiles.find((profile) => profile.id === 'office-desk').fps, 60);
});

test('exit codes separate usage errors from failures', async (t) => {
  const { config } = await sandbox(t);
  assert.equal((await config('share')).code, 2);
  const live = await config('sessions');
  assert.equal(live.code, 2);
  assert.match(live.stderr, /only available in the running server console/);
  assert.equal((await config('profile', 'remove', 'nope')).code, 1);
  const displays = await config('displays');
  assert.equal(displays.code, 1);
  assert.match(displays.stderr, /^Display information is unavailable: /);
});

test('changes refuse while a registered server is alive and ignore stale records', async (t) => {
  const { data, config } = await sandbox(t);
  await mkdir(join(data, 'instances'), { recursive: true });
  const live = join(data, 'instances', `${process.pid}.json`);
  await writeFile(
    live,
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: 'cli', port: 4382 }),
  );
  const refused = await config('access', 'available');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`VidVNC is running \\(PID ${process.pid}, `));
  assert.equal((await config('access')).code, 0);
  await rm(live);
  const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise((resolve) => exited.on('close', resolve));
  await writeFile(join(data, 'instances', `${exited.pid}.json`), '{}');
  assert.equal((await config('access', 'available')).code, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/cli-offline.test.mjs`
Expected: FAIL. Without the `config` branch, `main.mjs` tries to start a server, the missing worker makes it print `Unable to start VidVNC…` and exit 1, so the help and exit-code assertions fail.

- [ ] **Step 3: Update imports in `main.mjs`**

In `apps/server/src/main.mjs`, replace:

```js
import { networkInterfaces, hostname, homedir } from 'node:os';
import { join } from 'node:path';
```

with:

```js
import { networkInterfaces, hostname } from 'node:os';
```

and after `import { AccessSettings } from './access-settings.mjs';` add:

```js
import { dataDirectory, settingsFiles } from './paths.mjs';
import { registerInstance } from './instances.mjs';
import { createLiveContext, startConsole } from './cli/console.mjs';
import { accessLabel } from './cli/format.mjs';
import { runOffline } from './cli/offline.mjs';
import { seedDisplaySharing } from './cli/policy-edits.mjs';
```

- [ ] **Step 4: Dispatch `config` before any server startup**

Replace:

```js
try {
  const desktop = process.argv.includes('--desktop');
```

with:

```js
if (process.argv[2] === 'config') {
  process.exitCode = await runOffline(process.argv.slice(3), {
    stdout: process.stdout,
    stderr: process.stderr,
    directory: dataDirectory(),
    logDirectory,
  });
} else {
  await serve();
}

async function serve() {
try {
  const desktop = process.argv.includes('--desktop');
```

and replace the end of the file:

```js
    `Unable to start VidVNC: ${error.message}\nRun build-native.cmd and check the NVIDIA driver / GStreamer SDK.`,
  );
  process.exitCode = 1;
}
```

with:

```js
    `Unable to start VidVNC: ${error.message}\nRun build-native.cmd and check the NVIDIA driver / GStreamer SDK.`,
  );
  process.exitCode = 1;
}
}
```

Step 9 re-indents the file.

- [ ] **Step 5: Use shared settings paths and first-run seeding**

Replace:

```js
  const dataDirectory =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'VidVNC')
      : join(homedir(), 'Library', 'Application Support', 'VidVNC');
  let runtime;
  const policy = new PolicyController(
    await StreamPolicyStore.open(join(dataDirectory, 'stream-policy.json')),
    store,
    { shutdown: () => (runtime ? runtime.stopAll() : media.shutdown()) },
  );
  const inventory = new DisplayInventory(info.displays || []);
  if (policy.snapshot().displaySharing === null) {
    const initial = policy.snapshot();
    const primary = inventory.rows.find((display) => display.primary && display.persistent);
    initial.displaySharing = primary ? { [primary.id]: true } : {};
    await policy.replace(initial, initial.revision);
  }
  const access = await AccessSettings.open(join(dataDirectory, 'access-settings.json'));
```

with:

```js
  const directory = dataDirectory();
  const files = settingsFiles(directory);
  let runtime;
  const policy = new PolicyController(await StreamPolicyStore.open(files.policy), store, {
    shutdown: () => (runtime ? runtime.stopAll() : media.shutdown()),
  });
  const inventory = new DisplayInventory(info.displays || []);
  if (policy.snapshot().displaySharing === null) {
    const initial = policy.snapshot();
    await policy.replace(seedDisplaySharing(initial, inventory.rows), initial.revision);
  }
  const access = await AccessSettings.open(files.access);
```

and replace `profileOrderFile: join(dataDirectory, 'profile-order.json'),` with `profileOrderFile: files.profileOrder,`.

- [ ] **Step 6: Register the instance and share connection URLs**

Replace:

```js
  const port = Number(process.env.VIDVNC_PORT || 4382);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIDVNC_PORT');
  server.listen(port, process.env.VIDVNC_HOST || '0.0.0.0', () => {
    const urls = Object.values(networkInterfaces())
      .flat()
      .filter((n) => n.family === 'IPv4' && !n.internal)
      .map((n) => `http://${n.address}:${port}`);
    urls.push(`http://127.0.0.1:${port}`);
    if (desktop) {
      console.log(
        JSON.stringify({
          type: 'ready',
          urls,
```

with:

```js
  const port = Number(process.env.VIDVNC_PORT || 4382);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIDVNC_PORT');
  let releaseInstance = () => {};
  try {
    releaseInstance = registerInstance(files.instances, { mode: desktop ? 'desktop' : 'cli', port });
  } catch (error) {
    console.error(`Warning: offline config commands cannot detect this server (${error.message}).`);
  }
  process.on('exit', () => releaseInstance());
  const connectionUrls = () => [
    ...Object.values(networkInterfaces())
      .flat()
      .filter((n) => n.family === 'IPv4' && !n.internal)
      .map((n) => `http://${n.address}:${port}`),
    `http://127.0.0.1:${port}`,
  ];
  server.listen(port, process.env.VIDVNC_HOST || '0.0.0.0', () => {
    if (desktop) {
      console.log(
        JSON.stringify({
          type: 'ready',
          urls: connectionUrls(),
```

Replace the banner command line:

```js
    console.log(
      `Local commands: sessions, grant <stream-id>, revoke, disconnect <stream-id>. Default control: ${access.snapshot().defaultControl}.`,
    );
```

with:

```js
    console.log(
      `Type help for commands. Default control: ${accessLabel(access.snapshot().defaultControl)}.`,
    );
```

- [ ] **Step 7: Replace the console block and release the instance on stop**

Replace `  let owner;` with:

```js
  let owner;
  let consoleSession;
```

In `stop`, replace `    owner?.close();` with:

```js
    owner?.close();
    consoleSession?.close();
```

and replace:

```js
    await diagnostics.writes;
  };
```

with:

```js
    await diagnostics.writes;
    releaseInstance();
  };
```

Replace the whole non-desktop branch, from `  } else {` / `    owner = createInterface({ input: process.stdin });` / `    owner.on('line', async (line) => {` through its closing `    });` / `  }`, with:

```js
  } else {
    consoleSession = startConsole({
      input: process.stdin,
      output: process.stdout,
      errors: process.stderr,
      createContext: ({ confirm }) =>
        createLiveContext({
          policy,
          access,
          inventory,
          runtime,
          sessionStore: store,
          profileOrderFile: files.profileOrder,
          directory,
          logDirectory,
          urls: connectionUrls,
          port,
          confirm,
        }),
    });
  }
```

`createInterface` stays imported; the desktop owner pipe still uses it.

- [ ] **Step 8: Add the npm script**

In the root `package.json` `scripts`, after the `"start"` line add:

```json
    "config": "node apps/server/src/main.mjs config",
```

- [ ] **Step 9: Format and run the subprocess test**

Run: `npx prettier --write apps/server/src/main.mjs`
Run: `node --test apps/server/tests/cli-offline.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 10: Assert the instance lifecycle in the hardware startup check**

In `apps/server/tests/runtime-start-check.mjs`, replace `import { mkdtemp, rm } from 'node:fs/promises';` with:

```js
import { mkdtemp, readFile, rm } from 'node:fs/promises';
```

After `  const ready = await until((message) => message.type === 'ready');` add:

```js
  const instanceFile = join(directory, 'VidVNC', 'instances', `${child.pid}.json`);
  assert.equal(JSON.parse(await readFile(instanceFile, 'utf8')).mode, 'desktop');
```

After `  assert.equal(await exited, 0);` add:

```js
  await assert.rejects(readFile(instanceFile), { code: 'ENOENT' });
```

This script needs the Debug worker, GStreamer SDK and NVIDIA hardware. If they are available, run `node apps/server/tests/runtime-start-check.mjs` and expect `PASS: production startup…`. Otherwise record that it was not run.

- [ ] **Step 11: Document the CLI configuration**

In `README.md`, replace:

```md
Access defaults are stored separately in `access-settings.json` in the
per-user VidVNC data directory and also apply to the CLI server.
For CLI use, type `sessions` to list
public stream IDs, `grant <stream-id>` to authorize that device's selected stream,
`revoke` to release input permission, or `disconnect <stream-id>` to end its device
session. These commands are local-only, not HTTP administration endpoints. Esc
releases local control/exits fullscreen; Ctrl+C stops the server and all its workers.
Diagnostics are at `http://127.0.0.1:4382/diagnostics` on the server PC.
```

with:

```md
Access defaults are stored separately in `access-settings.json` in the
per-user VidVNC data directory and also apply to the CLI server. Esc releases
local control/exits fullscreen; Ctrl+C stops the server and all its workers.
Diagnostics are at `http://127.0.0.1:4382/diagnostics` on the server PC.

### CLI server configuration

The CLI server can change every setting the Windows host can. Type `help` in its
console for the full list:

- Displays: `displays`, `share <display> on|off`, `display-default <display> <profile>|host`,
  `default-profile auto|<profile>`, `audio on|off`
- Profiles: `profiles`, `profile add|edit|duplicate|remove|enable|disable|move …`
- Client customization: `client-mode profiles|options`, `options`,
  `options add|remove size WxH|framerate N|bitrate KBPS`
- Access: `access [approval|available]`
- Devices: `sessions`, `grant <session>`, `revoke [session]`, `stop <stream-id>`,
  `disconnect <session>`
- `info` shows connection addresses, the password, and the data and log folders.

Displays use the numbers shown by `displays` (primary first). Profiles accept their
ID or name. Devices use the `#number` shown by `sessions` or one of their stream IDs.
Changes that restart streaming ask before disconnecting connected devices; `--yes`
skips the question. Bitrates are in kbit/s. These commands are local-only, not HTTP
administration endpoints.

The same settings commands work without a running server, for example
`npm run config -- share 2 on` or `node apps/server/src/main.mjs config share 2 on`.
Read commands accept `--json`, and `config show --json` prints all saved settings.
While a server is running, offline changes are refused; use its console instead.
Exit codes: 0 success, 1 failure, 2 usage error.
```

- [ ] **Step 12: Leave uncommitted**

No commit.

---

### Task 11: Parity guard and final verification

**Files:**
- Test: `apps/server/tests/cli-parity.test.mjs`

**Interfaces:**
- Consumes: `commands`, `execute`, `executeLine` (Task 6, table complete after Task 9); `createOfflineContext` (Task 6); `rawDisplays` (Task 4); `defaultStreamPolicy` from `src/stream-policy.mjs`; `AccessSettings` from `src/access-settings.mjs`
- Produces: a guard that fails, naming the field, when a new policy, profile, allowed-options or access field has no CLI command that changes it

- [ ] **Step 1: Write the parity test**

The script edits every setting through CLI commands only. The diff records which fields each command changed. The expected field list comes from the schemas' default values, so adding a field to `defaultStreamPolicy()`, to a profile, to `allowedOptions` or to access settings makes this test fail until a command covers it. Profile fields count only when an existing profile is edited; adding a profile covers only `profiles[]`.

Create `apps/server/tests/cli-parity.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessSettings } from '../src/access-settings.mjs';
import { commands, execute, executeLine } from '../src/cli/commands.mjs';
import { createOfflineContext } from '../src/cli/offline.mjs';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';
import { rawDisplays } from './fixtures/cli-displays.mjs';

const script = [
  'share 2 on',
  'display-default 2 balanced',
  'default-profile desktop',
  'audio off',
  'client-mode options',
  'options add size 3840x2160',
  'options add framerate 60',
  'options add bitrate 8000',
  'access available',
  'profile add "Office desk"',
  'profile edit office-desk --name Office --description "Desk monitor" --size 2560x1440 --fps 60 --bitrate 12000',
  'profile disable office-desk',
  'profile move balanced 1',
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function expectedFields(directory) {
  const policy = defaultStreamPolicy();
  const access = (await AccessSettings.open(join(directory, 'none.json'))).snapshot();
  const skip = (keys, ...excluded) => keys.filter((key) => !excluded.includes(key));
  return [
    ...skip(Object.keys(policy), 'schemaVersion', 'revision', 'profiles', 'allowedOptions').map(
      (key) => `policy.${key}`,
    ),
    'profiles[]',
    ...skip(Object.keys(policy.profiles[0]), 'id', 'frameDelivery').map((key) => `profile.${key}`),
    ...Object.keys(policy.allowedOptions).map((key) => `allowedOptions.${key}`),
    ...skip(Object.keys(access), 'revision').map((key) => `access.${key}`),
    'profileOrder',
  ].sort();
}

function changedFields(before, after) {
  const fields = [];
  for (const key of Object.keys(after.policy)) {
    if (['schemaVersion', 'revision', 'profiles', 'allowedOptions'].includes(key)) continue;
    if (!same(before.policy[key], after.policy[key])) fields.push(`policy.${key}`);
  }
  const ids = (policy) => policy.profiles.map((profile) => profile.id).sort();
  if (!same(ids(before.policy), ids(after.policy))) fields.push('profiles[]');
  for (const profile of after.policy.profiles) {
    const previous = before.policy.profiles.find((row) => row.id === profile.id);
    if (!previous) continue;
    for (const key of Object.keys(profile))
      if (!same(previous[key], profile[key])) fields.push(`profile.${key}`);
  }
  for (const key of Object.keys(after.policy.allowedOptions))
    if (!same(before.policy.allowedOptions[key], after.policy.allowedOptions[key]))
      fields.push(`allowedOptions.${key}`);
  for (const key of Object.keys(after.access))
    if (key !== 'revision' && !same(before.access[key], after.access[key]))
      fields.push(`access.${key}`);
  if (before.profileOrder !== after.profileOrder) fields.push('profileOrder');
  return fields;
}

test('every editable setting has a CLI command that changes it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await createOfflineContext({
    directory,
    logDirectory: join(directory, 'logs'),
    listDisplays: async () => rawDisplays(),
    alive: () => false,
  });
  const state = async () => ({
    policy: context.policy(),
    access: context.access(),
    profileOrder: await readFile(join(directory, 'profile-order.json'), 'utf8').catch(() => null),
  });
  const covered = new Map();
  for (const line of script) {
    const before = await state();
    await executeLine(context, line);
    const fields = changedFields(before, await state());
    assert.notDeepEqual(fields, [], `${line} changed nothing`);
    for (const field of fields) if (!covered.has(field)) covered.set(field, line);
  }
  const missing = (await expectedFields(directory)).filter((field) => !covered.has(field));
  assert.deepEqual(missing, [], `No CLI command changes: ${missing.join(', ')}`);
});

test('every command has usage and help in both modes', async () => {
  for (const command of commands) {
    assert.ok(command.usage.startsWith(command.name), `${command.name} usage`);
    assert.ok(command.summary.endsWith('.'), `${command.name} summary`);
    for (const mode of ['live', 'offline']) {
      const { text } = await execute({ mode }, ['help', ...command.name.split(' ')]);
      assert.match(text, /^Usage: /, `${mode} help ${command.name}`);
    }
  }
});
```

- [ ] **Step 2: Run the parity test**

Run: `node --test apps/server/tests/cli-parity.test.mjs`
Expected: PASS, 2 tests. The guard is written after the commands exist, so it passes on its first run.

Check that it is not vacuous: temporarily delete the `'audio off',` line from `script` and run again. Expected: FAIL with `No CLI command changes: policy.allowAudio`. Restore the line and confirm PASS.

- [ ] **Step 3: Format**

Run: `npm run format:web`
Then check `git status --short`. Only files named in this plan should have changed. If the formatter changed other files, revert those with `git checkout -- <file>` after confirming the change came from formatting alone.

- [ ] **Step 4: Run the server suite once**

Run: `npm test --workspace @vidvnc/server`
Expected: every test passes, including the existing suites (`policy-controller`, `http-app`, `stream-runtime`, `profile-order` and the others). Read the full output and list every failing test by name; never truncate it with `tail` or `Select-Object -Last`. Fix failures before continuing.

- [ ] **Step 5: Hand the manual hardware acceptance to the user**

These checks need the NVIDIA machine and a second device, so the user runs them:

1. `npm start`. The banner ends with `Type help for commands. Default control: …`.
2. Type `displays` and check the numbers, sizes and sharing state. Type `share 2 on` (answer `y` if devices are connected).
3. Connect a browser from another device and confirm display 2 is offered.
4. In a second terminal, while the server runs: `npm run config -- access available`. Expected: refused with `VidVNC is running (PID …)`, exit code 1.
5. Stop the server with Ctrl+C. Confirm `%LOCALAPPDATA%\VidVNC\instances\` is empty, then run `npm run config -- access available` again. Expected: `Keyboard and mouse for new connections: …`, exit code 0.

- [ ] **Step 6: Leave uncommitted**

No commit. Report the changed files and test results, and wait for the user to ask for a commit.

---

### Task 12: README user instructions for the packaged builds

Added at the user's request during execution (2026-09-15). Packaged builds are self-contained: they rely only on a standard Windows install plus the graphics driver. User instructions must need no more than opening the native app, or one command to start the CLI server. The packages are specified in `docs/superpowers/specs/2026-09-12-windows-server-packaging-design.md` (current-user installer and portable CLI ZIP with `VidVNC.Server.cmd`) but are not produced yet, so the section carries a one-line status note.

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-13-windows-server-packaging.md` (one checklist line in section 5)

**Interfaces:**
- Consumes: the README section `### CLI server configuration` (Task 10) as the link target `#cli-server-configuration`; host behavior: the WinUI host starts sharing on launch and shows the address and password
- Produces: README section `## Install and run` placed before `## Build and run (Windows)`

- [ ] **Step 1: Add the user section**

In `README.md`, insert this block immediately before the line `## Build and run (Windows)`:

````md
## Install and run

> The packaged builds below are specified but not produced yet. Until they ship,
> use [Build and run (Windows)](#build-and-run-windows).

VidVNC comes in two self-contained Windows packages. Everything they need is
included, so you don't install Node.js, .NET, GStreamer or developer tools. You need:

- Windows 11 25H2 (build 26200) or later, x64
- An NVIDIA graphics card with its current driver

### VidVNC app

1. Run the VidVNC installer. It installs for your account only and does not need
   administrator rights.
2. Open **VidVNC** from the Start menu.

VidVNC starts sharing and shows the address and password. On another device on
your network, open the address in a browser and enter the password. If Windows
asks, allow VidVNC on private networks.

### VidVNC Server (command line)

Extract the VidVNC Server ZIP to any folder, then run this in that folder:

```text
VidVNC.Server.cmd
```

The server prints the address and password. Manage it by typing commands in the
same window; type `help` to list them (see
[CLI server configuration](#cli-server-configuration)). Press Ctrl+C to stop.
To change settings while the server is stopped, run
`VidVNC.Server.cmd config <command>`, for example `VidVNC.Server.cmd config access available`.

Both packages keep settings and logs in `%LOCALAPPDATA%\VidVNC`, so upgrading
keeps them. To remove the command-line server, stop it and delete its folder.
Use VidVNC only on a trusted local network, and don't forward its port.
````

- [ ] **Step 2: Keep the packaging plan honest**

In `docs/superpowers/plans/2026-09-13-windows-server-packaging.md`, section `## 5. Verification and documentation`, add this checklist line after the line that starts `- [ ] Exercise both staged products outside the checkout`:

```md
- [ ] Check the README `Install and run` instructions against the produced installer and CLI ZIP (Start-menu name, `VidVNC.Server.cmd`, `config` passthrough, prerequisites, nothing else to install) and remove its not-produced-yet note.
```

- [ ] **Step 3: Check links and formatting**

Documentation only; no tests. Confirm the anchors `#build-and-run-windows` and `#cli-server-configuration` match existing headings in `README.md`, and that no text outside the inserted block changed (`git diff README.md`).

- [ ] **Step 4: Leave uncommitted**

No commit.
