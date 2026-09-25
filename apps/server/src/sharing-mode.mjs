// How the desktop owner asked sharing to start (owner-start.mjs): 'local' or 'remote'.
// The owner chooses each time, and local-only is the default, so a remote-access setting saved
// earlier (for example from the CLI) never turns remote access on by itself when the host
// starts sharing. Remote access requires approved-only admission, so starting remote sets that
// too. If remote access can't be turned on yet, sharing starts local-only, and the returned
// notice says why, for the host to show.
export async function applySharingMode(access, mode) {
  const current = access.snapshot();
  const remote = mode === 'remote';
  if (current.remoteAccess === remote) return null;
  if (remote && current.publicHostnames.length === 0)
    return 'Remote access needs the name or address internet devices use for this PC. Add it under Settings, Remote access, then switch to remote access. Sharing started on the local network only.';
  try {
    await access.replace(
      remote ? { remoteAccess: true, connectionMode: 'approved-only' } : { remoteAccess: false },
      current.revision,
    );
    return null;
  } catch (error) {
    return remote
      ? `Remote access could not be turned on (${error.message}). Sharing started on the local network only.`
      : `Remote access is still on: it could not be turned off (${error.message}).`;
  }
}
