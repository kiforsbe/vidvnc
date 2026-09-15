import { Writable } from 'node:stream';

// Just enough of a terminal for readline: text that wraps at the last column, CR and LF,
// and the cursor movement and erase sequences readline writes.
export class VirtualTerminal extends Writable {
  isTTY = true;
  lines = [''];
  row = 0;
  column = 0;

  constructor(columns = 80) {
    super({ decodeStrings: false });
    this.columns = columns;
  }

  _write(chunk, encoding, callback) {
    const text = String(chunk);
    for (let index = 0; index < text.length;) {
      const escape = /^\x1b\[(\d*)([A-Za-z])/.exec(text.slice(index));
      if (escape) {
        this.#control(escape[1] === '' ? undefined : Number(escape[1]), escape[2]);
        index += escape[0].length;
        continue;
      }
      const character = text[index++];
      if (character === '\r') this.column = 0;
      else if (character === '\n') this.#moveTo(this.row + 1, 0);
      else {
        if (this.column >= this.columns) this.#moveTo(this.row + 1, 0);
        const line = this.lines[this.row].padEnd(this.column);
        this.lines[this.row] = line.slice(0, this.column) + character + line.slice(this.column + 1);
        this.column++;
      }
    }
    callback();
  }

  #moveTo(row, column) {
    this.row = Math.max(0, row);
    this.column = Math.max(0, column);
    while (this.lines.length <= this.row) this.lines.push('');
  }

  #control(count, command) {
    const n = count ?? 1;
    if (command === 'A') this.#moveTo(this.row - n, this.column);
    else if (command === 'B') this.#moveTo(this.row + n, this.column);
    else if (command === 'C') this.column = Math.min(this.columns - 1, this.column + n);
    else if (command === 'D') this.column = Math.max(0, this.column - n);
    else if (command === 'G') this.column = n - 1;
    else if (command === 'J' || command === 'K') {
      this.lines[this.row] = count === 2 ? '' : this.lines[this.row].slice(0, this.column);
      if (command === 'J') this.lines.length = this.row + 1;
    }
  }

  // Visible rows without trailing blank ones.
  screen() {
    const rows = this.lines.map((line) => line.trimEnd());
    while (rows.length > 1 && rows.at(-1) === '') rows.pop();
    return rows;
  }

  current() {
    return this.lines[this.row].trimEnd();
  }
}
