import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// The desktop host owns stderr only while its server child is alive. Keep concise, sanitized
// lifecycle diagnostics on disk too, but never let a logging failure affect the server.
export function createServerLog({
  desktop = false,
  directory,
  now = () => new Date(),
  consoleError = console.error,
  makeDirectory = mkdir,
  append = appendFile,
} = {}) {
  return (message) => {
    consoleError(message);
    if (!desktop) return Promise.resolve();
    const line = `${now().toISOString()} ${message.endsWith('\n') ? message : `${message}\n`}`;
    return makeDirectory(directory, { recursive: true })
      .then(() => append(join(directory, 'server.log'), line))
      .catch(() => {});
  };
}
