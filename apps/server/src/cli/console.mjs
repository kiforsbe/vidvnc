import { createInterface } from 'node:readline';
import { applyProfileOrder, saveProfileOrder } from '../profile-order.mjs';
import { executeLine } from './commands.mjs';
import { complete } from './completion.mjs';
import { withConflictAdvice } from './conflict-advice.mjs';
import { accessLabel, promptState } from './format.mjs';
import { SessionNumbers } from './resolve.mjs';
import { createTerminal } from './terminal.mjs';

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
      // Dry run before counting sessions or asking anything: a validation error surfaces
      // immediately (never after the question), and an edit that changes nothing is
      // applied silently, without asking or disconnecting anyone.
      const preview = await edit(policy.snapshot());
      if (JSON.stringify(preview) === JSON.stringify(policy.snapshot()))
        return { applied: true, policy: policy.snapshot() };
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
    async exit({ yes = false } = {}) {
      const connected = sessionStore.list().length;
      const confirmed =
        !connected ||
        yes ||
        (await confirm(
          `Stop sharing? ${connected} connected device${connected === 1 ? '' : 's'} will be disconnected.`,
        ));
      return confirmed ? { text: 'Stopping sharing…', exit: true } : { text: 'Still sharing.' };
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

// terminal: input is typed in a terminal, so show a prompt with line editing, history and
// Tab completion. Otherwise (piped input) read plain lines without echoing anything.
// stop: stops the server, after exit or Ctrl+C.
export function startConsole({
  input,
  output,
  errors = output,
  terminal = false,
  stop = () => {},
  createContext,
}) {
  const lines = [];
  let closed = false; // the input stream itself ended (EOF): drain what already queued
  let stopped = false; // close() was called: drop the queue and end the loop now
  let wake = () => {};
  let idle = false; // waiting at the vidvnc prompt, not running a command or asking
  const receive = (line) => {
    lines.push(line);
    wake();
  };
  const end = () => {
    closed = true;
    wake();
  };
  let screen;
  let reader;
  // question: a yes/no prompt, kept out of history; otherwise the next command.
  const nextLine = async (question) => {
    while (!stopped && !lines.length && !closed) {
      idle = question === undefined;
      screen?.show(question ?? promptText(), { history: idle });
      await new Promise((resolve) => (wake = resolve));
      idle = false;
    }
    return !stopped && lines.length ? lines.shift() : null;
  };
  const confirm = async (question) => {
    const prompt = `${question} [y/N] `;
    if (!screen) output.write(prompt);
    const answer = await nextLine(prompt);
    if (answer === null && !screen) output.write('\n');
    return /^\s*y(es)?\s*$/i.test(answer ?? '');
  };
  const context = createContext({ confirm });
  const promptText = () => {
    try {
      return `vidvnc [${promptState(context.sessions.status(), context.sessions.numbers)}]> `;
    } catch {
      return 'vidvnc> ';
    }
  };
  let timer;
  if (terminal) {
    screen = createTerminal({
      input,
      output,
      errors,
      completer: (line, callback) =>
        complete(context, line).then(
          (result) => callback(null, result),
          () => callback(null, [[], line]),
        ),
      onLine: receive,
      onClose: end,
      onInterrupt: () => {
        screen.close();
        output.write('Stopping sharing…\n');
        stop();
      },
    });
    // Devices connect and control changes hands while the prompt waits.
    timer = setInterval(() => {
      if (idle) screen.show(promptText());
    }, 1000);
    timer.unref?.();
  } else {
    reader = createInterface({ input, terminal: false, crlfDelay: Infinity });
    reader.on('line', receive);
    reader.on('close', end);
  }
  const done = (async () => {
    try {
      // One command at a time; lines typed meanwhile wait in the queue.
      for (let line = await nextLine(); line !== null; line = await nextLine()) {
        if (!line.trim()) continue;
        try {
          const result = await executeLine(context, line);
          if (result.text) output.write(`${result.text}\n`);
          if (result.exit) stop();
        } catch (error) {
          errors.write(`${error.message}\n`);
        }
      }
    } finally {
      clearInterval(timer);
    }
  })();
  return {
    done,
    // Stops accepting queued input right away; a prompt currently awaiting an answer
    // gets null (declines) and the loop exits once the in-flight command finishes.
    close: () => {
      stopped = true;
      lines.length = 0;
      clearInterval(timer);
      wake();
      if (screen) screen.close();
      else reader.close();
    },
  };
}
