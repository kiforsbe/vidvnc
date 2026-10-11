// Defence in depth for a server started by the desktop app: stop when the owner process has
// gone, even if its end of the owner pipe somehow stays open (decision D8 of the macOS
// design). On macOS and Linux an orphaned process is re-parented, so `process.ppid` changes;
// on Windows it never does and this watch is a harmless no-op next to the stop on pipe close.
export const PARENT_WATCH_INTERVAL_MS = 1000;

export function watchParent(
  onExit,
  {
    ppid = () => process.ppid,
    intervalMs = PARENT_WATCH_INTERVAL_MS,
    setInterval: every = setInterval,
    clearInterval: cancel = clearInterval,
  } = {},
) {
  const parent = ppid();
  const timer = every(() => {
    if (ppid() === parent) return;
    cancel(timer);
    onExit();
  }, intervalMs);
  // The watch alone never keeps the server running.
  timer.unref?.();
  return () => cancel(timer);
}
