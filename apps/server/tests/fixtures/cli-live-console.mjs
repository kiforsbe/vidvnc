import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessSettings } from '../../src/access-settings.mjs';
import { PolicyController } from '../../src/policy-controller.mjs';
import { SessionStore } from '../../src/session-store.mjs';
import { StreamPolicyStore } from '../../src/stream-policy-store.mjs';
import { createLiveContext, startConsole } from '../../src/cli/console.mjs';
import { connectionAddresses } from '../../src/tls/addresses.mjs';
import { displayInventory } from './cli-displays.mjs';
import { VirtualTerminal } from './virtual-terminal.mjs';

const pause = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Real stores and session admission; only the media runtime is faked. With terminal, input
// is typed into a virtual terminal instead of piped.
// tls is the live TLS state the addresses follow; a test flips it after the console starts.
// tlsListener: the running TLS listener (createTlsListener), for the `tls` status command's
// report()/status(). Distinct from `tls` above, which only feeds connectionAddresses's
// redirect-target status; most tests need neither.
export async function liveConsole(
  t,
  { terminal = false, tls = { active: false, port: null }, tlsListener } = {},
) {
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
  let owner = null;
  const runtime = {
    control: {
      revoke: async () => {
        calls.push(['revoke-all']);
        owner = null;
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
        control: owner === session.sessionId ? 'Granted' : 'View only',
        selectedStreamId: streams.get(session.sessionId)?.[0]?.id ?? null,
        streams: streams.get(session.sessionId) ?? [],
      })),
    }),
    command: async (command) => {
      calls.push(['command', command]);
      if (command.action === 'grant') owner = command.sessionId;
      if (command.action === 'revoke' && owner === command.sessionId) owner = null;
    },
    stopSession: async (sessionId) => {
      calls.push(['stopSession', sessionId]);
    },
  };
  const input = new PassThrough();
  let output;
  let text = '';
  if (terminal) {
    input.isTTY = true;
    input.setRawMode = () => {};
    output = new VirtualTerminal();
  } else {
    output = new PassThrough();
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      text += chunk;
    });
  }
  let stops = 0;
  const consoleSession = startConsole({
    input,
    output,
    errors: output,
    terminal,
    // Like the server: stopping closes the console.
    stop: () => {
      stops++;
      consoleSession.close();
    },
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
        addresses: () =>
          connectionAddresses({
            interfaces: () => ({
              Ethernet: [{ address: '192.168.1.2', family: 'IPv4', internal: false }],
              Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
            }),
            plaintextPort: 4382,
            tls,
          }),
        diagnosticsUrl: () => 'http://127.0.0.1:45999/diagnostics',
        confirm,
        tls: tlsListener,
      }),
  });
  t.after(async () => {
    consoleSession.close();
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
    directory,
    terminal: output,
    done: consoleSession.done,
    stops: () => stops,
    all: () => text,
    end: () => input.end(),
    write: (chunk) => input.write(chunk),
    close: () => consoleSession.close(),
    connect: (clientKey, userAgent) =>
      sessionStore.connect(sessionStore.password, clientKey, userAgent).sessionId,
    pause,
    // Waits until check() passes, then asserts it once more for a useful failure.
    async until(check) {
      for (let attempt = 0; attempt < 400 && !check(); attempt++) await pause();
      assert.ok(check(), terminal ? output.screen().join('\n') : text);
    },
    // Writes one line and waits until everything printed since then matches.
    async send(line, pattern) {
      const mark = text.length;
      input.write(`${line}\n`);
      for (let attempt = 0; attempt < 400 && !pattern.test(text.slice(mark)); attempt++)
        await pause();
      assert.match(text.slice(mark), pattern);
      return text.slice(mark);
    },
  };
}
