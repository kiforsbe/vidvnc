// URL fragments never reach the HTTP server, but remove this one before any fetch or
// subsequent navigation so it cannot linger in the address bar or browser history.
export function takeDiagnosticsCapability(location, history) {
  const token = new URLSearchParams(location.hash.slice(1)).get('capability');
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    return null;
  }
  return token || null;
}

export function fetchDiagnostics(fetcher, stream, token, signal) {
  const url = '/api/diagnostics' + (stream ? '?stream=' + encodeURIComponent(stream) : '');
  return fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal });
}
