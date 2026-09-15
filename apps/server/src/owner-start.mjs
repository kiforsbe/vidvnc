// Consume only the approval line. Leave queued stop commands for the desktop protocol.
export function waitForOwner(input) {
  return new Promise((resolve, reject) => {
    let line = '';
    function finish(error) {
      input.off('readable', read);
      input.off('end', ended);
      input.off('error', finish);
      if (error) reject(error);
      else resolve();
    }
    function ended() {
      finish(new Error('Desktop owner disconnected before startup'));
    }
    function read() {
      let byte;
      while ((byte = input.read(1)) !== null) {
        const character = byte.toString();
        if (character === '\n') {
          finish(
            line.replace(/\r$/, '') === '{"type":"start"}'
              ? undefined
              : new Error('Invalid desktop owner approval'),
          );
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
