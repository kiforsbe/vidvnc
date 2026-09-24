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
import { loadTlsSettings } from './tls/load-settings.mjs';
import { createTlsListener } from './tls/listener.mjs';
import { attemptAndAnnounce, connectionAddresses, secureAddressLines } from './tls/addresses.mjs';
import { tlsDesktopStatus } from './tls/desktop-status.mjs';
import { createServerLog } from './server-log.mjs';
import { createLocalSessionScopeController } from './local-session-scope.mjs';
import { detectWindowsLanAdapters } from './windows-lan-adapters.mjs';
import { AdmissionBudget } from './admission-budget.mjs';
import { createCodeIssuer } from './code-issuance.mjs';

// TLS renews inside a 30-day window (certificate-facts.mjs's default) and this only needs
// to notice an address change or an approaching expiry before that window closes, not
// react within seconds — a short interval would mean windows-self-signed's `isAvailable`
// re-probing PowerShell (Task 6's accepted precedent) far more often than useful. Six
// hours catches a laptop that moved networks, or a certificate entering its renewal
// window, well inside a single day.
const TLS_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
    const admission = new AdmissionBudget();
    const store = new SessionStore({ maxSessions: () => access.snapshot().maxSessions });
    const diagnostics = new Diagnostics({
      directory: logDirectory,
    });
    const serverLog = createServerLog({ desktop, directory: logDirectory });
    const localSession = createLocalSessionScopeController({
      access,
      detect: detectWindowsLanAdapters,
      log: serverLog,
    });
    await localSession.refresh();
    // Eight video sources plus two audio formats, each of which may briefly have a closing
    // predecessor; registry budgets decide what starts.
    const media = new NativeMedia({
      maxWorkers: 12,
      hostControl: true,
      diagnostics,
      log: serverLog,
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
      admission,
    });
    const codeIssuer = createCodeIssuer({ access, sessionStore: store, admission });
    runtime = new StreamRuntime({
      sessions: store,
      media,
      inventory,
      policy,
      access,
      listenerScope: 'local',
      localSessionScope: localSession.scope,
      admission,
      log: serverLog,
      approvedClients,
      videoCodecs: hostCodecs,
      videoBackends: info.backends,
    });
    const port = Number(process.env.VIDVNC_PORT || 4382);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIDVNC_PORT');
    const tlsSettings = await loadTlsSettings(files.tls, {
      plaintextPort: port,
      log: serverLog,
    });
    // The TLS listener shares the plaintext app's request handling, but the app is created
    // below and needs this listener's `status()` as its `tls` option, so the handler is
    // forwarded lazily. It is only ever invoked for a request, after `server` exists.
    const tlsListener = createTlsListener({
      settings: tlsSettings,
      requestListener: (request, response) => server.requestListener(request, response),
      host: process.env.VIDVNC_HOST || '0.0.0.0',
      log: serverLog,
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
      tls: tlsListener,
    });
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
    // The ready line and the banner are written before TLS can be up (it is provisioned
    // after them, on purpose), so they show the plaintext addresses, which are true then.
    // Everything read later, and the HTTPS follow-up, follows the live listener instead.
    const plaintextAddresses = () =>
      connectionAddresses({ interfaces: networkInterfaces, plaintextPort: port });
    const currentAddresses = () =>
      connectionAddresses({
        interfaces: networkInterfaces,
        plaintextPort: port,
        tls: tlsListener.status(),
      });
    let owner;
    let consoleSession;
    let statusTimer;
    let inventoryTimer;
    let controlTimer;
    let tlsRecheckTimer;
    let lanRefreshTimer;
    let refreshing = false;
    const inventoryAbort = new AbortController();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(statusTimer);
      clearInterval(inventoryTimer);
      clearInterval(controlTimer);
      clearInterval(tlsRecheckTimer);
      clearInterval(lanRefreshTimer);
      inventoryAbort.abort();
      store.stop();
      owner?.close();
      consoleSession?.close();
      process.stdin.pause();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      const tlsClosed = tlsListener.close();
      await runtime.shutdown();
      await closed;
      await tlsClosed;
      await diagnostics.writes;
      releaseInstance();
    };
    // Startup provisioning and the periodic re-check are the same idempotent call: the
    // listener binds on the first success and rotates its secure context in place on later
    // ones (see tls/listener.mjs). The listener's own `attempt()` never rejects, but the
    // call sites still log a rejection rather than trust that: this is fire-and-forget, and
    // an unhandled rejection would take the whole server down over an optional feature.
    //
    // The CLI gets one follow-up block when HTTPS first comes up. It is printed with
    // console.log like the rest of the console's output: the terminal prompt hooks stdout,
    // so it appears above a prompt that is showing rather than corrupting it. The desktop
    // host's stdout is a JSON protocol and is left alone.
    const attemptTls = () =>
      attemptAndAnnounce({
        listener: tlsListener,
        announce: () => {
          if (!desktop && !stopping) console.log(secureAddressLines(currentAddresses()).join('\n'));
        },
        log: serverLog,
      });
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
    lanRefreshTimer = setInterval(() => {
      if (!stopping)
        localSession
          .refresh()
          .catch((error) =>
            serverLog(`Warning: LAN password eligibility refresh failed: ${error.message}`),
          );
    }, 15_000).unref();
    if (desktop) {
      // The TLS report rides along on the status message the host already reads every
      // second, rather than as a message of its own: the host's TLS section is a view of
      // live state, and a separate stream would let the two drift. It is merged in here,
      // at the call site, and not added to `runtime.status()` — that method is also read
      // by the CLI console and by `diagnosticStreams()`, neither of which has any business
      // with TLS, and its contract is asserted by stream-runtime.test.mjs.
      const tlsField = () =>
        tlsDesktopStatus({
          settings: tlsSettings,
          status: tlsListener.status(),
          report: tlsListener.report(),
        });
      statusTimer = setInterval(() => {
        if (!stopping && !process.stdout.writableNeedDrain) {
          console.log(
            JSON.stringify({ ...runtime.status(), tls: tlsField(), codes: codeIssuer.status() }),
          );
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
                const once = codeIssuer.oneTime(command.alphabet);
                console.log(
                  JSON.stringify({
                    type: 'connection-once-result',
                    requestId: command.requestId,
                    ok: true,
                    key: once.key,
                    expiresAt: once.expiresAt,
                    alphabet: once.alphabet,
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
                const setup = codeIssuer.setup(command.alphabet);
                console.log(
                  JSON.stringify({
                    type: 'client-setup-result',
                    requestId: command.requestId,
                    ok: true,
                    key: setup.key,
                    expiresAt: setup.expiresAt,
                    alphabet: setup.alphabet,
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
              command.type === 'session-password-rotate' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              try {
                const rotated = codeIssuer.rotateSession(command.alphabet);
                console.log(
                  JSON.stringify({
                    type: 'session-password-result',
                    requestId: command.requestId,
                    ok: true,
                    key: rotated.key,
                    alphabet: rotated.alphabet,
                  }),
                );
              } catch (error) {
                console.log(
                  JSON.stringify({
                    type: 'session-password-result',
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
                    sessionKey = codeIssuer.rotateSession().key;
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
            // Regenerate the TLS certificate on the host's request. The two refusals below
            // are a safety net, not the control: the host UI does not offer the action in
            // either state (Task 14). They are here because the pipe is a protocol, and a
            // protocol that would replace an operator's own certificate on request is one
            // no UI change should be able to reopen. `attempt({ force: true })` refuses
            // both again in the listener itself.
            if (command.type === 'tls-regenerate' && !stopping) {
              const reply = (ok, reason) =>
                console.log(JSON.stringify({ type: 'tls-regenerate-result', ok, reason }));
              const strategy = tlsListener.report().strategy;
              if (tlsSettings.mode === 'off')
                reply(false, 'HTTPS is turned off, so there is no certificate to regenerate.');
              else if (tlsSettings.mode === 'provided' || strategy === 'provided')
                reply(
                  false,
                  'This host uses a certificate supplied by its operator. VidVNC never replaces it.',
                );
              else
                tlsListener.attempt({ force: true }).then(
                  // The same sanitized field the status message carries, so a failure is
                  // worded identically whether the host learns of it from the reply or from
                  // the next tick. `reason === null` is the success condition: a rotation
                  // that failed leaves the previous certificate serving, which is not the
                  // regeneration that was asked for.
                  () => {
                    const after = tlsField();
                    reply(after.reason === null, after.reason ?? undefined);
                  },
                  () => reply(false, 'The certificate could not be regenerated.'),
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
      // TLS provisioning starts only now, with plaintext already bound, and one turn of
      // the event loop later so the ready line / banner below has been written first.
      // Provisioning shells out synchronously (mkcert, PowerShell) and can block the
      // event loop for as long as those tools take, so it must never sit in front of
      // plaintext becoming reachable; TLS is an improvement, not a precondition.
      setImmediate(() => {
        if (stopping) return;
        attemptTls();
        if (tlsSettings.mode !== 'off')
          tlsRecheckTimer = setInterval(() => {
            if (!stopping) attemptTls();
          }, TLS_RECHECK_INTERVAL_MS).unref();
      });
      if (desktop) {
        console.log(
          JSON.stringify({
            type: 'ready',
            urls: plaintextAddresses().urls,
            password: store.password,
            width: info.width,
            height: info.height,
            displays: info.displays || [],
            policy: policy.snapshot(),
            access: access.snapshot(),
            clients: approvedClients.status(store.list()),
            codecs: hostCodecs,
            backends: info.backends.map(({ id, label, codecs }) => ({ id, label, codecs })),
          }),
        );
        return;
      }
      console.log('\nVidVNC · Ready to connect\n');
      const shown = plaintextAddresses();
      for (const url of shown.lan) console.log(`Open ${url}`);
      console.log(`Local preview: ${shown.local}\nPassword: ${store.password}\n`);
      console.log(`Live diagnostics (this PC only): ${shown.diagnostics}`);
      const codecLabels = VIDEO_CODECS.filter((codec) => hostCodecs.includes(codec))
        .map((codec) => CODEC_LABELS[codec])
        .join(' / ');
      console.log(
        `${info.width} × ${info.height} · ${info.backends[0]?.label ?? 'Hardware'} ${codecLabels} · 30 fps\nTrusted LAN only. HTTP pairing is not encrypted. Do not forward this port.\nCtrl+C stops sharing.`,
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
            addresses: currentAddresses,
            confirm,
            hostCodecs,
            tls: tlsListener,
            codeIssuer,
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
          ? 'Check the graphics driver and the Microsoft Visual C++ Redistributable (x64).'
          : 'Run build-native.cmd and check the graphics driver / GStreamer SDK.'
      }`,
    );
    process.exitCode = 1;
  }
}
