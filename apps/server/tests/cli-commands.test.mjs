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
  await assert.rejects(
    run('info extra'),
    usage(/^Wrong number of arguments\. Type config help info\.$/),
  );
  await assert.rejects(
    run('info --bogus'),
    usage(/^Unknown option --bogus\. Type config help info\.$/),
  );
  await assert.rejects(run('info --json'), usage(/^Unknown option --json\./));
  await assert.rejects(
    run('help "open'),
    usage(/^Unterminated quote\. Type config help for commands\.$/),
  );
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
  assert.equal(
    (await run(`share ${SIDE.slice(0, 8)} off`)).text,
    'Display 2 (Side) is now private.',
  );
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
  assert.equal(
    (await run('default-profile auto')).text,
    'The host default profile is now Automatic.',
  );
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
  assert.deepEqual(saved.data, {
    revision: 1,
    defaultControl: 'available',
    connectionMode: 'session-key',
    maxSessions: 4,
  });
  await assert.rejects(run('access always'), usage(/^Use approval or available\./));
});

test('max-devices shows and saves the connected-device limit', async (t) => {
  const { run } = await offline(t);
  assert.equal((await run('max-devices')).text, 'Connected devices at the same time: up to 4');
  const saved = await run('max-devices 1 --json');
  assert.equal(saved.data.maxSessions, 1);
  assert.equal(saved.text, 'Connected devices at the same time: up to 1');
  assert.equal((await run('max-devices 8')).text, 'Connected devices at the same time: up to 8');
  for (const value of ['0', '9', 'two', '2.5'])
    await assert.rejects(run(`max-devices ${value}`), usage(/^Use a number from 1 to 8\./));
});

test('connection-mode shows and saves the ordinary admission policy', async (t) => {
  const { run } = await offline(t);
  assert.equal((await run('connection-mode')).text, 'Ordinary connections: Reusable session key');
  const saved = await run('connection-mode one-time-keys --json');
  assert.equal(saved.data.connectionMode, 'one-time-keys');
  assert.equal(saved.text, 'Ordinary connections: One-time connection keys');
  await assert.rejects(
    run('connection-mode anything'),
    usage(/^Use session-key, one-time-keys, or approved-only\./),
  );
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
    /VidVNC is running \(PID 4242, .+4242\.json\)\. Change this setting in the VidVNC app instead\. If VidVNC is not running, delete that file and try again\.$/,
  );
  await assert.rejects(run('audio off'), /VidVNC is running/);
  assert.equal(
    (await run('access')).text,
    'Keyboard and mouse for new connections: Require host approval',
  );
  assert.match((await run('displays')).text, /Main/);
});

test('the running-instance refusal advises differently for desktop, cli and other modes', async (t) => {
  const { run, directory } = await offline(t, { alive: (pid) => pid === 4242 });
  await mkdir(join(directory, 'instances'));
  const setMode = (mode) =>
    writeFile(
      join(directory, 'instances', '4242.json'),
      JSON.stringify({ pid: 4242, startedAt: 1, mode, port: 4382 }),
    );
  await setMode('desktop');
  await assert.rejects(
    run('audio off'),
    /VidVNC is running \(PID 4242, .+4242\.json\)\. Change this setting in the VidVNC app instead\. If VidVNC is not running, delete that file and try again\.$/,
  );
  await setMode('cli');
  await assert.rejects(
    run('audio off'),
    /VidVNC is running \(PID 4242, .+4242\.json\)\. Type this command in its console instead\. If VidVNC is not running, delete that file and try again\.$/,
  );
  await setMode('unknown');
  await assert.rejects(
    run('audio off'),
    /VidVNC is running \(PID 4242, .+4242\.json\)\. Stop it first, or use its console or the VidVNC app\. If VidVNC is not running, delete that file and try again\.$/,
  );
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
  await assert.rejects(
    run('profile add Wide --size 1921x1080'),
    /Output width and height must be even/,
  );
  await assert.rejects(run('profile add Wide --size big'), usage(/^Sizes use WIDTHxHEIGHT/));
  await assert.rejects(
    run('profile add Fast --fps 61'),
    /Frame rate must be an integer from 1 to 60/,
  );
});

test('control characters in a profile name never reach profile add or profiles output', async (t) => {
  const { run } = await offline(t);
  const control = '\u009B';
  const raw = `Weird${control}Name`;
  const added = await run(`profile add "${raw}"`);
  assert.equal(added.text.includes(control), false);
  assert.match(added.text, /^Added profile "WeirdName" with ID weird-name.$/);
  const listed = await run('profiles');
  assert.equal(listed.text.includes(control), false);
  assert.match(listed.text, /WeirdName/);
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
  await assert.rejects(
    run('profile disable desktop'),
    /At least one profile must remain available/,
  );
  await assert.rejects(run('profile remove nope'), /No profile matches "nope"/);
});

test('profile move reorders only the presentation file', async (t) => {
  const { run, context, directory } = await offline(t);
  const revision = context.policy().revision;
  assert.equal((await run('profile move balanced 1')).text, 'Moved "Balanced" to position 1.');
  assert.equal((await run('profile move mobile down')).text, 'Moved "Mobile" to position 4.');
  const order = ['balanced', 'iphone-720p-test', 'desktop', 'mobile', 'low-bandwidth'];
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'profile-order.json'), 'utf8')),
    order,
  );
  assert.deepEqual(
    (await run('profiles --json')).data.map((profile) => profile.id),
    order,
  );
  assert.equal(context.policy().revision, revision);
  await assert.rejects(run('profile move balanced up'), /Position must be from 1 to 5\./);
  await assert.rejects(
    run('profile move balanced sideways'),
    usage(/^Use up, down or a position number\./),
  );
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
  await assert.rejects(
    run('options remove size 800x600'),
    /That option is not in the allowed list/,
  );
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

test('live-only session commands are rejected offline with a hint', async (t) => {
  const { run } = await offline(t);
  await assert.rejects(
    run('sessions'),
    usage(
      /^sessions is only available in the running server console\. Type config help sessions\.$/,
    ),
  );
  assert.match(
    (await run('help grant')).text,
    /^Usage: grant <session>\n.+\nAvailable only in the running server console\.$/,
  );
  assert.doesNotMatch((await run('help')).text, /^ {2}config sessions$/m);
});
