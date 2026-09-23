import { normalizePassword } from './password-entry.js';

// Connection keys live in the fragment: browsers do not send it in the request,
// and the app removes it from the visible URL before making API calls.
export function connectionKeyFromFragment(fragment) {
  if (typeof fragment !== 'string') return null;
  const parameters = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  return normalizePassword(parameters.get('key') ?? '');
}

export function consumeConnectionKeyFromLocation(location, history) {
  const key = connectionKeyFromFragment(location.hash);
  if (key) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return key;
}
