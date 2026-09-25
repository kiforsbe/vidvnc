// The exact approval lines the desktop owner may send, and how each asks sharing to start.
// The plain form predates the choice and means local-only. Nothing else is accepted: no
// whitespace variants, no other fields.
const APPROVALS = new Map([
  ['{"type":"start"}', 'local'],
  ['{"type":"start","sharing":"local"}', 'local'],
  ['{"type":"start","sharing":"remote"}', 'remote'],
]);

// Consume only the approval line. Leave queued stop commands for the desktop protocol.
// Resolves with the requested sharing mode, 'local' or 'remote'.
export function waitForOwner(input) {
  return new Promise((resolve, reject) => {
    let line = '';
    function finish(error, mode) {
      input.off('readable', read);
      input.off('end', ended);
      input.off('error', finish);
      if (error) reject(error);
      else resolve(mode);
    }
    function ended() {
      finish(new Error('Desktop owner disconnected before startup'));
    }
    function read() {
      let byte;
      while ((byte = input.read(1)) !== null) {
        const character = byte.toString();
        if (character === '\n') {
          const mode = APPROVALS.get(line.replace(/\r$/, ''));
          finish(mode ? undefined : new Error('Invalid desktop owner approval'), mode);
          return;
        }
        line += character;
        if (line.length > 64) {
          finish(new Error('Desktop owner approval too long'));
          return;
        }
      }
    }
    input.on('readable', read);
    input.once('end', ended);
    input.once('error', finish);
    read();
  });
}
