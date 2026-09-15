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
