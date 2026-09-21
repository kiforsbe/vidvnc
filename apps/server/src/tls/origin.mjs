// Whether a request's `Origin` header is consistent with the scheme and host it actually
// arrived on. This sits in the path of every request, so it is kept as a pure function
// (scheme, host header, Origin header) -> boolean, testable exhaustively without a server.
//
// The comparison is done by parsing both sides with `URL` rather than comparing strings.
// Browsers omit the port from `Origin` when it is the scheme's default (an HTTPS request on
// 443 sends `Origin: https://example.com`, never `:443`), and `URL` normalises an explicit
// default port away the same way (`new URL('https://example.com:443').port === ''`), so
// parsing both sides through it makes the comparison agree on default ports regardless of
// which side spelled the port out. A naive string comparison against an expected origin that
// always appends the port does not have this property, and fails every request on the
// scheme's default port.
//
// `scheme` must be the scheme the connection actually arrived on (derived from the socket,
// e.g. `request.socket.encrypted`), never a client-supplied header such as
// `X-Forwarded-Proto` — trusting the client to declare the scheme would let it talk its way
// past this check.
//
// A request with no `Origin` header is accepted: `Origin` is a browser cross-origin signal,
// absent on plain navigations and non-browser clients, and its absence is not evidence of a
// cross-origin request.
export function isAllowedOrigin(scheme, hostHeader, originHeader) {
  if (!originHeader) return true;

  let expected, actual;
  try {
    expected = new URL(`${scheme}://${hostHeader}`);
    actual = new URL(originHeader);
  } catch {
    return false;
  }

  return (
    actual.protocol === expected.protocol &&
    actual.hostname === expected.hostname &&
    actual.port === expected.port
  );
}
