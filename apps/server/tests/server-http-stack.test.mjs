import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLocalSessionScope } from '../src/local-session-scope.mjs';

const stackModule = await import('../src/server-http-stack.mjs').catch(() => ({}));

async function withStack(t, scope, appOptions = {}) {
  const stack = stackModule.createHttpStack({
    localSessionScope: scope,
    port: 0,
    hostPreference: '127.0.0.1',
    appOptions: { plaintextMode: 'lan-http', ...appOptions },
  });
  await new Promise((resolve) => stack.app.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        stack.app.close(resolve);
        stack.app.closeAllConnections();
      }),
  );
  return stack;
}

function invokeKey(app, peer, port) {
  const request = Readable.from([JSON.stringify({ key: app.sessionStore.password })]);
  request.url = '/api/key-start';
  request.method = 'POST';
  request.headers = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
  request.socket = { remoteAddress: peer, localPort: port, encrypted: false };
  const response = {
    headersSent: false,
    destroyed: false,
    setHeader() {},
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end() {},
  };
  return app.requestListener(request, response).then(() => response.status);
}

test('production assembly passes the injected local scope into ordinary HTTP routing', async (t) => {
  assert.equal(typeof stackModule.createHttpStack, 'function');
  const stack = await withStack(t, { bindAddresses: [], allows: () => false });
  const port = stack.app.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/info`)).status, 403);
});

test('assembly admits an eligible LAN password but denies off-link and public-scoped peers', async (t) => {
  const scope = createLocalSessionScope({
    adapters: [
      {
        kind: 'wifi',
        physical: true,
        up: true,
        profile: 'Private',
        address: '192.168.10.12',
        prefixLength: 24,
      },
    ],
  });
  const local = await withStack(t, scope);
  const localPort = local.app.address().port;
  assert.equal(await invokeKey(local.app, '192.168.10.44', localPort), 201);
  assert.equal(await invokeKey(local.app, '203.0.113.5', localPort), 403);

  const publicStack = await withStack(t, scope, { listenerScope: 'public' });
  assert.equal(
    await invokeKey(publicStack.app, '192.168.10.44', publicStack.app.address().port),
    401,
  );
});
