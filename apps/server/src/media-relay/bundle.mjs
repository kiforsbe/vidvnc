import { readFileSync } from 'node:fs';

// The media relay as one ES module source that imports only Node built-ins, so the relay can
// run from the command line (`node --input-type=module -e <source>`) and read no file at all:
// under the restricted token it cannot read the repository or install folder anyway, and Node's
// permission model then refuses every file read (design: docs/superpowers/specs/2026-09-26-r4-
// media-relay-and-privilege-split-design.md, Part B; media-relay.mjs).
//
// A small, deliberate bundler for exactly these modules, in dependency order. Their relative
// imports are dropped (the names are then in one scope), built-in imports are hoisted and
// de-duplicated, `export` is removed, and comment lines, blank lines and indentation are
// stripped to fit a Windows command line. It relies on the modules keeping these properties,
// which bundle's test checks: no clashing top-level names, no multi-line string literals.

const MODULES = ['./stun.mjs', '../peer-network.mjs', './relay.mjs', './protocol.mjs'];
// Windows limits a command line to 32,767 characters; leave room for the rest of it.
export const MAX_BUNDLE_CHARS = 28_000;

const IMPORT = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';\s*$/gm;

export function relayBundle({
  read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8'),
} = {}) {
  const builtins = new Set();
  const bodies = [];
  for (const path of MODULES) {
    const source = read(path);
    const body = source.replace(IMPORT, (statement, bindings, from) => {
      if (from.startsWith('node:'))
        builtins.add(`import ${bindings.replace(/\s+/g, ' ')} from '${from}';`);
      else if (!from.startsWith('.')) throw new Error(`The relay bundle cannot include ${from}`);
      return '';
    });
    bodies.push(body.replace(/^export\s+/gm, ''));
  }
  const code = [...builtins, ...bodies, 'runRelay();']
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('\n');
  if (code.length > MAX_BUNDLE_CHARS)
    throw new Error(`The relay bundle is ${code.length} characters, over ${MAX_BUNDLE_CHARS}`);
  return code;
}

// Node's permission model for the relay: no file system access, no child processes, native
// add-ons, worker threads or WASI; network allowed where Node restricts it. Not a boundary
// against a native exploit (that is the token's job), but it stops a JavaScript-level flaw.
export function permissionFlags(flags = process.allowedNodeEnvironmentFlags) {
  if (flags.has('--permission'))
    return ['--permission', ...(flags.has('--allow-net') ? ['--allow-net'] : [])];
  if (flags.has('--experimental-permission')) return ['--experimental-permission'];
  return [];
}
