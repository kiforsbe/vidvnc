import { networkInterfaces, hostname } from 'node:os';
import { StreamPolicyStore } from './stream-policy-store.mjs';
import { PolicyController } from './policy-controller.mjs';
import { createHttpStack } from './server-http-stack.mjs';
import { NativeMedia, probe, listDisplays } from './native-media.mjs';
import { DisplayInventory } from './displays.mjs';
import { SessionStore } from './session-store.mjs';
import { createInterface } from 'node:readline';
import { Diagnostics } from './diagnostics.mjs';
import { logDirectory, runtimeManifest } from '@vidvnc/media-worker/runtime';
import { waitForOwner } from './owner-start.mjs';
import { applySharingMode } from './sharing-mode.mjs';
import { StreamRuntime } from './stream-runtime.mjs';
import { AccessSettings, mediaPortOf } from './access-settings.mjs';
import { MediaRelay } from './media-relay.mjs';
import { createRelayAddresses } from './relay-addresses.mjs';
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
import { ensureCertificate } from './tls/ensure-certificate.mjs';
import { localAddresses } from './tls/local-addresses.mjs';
import { certificateNames } from './tls/certificate-names.mjs';
import { createPeerNetwork } from './peer-network.mjs';
import {
  attemptAndAnnounce,
  connectionAddresses,
  httpConnectionAddresses,
  secureAddressLines,
} from './tls/addresses.mjs';
import { tlsDesktopStatus } from './tls/desktop-status.mjs';
import { createServerLog } from './server-log.mjs';
import { createLocalSessionScopeController } from './local-session-scope.mjs';
import { detectWindowsLanAdapters } from './windows-lan-adapters.mjs';
import { AdmissionBudget } from './admission-budget.mjs';
import { createCodeIssuer } from './code-issuance.mjs';
import { createOwnerSecurityCommands } from './owner-security-commands.mjs';
import { DiagnosticsCapabilities } from './diagnostics-capabilities.mjs';
import { createDiagnosticsHttp, diagnosticsUrl } from './diagnostics-http.mjs';

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
    // The desktop owner chooses local-only or remote sharing each time it starts sharing.
    let sharingMode = null;
    if (process.argv.includes('--await-owner')) {
      if (!desktop) throw new Error('--await-owner requires --desktop');
      sharingMode = await waitForOwner(process.stdin);
    }
    const info = probe();
    const hostCodecs = info.codecs?.length ? info.codecs : ['h264'];
    const directory = dataDirectory();
    const files = settingsFiles(directory);
    const access = await AccessSettings.open(files.access);
    const sharingNotice = sharingMode ? await applySharingMode(access, sharingMode) : null;
    const admission = new AdmissionBudget();
    const store = new SessionStore({ maxSessions: () => access.snapshot().maxSessions });
    const diagnostics = new Diagnostics({
      directory: logDirectory,
    });
    const diagnosticsCapabilities = new DiagnosticsCapabilities();
    const serverLog = createServerLog({ desktop, directory: logDirectory });
    const localSession = createLocalSessionScopeController({
      access,
      detect: detectWindowsLanAdapters,
      log: serverLog,
    });
    await localSession.refresh();
    // Eight video sources plus two audio formats, each of which may briefly have a closing
    // predecessor; registry budgets decide what starts.
    // Workers gather on 127.0.0.1 only; every viewer's media reaches them through the
    // authenticating media relay on the one media port.
    const media = new NativeMedia({
      iceBind: () => 'loopback',
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
    const peerNetwork = createPeerNetwork();
    const relay = new MediaRelay({
      port: () => mediaPortOf(access.snapshot()),
      log: serverLog,
      onEvent: (event) => runtime?.relayEvent(event),
      onExit: () => runtime?.relayStopped(),
    });
    runtime = new StreamRuntime({
      relay,
      relayAddresses: createRelayAddresses({
        publicNames: () => access.snapshot().publicHostnames,
      }),
      sessions: store,
      media,
      inventory,
      policy,
      access,
      log: serverLog,
      approvedClients,
      videoCodecs: hostCodecs,
      videoBackends: info.backends,
    });
    const ownerSecurity = createOwnerSecurityCommands({ store, approvedClients, runtime });
    const port = Number(process.env.VIDVNC_PORT || 4382);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIDVNC_PORT');
    const tlsSettings = await loadTlsSettings(files.tls, {
      plaintextPort: port,
      log: serverLog,
    });
    const hostPreference = process.env.VIDVNC_HOST || '0.0.0.0';
    const plaintextMode =
      tlsSettings.mode === 'off' && !tlsSettings.invalid ? 'lan-http' : 'https-required';
    // TLS and the narrow HTTP listeners share one handler and admission state. The TLS
    // callback is invoked only after HTTP stack construction, so the reference is lazy.
    let httpStack;
    // What the certificate covers follows remote access (tls/certificate-names.mjs); a
    // certificate that no longer covers the required names is reissued by its strategy.
    const certificateAddresses = () => certificateNames(localAddresses(), access.snapshot());
    const tlsListener = createTlsListener({
      ensureCertificate: (settings, deps) =>
        ensureCertificate(settings, { ...deps, localAddresses: certificateAddresses }),
      settings: tlsSettings,
      requestListener: (request, response) => httpStack.app.requestListener(request, response),
      host: hostPreference,
      log: serverLog,
    });
    httpStack = createHttpStack({
      localSessionScope: localSession.scope,
      port,
      hostPreference,
      appOptions: {
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
        display: {
          name: 'Primary display',
          width: info.width,
          height: info.height,
          refreshHz: 30,
        },
        tls: tlsListener,
        plaintextMode,
        peerNetwork,
      },
      log: serverLog,
    });
    const diagnosticsServer = createDiagnosticsHttp({
      diagnostics,
      diagnosticsCapabilities,
      runtime,
    });
    try {
      await new Promise((resolve, reject) => {
        diagnosticsServer.once('error', reject);
        diagnosticsServer.listen(0, '127.0.0.1', () => {
          diagnosticsServer.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      await runtime.shutdown();
      throw error;
    }
    const privateDiagnosticsUrl = diagnosticsUrl(diagnosticsServer);
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
    // HTTP roots are derived from bound sockets, never merely from installed NICs.
    const plaintextAddresses = () => httpConnectionAddresses(httpStack.http.addresses());
    const currentAddresses = () =>
      connectionAddresses({
        interfaces: networkInterfaces,
        plaintextPort: port,
        httpBindings: httpStack.http.addresses(),
        tls: tlsListener.status(),
        plaintextMode,
        hostPreference,
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
      const httpClosed = httpStack.http.close();
      const diagnosticsClosed = new Promise((resolve) => diagnosticsServer.close(resolve));
      diagnosticsServer.closeAllConnections();
      const tlsClosed = tlsListener.close();
      await runtime.shutdown();
      await relay.stop();
      await httpClosed;
      await diagnosticsClosed;
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
    // Remote access and its public names change what the certificate must cover, so a change
    // re-checks it now rather than at the next six-hourly re-check. Remote access with HTTPS
    // off serves no internet device at all, which the log says plainly.
    const warnRemoteWithoutTls = () => {
      const settings = access.snapshot();
      if (settings.remoteAccess && tlsSettings.mode === 'off')
        serverLog(
          'Remote access is on but HTTPS is off, so internet devices cannot connect. Set tls-mode to auto or provided.',
        );
      if (settings.remoteAccess)
        serverLog(
          `Remote access is on: forward UDP ${mediaPortOf(settings)} (the media port) on the router to this PC, or internet devices can sign in but get no picture.`,
        );
    };
    // A new media port restarts the relay, which stops live streams; viewers reconnect.
    access.onChange((next, previous) => {
      if (stopping || mediaPortOf(next) === mediaPortOf(previous)) return;
      serverLog(`Media port changed to UDP ${mediaPortOf(next)}; restarting the media relay.`);
      relay.restart().catch((error) => serverLog(`Media relay restart failed: ${error.message}`));
    });
    access.onChange((next, previous) => {
      if (!stopping && previous.remoteAccess && !next.remoteAccess)
        ownerSecurity
          .disconnectInternet((address) => peerNetwork.isInternet(address))
          .then(
            ({ disconnected }) =>
              disconnected &&
              serverLog(
                `Remote access switched off; disconnected ${disconnected} internet session${disconnected === 1 ? '' : 's'}.`,
              ),
            (error) => serverLog(`Disconnecting internet sessions failed: ${error.message}`),
          );
      if (
        stopping ||
        (next.remoteAccess === previous.remoteAccess &&
          mediaPortOf(next) === mediaPortOf(previous) &&
          JSON.stringify(next.publicHostnames) === JSON.stringify(previous.publicHostnames))
      )
        return;
      warnRemoteWithoutTls();
      if (next.remoteAccess && tlsSettings.mode !== 'off') attemptTls();
    });
    warnRemoteWithoutTls();
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
          .then(() => httpStack.http.reconcile())
          .catch((error) =>
            serverLog(`Warning: LAN password eligibility refresh failed: ${error.message}`),
          );
    }, 15_000).unref();
    // This owner-only report is shared by ready and periodic status messages. Viewer URLs
    // are separate from local trust roots, including before HTTPS provisioning completes.
    const tlsField = () =>
      tlsDesktopStatus({
        settings: tlsSettings,
        status: tlsListener.status(),
        report: tlsListener.report(),
        localHttpUrls: plaintextAddresses().urls,
        secureUrls: currentAddresses().urls,
      });
    if (desktop) {
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
              command.type === 'diagnostics-capability-create' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              const { token, expiresAt } = diagnosticsCapabilities.issue();
              console.log(
                JSON.stringify({
                  type: 'diagnostics-capability-result',
                  requestId: command.requestId,
                  ok: true,
                  token,
                  expiresAt,
                  url: privateDiagnosticsUrl,
                }),
              );
            }
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
              const operation = ownerSecurity.approved(command);
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
              command.type === 'ordinary-sessions-disconnect' &&
              typeof command.requestId === 'string' &&
              command.requestId.length <= 64 &&
              !stopping
            ) {
              ownerSecurity.disconnectOrdinary().then(
                ({ disconnected }) =>
                  console.log(
                    JSON.stringify({
                      type: 'client-command-result',
                      requestId: command.requestId,
                      ok: true,
                      disconnected,
                    }),
                  ),
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
                [
                  'defaultControl',
                  'connectionMode',
                  'maxSessions',
                  'publicName',
                  'remoteAccess',
                  'publicHostnames',
                  'mediaPort',
                  // Sent by hosts from before the media relay; migrated to mediaPort.
                  'mediaPorts',
                  'publicPort',
                ]
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
    // The relay binds before `ready`, so the first offer finds it listening. If it cannot
    // bind, sign-in still works and offers are refused with the reason.
    await relay.start();
    try {
      await httpStack.http.start();
    } catch (error) {
      await stop();
      throw error;
    }
    if (!stopping) {
      // TLS provisioning starts only after local HTTP listeners are bound, one turn of
      // the event loop after the ready line / banner has been written.
      // Provisioning shells out synchronously (mkcert, PowerShell) and can block the
      // event loop for as long as those tools take. Viewer admission on HTTP waits for
      // HTTPS unless the operator deliberately selected LAN-only TLS-off mode.
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
            ...(sharingNotice ? { sharingNotice } : {}),
            urls: tlsField().viewerUrls,
            tls: tlsField(),
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
      } else {
        const shown = currentAddresses();
        console.log(
          plaintextMode === 'lan-http'
            ? '\nVidVNC · Ready to connect (LAN-only HTTP)\n'
            : '\nVidVNC · Waiting for HTTPS\n',
        );
        for (const url of shown.lan) console.log(`Open ${url}`);
        if (shown.local) console.log(`Local preview: ${shown.local}`);
        console.log(`Password: ${store.password}\n`);
        console.log('Live diagnostics (this PC only): use diagnostics open');
        const codecLabels = VIDEO_CODECS.filter((codec) => hostCodecs.includes(codec))
          .map((codec) => CODEC_LABELS[codec])
          .join(' / ');
        console.log(
          `${info.width} × ${info.height} · ${info.backends[0]?.label ?? 'Hardware'} ${codecLabels} · 30 fps\n${plaintextMode === 'lan-http' ? 'Trusted LAN only. HTTP pairing is not encrypted.' : 'HTTP viewer access is disabled until HTTPS is available. Local HTTP serves trust enrollment only.'} Do not forward the HTTP port.\nCtrl+C stops sharing.`,
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
              diagnosticsCapabilities,
              diagnosticsUrl: () => privateDiagnosticsUrl,
              sessionStore: store,
              profileOrderFile: files.profileOrder,
              directory,
              logDirectory,
              addresses: currentAddresses,
              confirm,
              hostCodecs,
              tls: tlsListener,
              codeIssuer,
              ownerSecurity,
            }),
        });
      }
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    httpStack.app.on('error', (error) => {
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
