import { networkInterfaces, hostname } from 'node:os';
import { StreamPolicyStore } from './stream-policy-store.mjs';
import { PolicyController } from './policy-controller.mjs';
import { createHttpApp } from './http-app.mjs';
import { NativeMedia, probe, listDisplays } from './native-media.mjs';
import { DisplayInventory } from './displays.mjs';
import { SessionStore } from './session-store.mjs';
import { createInterface } from 'node:readline';
import { Diagnostics } from './diagnostics.mjs';
import { logDirectory, runtimeManifest } from '@vidvnc/media-worker/runtime';
import { waitForOwner } from './owner-start.mjs';
import { StreamRuntime } from './stream-runtime.mjs';
import { AccessSettings } from './access-settings.mjs';
import { dataDirectory, settingsFiles } from './paths.mjs';
import { registerInstance } from './instances.mjs';
import { createLiveContext, startConsole } from './cli/console.mjs';
import { accessLabel } from './cli/format.mjs';
import { runOffline } from './cli/offline.mjs';
import { seedDisplaySharing } from './cli/policy-edits.mjs';
import { ApprovedClientStore } from './approved-clients.mjs';
import { CONNECTION_KEY_PURPOSES } from './connection-keys.mjs';
import { VIDEO_CODECS, CODEC_LABELS } from './video-codecs.mjs';

if (process.argv[2] === 'config') {
  process.exitCode = await runOffline(process.argv.slice(3), {
    stdout: process.stdout,
    stderr: process.stderr,
    directory: dataDirectory(),
    logDirectory,
  });
} else {
  await serve();
}

async function serve() {
  try {
    const desktop = process.argv.includes('--desktop');
    if (process.argv.includes('--await-owner')) {
      if (!desktop) throw new Error('--await-owner requires --desktop');
      await waitForOwner(process.stdin);
    }
    const info = probe();
    const hostCodecs = info.codecs?.length ? info.codecs : ['h264'];
    const directory = dataDirectory();
    const files = settingsFiles(directory);
    const access = await AccessSettings.open(files.access);
    const store = new SessionStore({ maxSessions: () => access.snapshot().maxSessions });
    const diagnostics = new Diagnostics({
      directory: logDirectory,
    });
    // Eight video sources plus two audio formats, each of which may briefly have a closing
    // predecessor; registry budgets decide what starts.
    const media = new NativeMedia({
      maxWorkers: 12,
      hostControl: true,
      diagnostics,
    });
    let runtime;
    const policy = new PolicyController(await StreamPolicyStore.open(files.policy), store, {
      shutdown: () => (runtime ? runtime.stopAll() : media.shutdown()),
    });
    const inventory = new DisplayInventory(info.displays || []);
    if (policy.snapshot().displaySharing === null) {
      const initial = policy.snapshot();
      await policy.replace(seedDisplaySharing(initial, inventory.rows), initial.revision);
    }
    const approvedClients = await ApprovedClientStore.open(files.approvedClients, {
      keys: store.keys,
    });
    runtime = new StreamRuntime({
      sessions: store,
      media,
      inventory,
      policy,
      access,
      approvedClients,
      videoCodecs: hostCodecs,
      videoBackends: info.backends,
    });
    const server = createHttpApp({
      runtime,
      serverName: hostname(),
      sessionStore: store,
      media,
      diagnostics,
      policy,
      inventory,
      profileOrderFile: files.profileOrder,
      approvedClients,
      access,
      display: { name: 'Primary display', width: info.width, height: info.height, refreshHz: 30 },
    });
    const port = Number(process.env.VIDVNC_PORT || 4382);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIDVNC_PORT');
    let releaseInstance = () => {};
    try {
      releaseInstance = registerInstance(files.instances, {
        mode: desktop ? 'desktop' : 'cli',
        port,
      });
    } catch (error) {
      console.error(
        `Warning: offline config commands cannot detect this server (${error.message}).`,
      );
    }
    process.on('exit', () => releaseInstance());
    const connectionUrls = () => [
      ...Object.values(networkInterfaces())
        .flat()
        .filter((n) => n.family === 'IPv4' && !n.internal)
        .map((n) => `http://${n.address}:${port}`),
      `http://127.0.0.1:${port}`,
    ];
    let owner;
    let consoleSession;
    let statusTimer;
    let inventoryTimer;
    let controlTimer;
    let refreshing = false;
    const inventoryAbort = new AbortController();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(statusTimer);
      clearInterval(inventoryTimer);
      clearInterval(controlTimer);
      inventoryAbort.abort();
      store.stop();
      owner?.close();
      consoleSession?.close();
      process.stdin.pause();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await runtime.shutdown();
      await closed;
      await diagnostics.writes;
      releaseInstance();
    };
    inventoryTimer = setInterval(async () => {
      if (stopping || refreshing) return;
      refreshing = true;
      try {
        const revision = inventory.revision;
        let rows;
        try {
          rows = await listDisplays(inventoryAbort.signal);
          new DisplayInventory(rows);
        } catch (error) {
          if (!stopping) console.error('Display refresh failed:', error.message);
          rows = [];
        }
        if (stopping) return;
        inventory.update(rows);
        if (revision !== inventory.revision) {
          await runtime.revalidate();
          if (desktop) console.log(JSON.stringify({ type: 'displays', displays: inventory.rows }));
        }
      } finally {
        refreshing = false;
      }
    }, 2000).unref();
    controlTimer = setInterval(() => {
      if (!stopping)
        runtime.control
          .renew()
          .catch((error) => console.error('Control renewal failed:', error.message));
    }, 2000).unref();
    if (desktop) {
      statusTimer = setInterval(() => {
        if (!stopping && !process.stdout.writableNeedDrain) {
          console.log(JSON.stringify(runtime.status()));
          console.log(JSON.stringify({ type: 'clients', ...approvedClients.status(store.list()) }));
        }
      }, 1000).unref();
      owner = createInterface({ input: process.stdin });
      owner.on('line', (line) => {
        if (line === '{"type":"stop"}') stop();
        else if (Buffer.byteLength(line) <= 128 * 1024) {
          try {
            const command = JSON.parse(line);
            if (
              command.type === 'connection-once-create' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              try {
                if (access.snapshot().connectionMode === 'approved-only')
                  throw new Error('Ordinary connection keys are not enabled');
                const once = store.keys.createOneTimeConnection({ ttlMs: 10 * 60_000 });
                console.log(
                  JSON.stringify({
                    type: 'connection-once-result',
                    requestId: command.requestId,
                    ok: true,
                    key: once.key,
                    expiresAt: once.expiresAt,
                  }),
                );
              } catch (error) {
                console.log(
                  JSON.stringify({
                    type: 'connection-once-result',
                    requestId: command.requestId,
                    ok: false,
                    error: error.message,
                  }),
                );
              }
            }
            if (
              command.type === 'client-setup-create' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              try {
                const setup = store.keys.createSetup({ ttlMs: 10 * 60_000 });
                console.log(
                  JSON.stringify({
                    type: 'client-setup-result',
                    requestId: command.requestId,
                    ok: true,
                    key: setup.key,
                    expiresAt: setup.expiresAt,
                  }),
                );
              } catch (error) {
                console.log(
                  JSON.stringify({
                    type: 'client-setup-result',
                    requestId: command.requestId,
                    ok: false,
                    error: error.message,
                  }),
                );
              }
            }
            if (
              command.type === 'client-request-command' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              typeof command.id === 'string' &&
              !stopping
            ) {
              const operation =
                command.action === 'approve'
                  ? approvedClients.approve(command.id)
                  : command.action === 'reject'
                    ? Promise.resolve(approvedClients.reject(command.id))
                    : Promise.reject(new Error('Invalid client request action'));
              operation.then(
                () => {
                  console.log(
                    JSON.stringify({
                      type: 'client-command-result',
                      requestId: command.requestId,
                      ok: true,
                    }),
                  );
                  console.log(
                    JSON.stringify({ type: 'clients', ...approvedClients.status(store.list()) }),
                  );
                },
                (error) =>
                  console.log(
                    JSON.stringify({
                      type: 'client-command-result',
                      requestId: command.requestId,
                      ok: false,
                      error: error.message,
                    }),
                  ),
              );
            }
            if (
              command.type === 'approved-client-command' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              typeof command.id === 'string' &&
              !stopping
            ) {
              const operation =
                command.action === 'remove'
                  ? approvedClients.remove(command.id).then(() => {
                      for (const session of store.list())
                        if (session.approvedClientId === command.id)
                          store.disconnect(session.sessionId);
                    })
                  : command.action === 'permission'
                    ? approvedClients.setPermission(command.id, command.permission)
                    : Promise.reject(new Error('Invalid approved-client action'));
              operation.then(
                () => {
                  console.log(
                    JSON.stringify({
                      type: 'client-command-result',
                      requestId: command.requestId,
                      ok: true,
                    }),
                  );
                  console.log(
                    JSON.stringify({ type: 'clients', ...approvedClients.status(store.list()) }),
                  );
                },
                (error) =>
                  console.log(
                    JSON.stringify({
                      type: 'client-command-result',
                      requestId: command.requestId,
                      ok: false,
                      error: error.message,
                    }),
                  ),
              );
            }
            if (
              command.type === 'access-set' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              const previousMode = access.snapshot().connectionMode;
              const reply = (ok, error, sessionKey) =>
                console.log(
                  JSON.stringify({
                    type: 'access-result',
                    requestId: command.requestId,
                    ok,
                    error,
                    access: access.snapshot(),
                    sessionKey,
                  }),
                );
              const changes = Object.fromEntries(
                ['defaultControl', 'connectionMode', 'maxSessions']
                  .filter((key) => command[key] !== undefined)
                  .map((key) => [key, command[key]]),
              );
              access.replace(changes, command.revision).then(
                () => {
                  let sessionKey;
                  if (access.snapshot().connectionMode !== previousMode) {
                    store.keys.clearPurpose(CONNECTION_KEY_PURPOSES.once);
                    sessionKey = store.rotateConnectionKey();
                  }
                  reply(true, undefined, sessionKey);
                },
                (error) => reply(false, error.message),
              );
            }
            if (
              command.type === 'session-command' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              const reply = (ok, error) =>
                console.log(
                  JSON.stringify({
                    type: 'session-result',
                    requestId: command.requestId,
                    ok,
                    error,
                  }),
                );
              runtime.command(command).then(
                () => reply(true),
                (error) => reply(false, error.message),
              );
            }
            if (command.type === 'disconnect' && typeof command.id === 'string')
              store.disconnect(command.id);
            if (
              command.type === 'policy-set' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              const reply = (ok, error) =>
                console.log(
                  JSON.stringify({
                    type: 'policy-result',
                    requestId: command.requestId,
                    ok,
                    policy: policy.snapshot(),
                    error,
                  }),
                );
              policy.replace(command.policy, command.revision, command.disconnect).then(
                () => reply(true),
                (error) => reply(false, error.message),
              );
            }
          } catch {
            /* Ignore malformed owner commands, never evaluate text. */
          }
        }
      });
      owner.on('close', stop);
    }
    server.listen(port, process.env.VIDVNC_HOST || '0.0.0.0', () => {
      if (stopping) return;
      if (desktop) {
        console.log(
          JSON.stringify({
            type: 'ready',
            urls: connectionUrls(),
            password: store.password,
            width: info.width,
            height: info.height,
            displays: info.displays || [],
            policy: policy.snapshot(),
            access: access.snapshot(),
            clients: approvedClients.status(store.list()),
            codecs: hostCodecs,
          }),
        );
        return;
      }
      console.log('\nVidVNC · Ready to connect\n');
      for (const nic of Object.values(networkInterfaces()).flat()) {
        if (nic.family === 'IPv4' && !nic.internal)
          console.log(`Open http://${nic.address}:${port}`);
      }
      console.log(`Local preview: http://127.0.0.1:${port}\nPassword: ${store.password}\n`);
      console.log(`Live diagnostics (this PC only): http://127.0.0.1:${port}/diagnostics`);
      const codecLabels = VIDEO_CODECS.filter((codec) => hostCodecs.includes(codec))
        .map((codec) => CODEC_LABELS[codec])
        .join(' / ');
      console.log(
        `${info.width} × ${info.height} · NVIDIA ${codecLabels} · 30 fps\nTrusted LAN only. HTTP pairing is not encrypted. Do not forward this port.\nCtrl+C stops sharing.`,
      );
      console.log(
        `Type help for commands. Default control: ${accessLabel(access.snapshot().defaultControl)}.`,
      );
      // Started after the banner so the prompt appears below it.
      consoleSession = startConsole({
        input: process.stdin,
        output: process.stdout,
        errors: process.stderr,
        terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        stop,
        createContext: ({ confirm }) =>
          createLiveContext({
            policy,
            access,
            inventory,
            runtime,
            sessionStore: store,
            profileOrderFile: files.profileOrder,
            directory,
            logDirectory,
            urls: connectionUrls,
            port,
            confirm,
            hostCodecs,
          }),
      });
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    server.on('error', (error) => {
      console.error(error.message);
      stop();
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(
      `Unable to start VidVNC: ${error.message}\n${
        runtimeManifest?.mode === 'packaged'
          ? 'Check the NVIDIA driver and the Microsoft Visual C++ Redistributable (x64).'
          : 'Run build-native.cmd and check the NVIDIA driver / GStreamer SDK.'
      }`,
    );
    process.exitCode = 1;
  }
}
