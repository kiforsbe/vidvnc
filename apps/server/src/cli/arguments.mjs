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
