function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function wrongAuthority() {
  return Object.assign(new Error('Request target does not match this listener'), { status: 421 });
}

export function parseRequestTarget(raw, scheme, hostHeader, localPort) {
  if (typeof raw !== 'string' || typeof hostHeader !== 'string' || !hostHeader)
    throw badRequest('Host and request target are required');
  if (scheme !== 'http' && scheme !== 'https') throw badRequest('Invalid listener scheme');

  const originForm = raw.startsWith('/');
  if (!originForm && !/^https?:\/\//i.test(raw)) throw badRequest('Unsupported request target');

  let expected;
  let target;
  try {
    expected = new URL(`${scheme}://${hostHeader}`);
    target = new URL(originForm ? `${scheme}://${hostHeader}${raw}` : raw);
  } catch {
    throw badRequest('Invalid request target');
  }
  if (
    expected.username ||
    expected.password ||
    expected.pathname !== '/' ||
    expected.search ||
    expected.hash
  )
    throw badRequest('Invalid Host header');
  if (target.hash) throw badRequest('Fragments are not valid request targets');

  const expectedPort = Number(expected.port || (scheme === 'https' ? 443 : 80));
  if (
    expectedPort !== localPort ||
    (!originForm &&
      (target.protocol !== `${scheme}:` ||
        target.host !== expected.host ||
        target.username ||
        target.password))
  )
    throw wrongAuthority();

  return {
    route: target.pathname,
    pathAndQuery: target.pathname + target.search,
    originForm,
  };
}
