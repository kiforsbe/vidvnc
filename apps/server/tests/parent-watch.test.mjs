import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watchParent } from '../src/parent-watch.mjs';

function clock() {
  const timers = new Set();
  return {
    setInterval: (callback) => {
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearInterval: (timer) => timers.delete(timer),
    tick: () => [...timers].forEach((timer) => timer.callback()),
    timers,
  };
}

test('the watch stops the server once, when the parent process changes', () => {
  const timers = clock();
  let ppid = 100;
  let stops = 0;
  watchParent(() => stops++, { ppid: () => ppid, ...timers });
  timers.tick();
  assert.equal(stops, 0);
  ppid = 1;
  timers.tick();
  timers.tick();
  assert.equal(stops, 1);
  assert.equal(timers.timers.size, 0);
});

test('cancelling the watch stops it', () => {
  const timers = clock();
  let ppid = 100;
  let stops = 0;
  const cancel = watchParent(() => stops++, { ppid: () => ppid, ...timers });
  cancel();
  ppid = 1;
  timers.tick();
  assert.equal(stops, 0);
});

// The real thing: a child watching its parent notices when that parent is killed.
test(
  'an orphaned process notices its parent has gone',
  { skip: process.platform === 'win32' && 'Windows never re-parents a process' },
  async () => {
    const watcher = `
      const { watchParent } = await import(${JSON.stringify(new URL('../src/parent-watch.mjs', import.meta.url).href)});
      watchParent(() => { process.stdout.write('stopped'); process.exit(0); }, { intervalMs: 20 });
      process.stdout.write('watching\\n');
      setTimeout(() => process.exit(2), 10000);
    `;
    // A parent shell that starts the watcher in the background and then is killed.
    const parent = spawn(
      'sh',
      ['-c', `"${process.execPath}" --input-type=module -e "$0" & wait`, watcher],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    const done = new Promise((resolve) => {
      parent.stdout.on('data', (data) => {
        output += data;
        if (output.includes('watching') && !parent.killed) parent.kill('SIGKILL');
        if (output.includes('stopped')) resolve();
      });
    });
    await done;
    assert.match(output, /stopped/);
  },
);
