import dgram from 'node:dgram';
import { RelayCore } from './relay.mjs';

// The media relay process's protocol loop (main.mjs is the entry point). The server starts it with its own Node executable and talks to it
// in JSON lines over stdin and stdout (design: docs/superpowers/specs/2026-09-26-r4-media-
// relay-and-privilege-split-design.md, "Relay protocol"). Commands come only from the parent's
// pipe; an invalid one ends the process, so a confused or compromised peer fails closed.
// The relay also ends when its stdin closes, so it never outlives the server.

const MAX_LINE_BYTES = 4096;
const METRICS_INTERVAL_MS = 2000;
const SWEEP_INTERVAL_MS = 1000;

export function runRelay({
  input = process.stdin,
  output = process.stdout,
  errors = process.stderr,
  createSocket = (options) => dgram.createSocket(options),
  exit = (code) => process.exit(code),
  now,
} = {}) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const core = new RelayCore({ createSocket, now, onEvent: send });
  let started = false;
  let finished = false;
  let buffered = '';
  const timers = [];

  const finish = (code, reason) => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearInterval(timer);
    try {
      core.close();
    } catch {
      // Closing is best effort; the process ends either way.
    }
    if (reason) errors.write(`media-relay: ${reason}\n`);
    input.off('data', onData);
    input.off('end', onEnd);
    exit(code);
  };

  const handle = async (message) => {
    if (message?.type === 'start' && !started) {
      started = true;
      try {
        const { port, families } = await core.start(message.port);
        timers.push(
          setInterval(() => core.sweep(), SWEEP_INTERVAL_MS),
          setInterval(() => send({ type: 'metrics', ...core.metrics() }), METRICS_INTERVAL_MS),
        );
        for (const timer of timers) timer.unref?.();
        send({ type: 'ready', port, families });
      } catch (error) {
        send({ type: 'failed', code: error?.code ?? null, message: String(error?.message) });
        finish(1);
      }
      return;
    }
    if (!started) return finish(2, 'a command arrived before start');
    if (message?.type === 'allow') {
      let streamId;
      try {
        streamId = core.allow(message);
      } catch (error) {
        // A well-formed registration the relay cannot hold (a limit, a duplicate) is refused;
        // a malformed one is a protocol violation.
        if (error.message === 'Invalid relay registration') return finish(2, error.message);
        return send({ type: 'refused', streamId: message.streamId, reason: error.message });
      }
      return send({ type: 'allowed', streamId });
    }
    if (message?.type === 'revoke' && typeof message.streamId === 'string') {
      core.revoke(message.streamId);
      return;
    }
    if (message?.type === 'stop') return finish(0);
    finish(2, 'invalid command');
  };

  // Lines are handled one at a time, in order, so `allow` is never answered before a
  // preceding `start` has bound the port.
  let queue = Promise.resolve();
  const onData = (chunk) => {
    buffered += String(chunk);
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return finish(2, 'unreadable command');
      }
      queue = queue.then(() => (finished ? undefined : handle(message)));
    }
    if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) finish(2, 'command too long');
  };
  const onEnd = () => finish(0);
  input.on('data', onData);
  input.on('end', onEnd);
  return { core, done: () => queue };
}
