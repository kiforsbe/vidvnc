// The desktop owner protocol after the approval line (owner-start.mjs): the commands a
// host sends on the server's stdin, the replies and the status lines it reads from stdout.
// docs/ARCHITECTURE.md's "Owner protocol" section is the written contract, and
// tests/fixtures/owner-protocol/ holds the examples both hosts are checked against
// (tests/owner-protocol.test.mjs). Kept out of main.mjs, which starts a server on import,
// so the real dispatch can be driven by a test.
import { CONNECTION_KEY_PURPOSES } from './connection-keys.mjs';

// A command line longer than this is ignored without being parsed.
export const OWNER_COMMAND_MAX_BYTES = 128 * 1024;
// The exact stop line; anything else that only looks like it is an ordinary command.
export const OWNER_STOP_LINE = '{"type":"stop"}';

// The fields `access-set` may change; anything else in the command is ignored.
const ACCESS_FIELDS = [
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
];

const send = (write, message) => write(JSON.stringify(message));
const requested = (command) =>
  typeof command.requestId === 'string' && command.requestId.length <= 64;

// The two lines the server writes every second while a desktop host owns it.
export function statusLines({ runtime, tlsField, codeIssuer, approvedClients, store }) {
  return [
    { ...runtime.status(), tls: tlsField(), codes: codeIssuer.status() },
    { type: 'clients', ...approvedClients.status(store.list()) },
  ];
}

// Sent whenever the display inventory changes.
export const displaysLine = (inventory) => ({ type: 'displays', displays: inventory.rows });

// The one line that tells the host sharing has started.
export function readyMessage({
  sharingNotice,
  tlsField,
  store,
  info,
  policy,
  access,
  approvedClients,
  hostCodecs,
  versions,
}) {
  return {
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
    // For the host's Settings: what this server runs on.
    versions,
  };
}

// Returns the handler for one stdin line. `write` receives each reply as one JSON line.
// Unknown types and malformed lines are ignored; text is never evaluated.
export function createOwnerCommandHandler({
  write = (line) => console.log(line),
  stop,
  stopping,
  diagnosticsCapabilities,
  diagnosticsUrl,
  codeIssuer,
  approvedClients,
  store,
  ownerSecurity,
  access,
  runtime,
  policy,
  tlsSettings,
  tlsListener,
  tlsField,
}) {
  const clientsLine = () =>
    send(write, { type: 'clients', ...approvedClients.status(store.list()) });
  const clientResult = (command, operation, after) =>
    operation.then(
      (value) => {
        send(write, {
          type: 'client-command-result',
          requestId: command.requestId,
          ok: true,
          ...after?.(value),
        });
        if (!after) clientsLine();
      },
      (error) =>
        send(write, {
          type: 'client-command-result',
          requestId: command.requestId,
          ok: false,
          error: error.message,
        }),
    );
  const issued = (command, type, issue, fields) => {
    try {
      const value = issue(command.alphabet);
      send(write, { type, requestId: command.requestId, ok: true, ...fields(value) });
    } catch (error) {
      send(write, { type, requestId: command.requestId, ok: false, error: error.message });
    }
  };

  return (line) => {
    if (line === OWNER_STOP_LINE) {
      stop();
      return;
    }
    if (Buffer.byteLength(line) > OWNER_COMMAND_MAX_BYTES) return;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      /* Ignore malformed owner commands, never evaluate text. */
      return;
    }
    if (!command || typeof command !== 'object') return;
    try {
      if (command.type === 'diagnostics-capability-create' && requested(command) && !stopping()) {
        const { token, expiresAt } = diagnosticsCapabilities.issue();
        send(write, {
          type: 'diagnostics-capability-result',
          requestId: command.requestId,
          ok: true,
          token,
          expiresAt,
          url: diagnosticsUrl(),
        });
      }
      if (command.type === 'connection-once-create' && requested(command) && !stopping())
        issued(
          command,
          'connection-once-result',
          (alphabet) => codeIssuer.oneTime(alphabet),
          ({ key, expiresAt, alphabet }) => ({ key, expiresAt, alphabet }),
        );
      if (command.type === 'client-setup-create' && requested(command) && !stopping())
        issued(
          command,
          'client-setup-result',
          (alphabet) => codeIssuer.setup(alphabet),
          ({ key, expiresAt, alphabet }) => ({ key, expiresAt, alphabet }),
        );
      if (command.type === 'session-password-rotate' && requested(command) && !stopping())
        issued(
          command,
          'session-password-result',
          (alphabet) => codeIssuer.rotateSession(alphabet),
          ({ key, alphabet }) => ({ key, alphabet }),
        );
      if (
        command.type === 'client-request-command' &&
        requested(command) &&
        typeof command.id === 'string' &&
        !stopping()
      )
        clientResult(
          command,
          command.action === 'approve'
            ? approvedClients.approve(command.id)
            : command.action === 'reject'
              ? Promise.resolve(approvedClients.reject(command.id))
              : Promise.reject(new Error('Invalid client request action')),
        );
      if (
        command.type === 'approved-client-command' &&
        requested(command) &&
        typeof command.id === 'string' &&
        !stopping()
      )
        clientResult(command, ownerSecurity.approved(command));
      if (command.type === 'ordinary-sessions-disconnect' && requested(command) && !stopping())
        clientResult(command, ownerSecurity.disconnectOrdinary(), ({ disconnected }) => ({
          disconnected,
        }));
      if (command.type === 'access-set' && requested(command) && !stopping()) {
        const previousMode = access.snapshot().connectionMode;
        const reply = (ok, error, sessionKey) =>
          send(write, {
            type: 'access-result',
            requestId: command.requestId,
            ok,
            error,
            access: access.snapshot(),
            sessionKey,
          });
        const changes = Object.fromEntries(
          ACCESS_FIELDS.filter((key) => command[key] !== undefined).map((key) => [
            key,
            command[key],
          ]),
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
      if (command.type === 'session-command' && requested(command) && !stopping()) {
        const reply = (ok, error) =>
          send(write, { type: 'session-result', requestId: command.requestId, ok, error });
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
      if (command.type === 'tls-regenerate' && !stopping()) {
        const reply = (ok, reason) => send(write, { type: 'tls-regenerate-result', ok, reason });
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
      if (command.type === 'policy-set' && requested(command) && !stopping()) {
        const reply = (ok, error) =>
          send(write, {
            type: 'policy-result',
            requestId: command.requestId,
            ok,
            policy: policy.snapshot(),
            error,
          });
        policy.replace(command.policy, command.revision, command.disconnect).then(
          () => reply(true),
          (error) => reply(false, error.message),
        );
      }
    } catch {
      /* A command that throws synchronously gets no reply, as before. */
    }
  };
}
