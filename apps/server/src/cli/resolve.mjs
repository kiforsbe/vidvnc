import { clean } from './format.mjs';
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
  const named = profiles.filter((profile) => profile.name.toLowerCase() === selector.toLowerCase());
  if (exact) {
    // Same profile matched both ways (or only the ID matched): no ambiguity.
    const other = named.find((profile) => profile.id !== exact.id);
    if (other) {
      const exactName = `"${clean(exact.name)}"`;
      throw new Error(
        `"${selector}" matches the ID of ${exactName} and the name of another profile; ` +
          `use that profile's ID (${other.id}) or ${exactName} by name.`,
      );
    }
    return exact;
  }
  if (named.length > 1)
    throw new Error(`More than one profile is named "${selector}"; use its ID.`);
  if (!named.length)
    throw new Error(`No profile matches "${selector}". Use profiles to list them.`);
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
