import { createHttpApp } from './http-app.mjs';
import { createLanHttpListeners } from './lan-http-listeners.mjs';

export function createHttpStack({
  localSessionScope,
  port,
  hostPreference,
  appOptions = {},
  log = () => {},
}) {
  const app = createHttpApp({ ...appOptions, localSessionScope });
  const http = createLanHttpListeners({
    port,
    scope: localSessionScope,
    hostPreference,
    primaryServer: app,
    requestListener: app.requestListener,
    log,
  });
  return { app, http };
}
