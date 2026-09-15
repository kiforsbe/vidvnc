# Approved clients and remembered sign-in design

Status: concept design only. This document does not claim that approved-client sign-in or platform passkeys are implemented.

![Connect a device approved-client previz](../../design/windows-host-previz/clients-v5.png)

## Intent

Let the host approve a client once so that client can later choose **Sign in** without entering another shared connection key. Keep the existing unremembered connection path available and clearly separate from client approval.

Milestone 1 uses human-readable pre-shared keys. QR transfer is out of scope. Apple passkeys, Windows Hello, and other platform passkeys are a later authentication option.

## Milestone 1: two key types in one format

Both key types keep the exact existing `AAAA-BBBB` presentation: eight letters total, displayed as four letters, one dash, and four letters. There is no prefix, suffix, or additional setup-key character. The dash is only a presentation separator and does not contribute entropy. One non-secret purpose bit is encoded in the first letter, so the web client, host, and server can distinguish the flow without changing the visible format or adding a second input field.

The shared alphabet remains `ABCDEFGHJKLMNPQRSTUVWXYZ`. Its characters have indexes `0` through `23`:

- An even first-character index identifies a Session key.
- An odd first-character index identifies a Client setup key.

The generator chooses the first character from the appropriate 12-character half-keyspace and chooses the remaining seven characters uniformly from the full alphabet. Each purpose therefore has `12 × 24⁷` possible keys, about 35.7 bits of entropy—one bit less than the current undifferentiated format. The type bit is routing metadata, not an authorization decision or extra secret.

For example, `NLYJ-LGFN` is a Session key because `N` has an even alphabet index. `MTFK-RQPH` is a Client setup key because `M` has an odd index. This pattern is intentionally unobtrusive; people do not need to understand it.

### Session key

The **Session key** is the existing per-sharing-instance key with the session purpose bit. It admits an ordinary, unremembered connection and produces the current short-lived session bearer. The same key may admit multiple allowed clients while that sharing instance is running. Stopping and restarting sharing rotates it. Using it never adds an approved client.

### Client setup key

The user selects **Connect a device** on the host and chooses **Approve this client**. The host displays a **Client setup key** with the setup purpose bit that:

- expires after a short interval;
- is consumed by the first valid setup request;
- cannot start an ordinary session; and
- grants no media, display-inventory, or input access by itself.

The client chooses **Add this host**, enters the setup key, supplies its device name, registers a username and password, and waits. The host shows the request for review in the shared **Connect a device** dialog and under **Needs your approval** on the Clients page. Rejection or expiry creates no saved credential. Approval creates one approved-client record and releases a new, client-specific secret to that requester.

The setup key is only a bootstrap secret. Neither side stores it as the reusable credential.

The server parses the purpose bit and then performs an exact, timing-safe lookup only in that purpose's key store. A Session key never exists in the setup-key store, and a Client setup key never exists in the session-key store. Changing the first character or any other character cannot turn one valid key into another unless the resulting complete key was independently generated and is currently valid.

## Server connection-key registry

The server owns one authoritative in-memory registry of currently valid connection keys. The registry is a unified list for lifecycle management, while each record's purpose and usage policy keep the two admission paths separate. An active record contains:

- a non-reversible lookup value for the normalized eight-letter key;
- **purpose:** `session` or `approved-client-setup`;
- **createdAt** and **expiresAt**;
- **usage:** multi-client for the sharing instance or single valid setup submission;
- **state:** active, reserved, consumed, cancelled, or expired;
- the owning sharing-instance ID; and
- for setup keys, the setup-attempt ID and eventual pending-request ID.

The Session key record lives only for its sharing instance and may be used by multiple clients subject to normal session limits. A Client setup key record has a short expiry and one permitted setup submission. The server atomically changes that record from active to reserved/consumed so two clients cannot claim it concurrently. Cancel, sharing shutdown, and expiry remove or invalidate records as defined by their purpose.

The short human-readable keys are not persisted as durable approved-client credentials. The host process receives the plaintext key only through its local control channel for display and copy actions. Logs, diagnostics, status APIs, and persisted approved-client records never include it.

## Web-client key dispatch

The web client keeps one field labeled **Connection key** and accepts exactly eight letters with an optional presentation dash. After all eight normalized letters are present, it can use the shared alphabet-index rule as an immediate UI hint:

- Session purpose opens **Connect once** and submits to ordinary session admission.
- Setup purpose opens the approved-client form for device name, required username, password, and password confirmation.
- Invalid characters or length show **Check the connection key and try again** without probing both server operations.

Client-side dispatch is only presentation logic. On **Continue**, the client sends the complete key to one admission operation. The server decodes the purpose bit, finds the exact active registry record, checks expiry and usage state, and returns the authoritative result:

- a valid Session key returns `connect-once`, the sharing-instance context, and the resulting short-lived session data;
- a valid Client setup key returns `approved-client-setup`, the setup-attempt reference, and `expiresAt`; and
- every unknown, expired, consumed, cancelled, malformed, or wrong-purpose key returns the same generic invalid-key response.

The web client advances based on this server response, not solely on the embedded bit. It waits for the complete key and a Continue action before changing flows, so partial typing does not make the page jump between modes. The response never echoes the key. Setup-key confirmation does not consume the permitted setup submission until the client atomically submits its device information and password verifier.

## Web-client registration and sign-in

![Approved-client registration previz](../../design/approved-client-web-v1/register-v1.png)

After the server confirms that an entered `AAAA-BBBB` value is an active Client setup key, the same web-client card expands into the registration form. The person confirms an editable device name and creates a required username and password. Submitting the form consumes the single-use setup key and creates the request that waits for host approval. The page never displays the generated client secret.

![Approved-client sign-in previz](../../design/approved-client-web-v1/sign-in-v1.png)

On a later visit, the browser recognizes its saved approved-client record and shows the remembered device plus username and password fields. **Sign in** submits all three inputs to authentication: the entered username, the entered password, and the browser's saved client secret. **Use a connection key instead** returns to the ordinary eight-character key entry without deleting the approved-client credential.

## Approved-client credential

An approved-client sign-in uses three values:

- **Client secret:** a high-entropy, host-specific value issued only after host approval. The client stores it; the person never types or sees it.
- **Username:** chosen during setup, stored readably with the approved-client record, and entered again at sign-in. It identifies the credential but is not a secret.
- **Client password:** chosen on the client during setup and entered by the person for future sign-ins. The client does not save it by default.

A native client stores the client secret in platform-protected storage. The current web client cannot access the operating-system credential vault directly, so it uses origin-scoped browser storage such as IndexedDB rather than local storage or a cookie sent with every request. The server stores the username readably, a verifier or hash for the client secret, and a separately salted, slow password hash. Of the sign-in fields, only the username is readable from stored server data. It never stores the plaintext password, Session key, or Client setup key.

On a later visit, the client shows the remembered host, username and password fields, and **Sign in**. The server locates the approved-client record by username and requires both the matching saved client secret and password verifier before creating a normal short-lived session bearer. A username, client secret, or password cannot authenticate on its own, and none is used directly as a media-session identifier. Stopping sharing ends sessions but preserves approved clients. Removing an approved client invalidates its client secret and disconnects any current session authenticated by it.

The server rate-limits password attempts per approved client and source, compares verifiers without timing leaks, and returns one generic authentication error. Passwords are never included in host approval details, logs, diagnostics, URLs, or status responses. Password recovery is deliberately absent in this milestone: forgetting it requires removing and approving the client again.

Browser storage does not make the current HTTP transport secure: same-origin script compromise or a local-network observer could steal the client secret or observe password submission. Client-side hashing alone does not fix this because a reusable hash becomes a password equivalent. Until HTTPS, a password-authenticated key exchange, or equivalent authenticated transport is available, this remains a trusted-local-network feature and must not claim resistance to a network observer.

## Client information shown for approval

The setup request contains only useful, explainable information:

- **Device name:** required and editable, with a suggested name such as `Safari on iPhone` or `Edge on Windows`.
- **Username:** required and entered by the person using the client. It is the readable account identifier used at sign-in; a web page cannot infer the operating-system account name.
- **Client installation ID:** a random identifier generated and stored by the client, never a hardware fingerprint.
- **Platform and browser family:** derived conservatively from User-Agent Client Hints when available, with the ordinary user agent as fallback.
- **Client version:** the VidVNC web or native client version when available.

The host adds request time, remote address or local-network label, and setup-key verification state. Language, screen resolution, fonts, and other fingerprinting-oriented browser data are not collected for approval.

The approval row emphasizes device name and username, then shows concise supporting metadata such as `Safari on iOS · Local network`. Approval defaults to **View only**; control remains a separate permission.

## Shared Connect a device dialog

The existing **Connect a device** dialog owns both connection-key experiences. It has a **Connection type** selector:

- **Connect once** shows the existing connection address and Session key.
- **Approve this client** creates a new setup attempt and shows the same address plus that attempt's Client setup key.

Opening the dialog from Overview defaults to **Connect once**. Opening it from the Clients page defaults to **Approve this client**. Switching into the approval mode creates the setup attempt only when one is not already active.

A setup attempt has its own server-side identifier, key, creation time, expiry, and state. The first valid client submission atomically consumes the key and attaches exactly one client-information payload plus password verifier to the attempt. The plaintext password is discarded as soon as the verifier is derived and is never presented to the host. The modal then changes from the key view to a review view with Approve/Reject actions. If the modal is closed, a submitted request remains under **Needs your approval** on the Clients page. **Cancel setup** invalidates an unsubmitted key immediately; otherwise an unused key expires after ten minutes.

The modal never shows both the Session key and Client setup key at once. Its explanatory copy states that the setup key is short-lived, valid for one setup attempt, still requires host approval, and that the client creates a password during setup. The password field and password value exist only on the client side.

## Host Clients page

The native host adds **Clients** between Sessions and Access. It contains:

- **Connect a device**, opening the shared dialog directly in **Approve this client** mode.
- **Needs your approval**, with client information, setup-key verification state, and explicit Approve/Reject actions.
- **Approved clients**, with device/user labels, client type, connection status, permission, and actions to rename, inspect, or remove.

The Clients page never contains an inline setup-key card. Current activity is deliberately lightweight: an approved client that has a live session gets a small green **Connected** status in its row. The Sessions page remains the only place for session details and disconnect controls. An inactive approved client shows muted last-connected text.

## State model

The ordinary path remains:

`session key entered → short-lived session → disconnected/expired`

The approved-client path is separate:

`dialog approval mode → setup attempt/key created → device name, username, and password submitted → key consumed → pending approval → approved → client secret saved → username-and-password sign-in`

Alternative exits are `setup key → cancelled/expired`, `pending approval → rejected`, and `approved client → removed`. Retrying after any exit requires a new host-created setup key. A pending request cannot use stream or input endpoints.

## Later milestone: platform passkeys

Add platform passkeys as another way to authenticate and approve a client, for example Apple passkeys or Windows Hello-backed passkeys. A passkey credential can replace the saved-client-secret and password combination without changing host approval, permissions, removal, or the short-lived session model.

Passkey work requires HTTPS and relying-party/trust provisioning first. Cross-device passkey behavior must be evaluated explicitly rather than assuming every platform exposes the same experience.

## Implementation boundaries and tests

Milestone 1 needs a durable host-owned approved-client store plus separate operations for creating/consuming a setup key, submitting/listing/approving/rejecting requests, completing client-secret and password-verifier enrollment, authenticating both credential parts, listing/removing approved clients, and exchanging successful authentication for a session.

Tests must prove that both formats contain exactly eight letters plus the display dash, both generators set the correct purpose bit, client and server parsers agree on every alphabet character, normalization preserves the purpose bit, registry responses authoritatively select the flow and never echo keys, session keys cannot add clients, setup keys cannot start sessions, a key with any changed character fails exact lookup, all invalid registry states return the same external error, setup confirmation does not consume the key prematurely, setup submission is single-use and expires, two clients cannot claim one key, rejected requests receive no client secret, username is required and registered readably, plaintext passwords are never persisted or returned, username, client secret, or password alone cannot authenticate, password attempts are rate-limited, approved clients survive session-key rotation, removal blocks future sign-in and ends any current session, secrets and password data are redacted, and pending requests cannot list displays or inject input.

## Visualization provenance

The PNGs were generated with the built-in image-generation tool. `docs/images/windows-host-overview.png` supplied the existing native host shell, proportions, palette, and icon language. The existing web-client connection screen supplied the browser shell and form language for the registration and sign-in previz. All people, devices, keys, and statuses are illustrative.
