import { Interface, clearScreenDown, createInterface, cursorTo, moveCursor } from 'node:readline';

const endsLine = (chunk) =>
  typeof chunk === 'string' ? chunk.endsWith('\n') : chunk[chunk.length - 1] === 0x0a;

// Line editing, history and Tab completion for a console typed in a terminal. Text other
// code writes to output or errors appears above the prompt; the typed text is redrawn.
export function createTerminal({
  input,
  output,
  errors = output,
  completer,
  onLine,
  onClose,
  onInterrupt,
}) {
  const write = output.write.bind(output);
  // readline draws with the original write; only everyone else goes through the hooks.
  const screen = new Proxy(output, {
    get(target, key) {
      if (key === 'write') return write;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let ended = false;
  input.once('end', () => {
    ended = true;
  });
  const reader = createInterface({
    input,
    output: screen,
    terminal: true,
    completer,
    historySize: 100,
  });
  // `terminal: true` is an explicit promise that these streams support an interactive
  // terminal. Node otherwise replaces its editor with a minimal one when TERM=dumb,
  // dropping redraw, history navigation and completion even though we draw with ANSI.
  const forceInteractive = process.env.TERM === 'dumb';
  if (forceInteractive) reader._ttyWrite = Interface.prototype._ttyWrite.bind(reader);
  const refresh = () => {
    if (reader.paused) reader.resume();
    if (forceInteractive) reader._refreshLine();
    else reader.prompt(true);
  };
  let closing = false;
  const closeReader = reader.close.bind(reader);
  // Ctrl+D on an empty line would close the console while the server keeps running.
  reader.close = () => {
    if (closing || ended) closeReader();
  };

  let shown = false; // a prompt is on screen
  let remember = true; // the next line is a command worth recalling, not an answer
  let atLineStart = true;
  let newest;
  reader.on('history', (history) => {
    // The event also fires when a repeated line was not added; only drop a new entry.
    if (!remember && history[0] !== newest) history.shift();
    newest = history[0];
  });
  reader.on('line', (line) => {
    shown = false;
    remember = true;
    atLineStart = true;
    reader.setPrompt('');
    onLine(line);
  });
  reader.on('SIGINT', onInterrupt);

  const visible = () => shown || reader.line.length > 0;
  const erase = () => {
    moveCursor(screen, 0, -reader.getCursorPos().rows);
    cursorTo(screen, 0);
    clearScreenDown(screen);
  };
  const restore = [...new Set([output, errors])].map((stream) => {
    const original = stream.write;
    const own = Object.hasOwn(stream, 'write');
    stream.write = function (chunk, ...rest) {
      if (closing || !chunk.length) return original.call(this, chunk, ...rest);
      if (!visible()) {
        atLineStart = endsLine(chunk);
        return original.call(this, chunk, ...rest);
      }
      erase();
      const result = original.call(this, chunk, ...rest);
      if (!endsLine(chunk)) write('\n');
      // Drawn from a fresh line now, not from the rows the old prompt occupied.
      reader.prevRows = 0;
      refresh();
      return result;
    };
    return () => {
      if (own) stream.write = original;
      else delete stream.write;
    };
  });
  reader.on('close', () => {
    closing = true;
    for (const undo of restore) undo();
    onClose();
  });

  return {
    // Shows or replaces the prompt; typed text and the cursor stay where they are.
    show(prompt, { history = true } = {}) {
      remember = history;
      if (shown && reader.getPrompt() === prompt) return;
      if (!shown && !reader.line && !atLineStart) write('\n');
      shown = true;
      reader.setPrompt(prompt);
      refresh();
    },
    close() {
      if (closing) return;
      if (visible()) erase();
      shown = false;
      closing = true;
      closeReader();
    },
  };
}
