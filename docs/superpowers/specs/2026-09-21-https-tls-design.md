# HTTPS and certificate trust

Approved direction (2026-09-21): VidVNC gains an HTTPS listener alongside today's plain
HTTP one. Certificates are provisioned automatically on first run, preferring an existing
mkcert local CA and falling back to a self-signed certificate issued through Windows. A
host-served enrolment flow gets the trust anchor onto phones and laptops. Operators who
have a certificate from a real CA can supply it instead. The media path does not change.

## Background

### What exists today

The server creates one plaintext listener. `createHttpApp` in `http-app.mjs` builds it
with `node:http`, and `main.mjs` binds it to a single port on `0.0.0.0`. Every address the
product shows a user is built by hand as an `http://` string: four places in `main.mjs`
and one in `cli/console.mjs`. The same assumption is baked into request handling, where
the origin guard compares the incoming `Origin` header against a literal
`http://${request.headers.host}`.

`ARCHITECTURE.md` states the consequence plainly: the control plane is plain HTTP, so
admission keys and session tokens are readable by anything on the path, and exposing the
port to an untrusted network is not a supported configuration. `ROADMAP.md` already names
the remedy and its ordering — "Design HTTPS and trust provisioning before passkeys: plain
HTTP on a local network is not a complete passkey deployment."

### What HTTPS does and does not buy

It is worth being exact, because the honest answer argues for a good default rather than
for urgency.

Nothing that works today stops working without it, and nothing broken starts working with
it. The video path is receive-only, so no secure-context browser API gates it, and WebRTC
media is already encrypted under DTLS-SRTP regardless of how the page was served.

What it buys is confidentiality and integrity for everything the *server* handles:
admission keys, session tokens, the policy surface, and the diagnostics endpoint. It also
removes the blocker in front of passkeys, remembered devices and any future clipboard
support, all of which require a secure context. That is the case for doing it properly
now rather than later.

### Two working precedents

Both of these are the author's own systems solving the same problem, and the design below
takes different parts from each rather than inventing a third approach.

`inventory` uses mkcert: a local certificate authority whose root is installed once per
client device, issuing leaf certificates that browsers accept without warning. Paths come
from `CERT_PATH` and `KEY_PATH`, the server is HTTPS-only, and the driver is WebAuthn.
It also documents a defect worth inheriting: browsers omit the port from `Origin` when it
is the scheme's default, so an expected origin built as host-plus-port never matches on
443 and every verification fails with no obvious cause.

`XRMediaServer` generates its own certificate with no external tool. Its `ensure_cert`
runs at startup and reissues whenever the certificate is missing, close to expiry, or no
longer covers the machine's current LAN addresses, so a DHCP lease change does not break
it. It keeps a plaintext port that redirects to the secure one, and when provisioning
fails it degrades to HTTP-only instead of refusing to start. The driver is WebXR.

The first gives an experience with no browser warnings; the second gives an experience
that needs no configuration and survives a changing network. VidVNC wants both, so the
design layers them rather than choosing.

### Why this stays inside the server

TLS terminates in Node and nothing else learns about it. The worker, GStreamer and the
WebRTC peers are untouched, because that traffic never passes through the HTTP listener
and is separately encrypted. This is what keeps an otherwise broad change tractable: the
blast radius is `apps/server`, plus the surfaces that display an address to a human.

## Goals and decisions

Three decisions were taken before this document and the rest follows from them.

**Provisioning is automatic, and prefers mkcert.** On a fresh install with no
configuration the host provisions its own certificate. If mkcert is on `PATH`, the leaf is
issued from its local CA, so any device that already trusts that CA sees no warning at
all. Otherwise a self-signed certificate is issued through Windows. Both cover every
current LAN address.

**The trust anchor is served by the host.** A fixed plaintext endpoint offers whichever
anchor is currently in use, with per-device instructions and a QR code in the host UI, so
a device that has just been given the address can enrol itself without copying files.

**Two listeners on two ports.** The existing port stays plaintext; HTTPS gets a new one.
This was chosen over a single port that detects TLS from the first handshake byte, and
over moving HTTPS onto the familiar port. It is conventional, each listener is
independently reasonable about, and an address someone has memorised keeps working and
redirects.

Certificates from a real CA remain fully supported through an explicit configuration
mode, and plaintext-only operation remains available for anyone who wants today's
behaviour unchanged.

### Non-goals

Passkeys and WebAuthn, which this unblocks but does not implement. ACME or Let's Encrypt
automation. Remote access, relays and tunnelling. Certificate provisioning on macOS: the
strategy boundary leaves a seam for it, and nothing else assumes Windows. Revocation
infrastructure beyond regenerating and re-enrolling.

## Certificate provisioning

### Strategies, in order

Provisioning resolves through an ordered list of strategies. The first that can produce a
certificate covering the machine's current addresses wins, and the chosen strategy is
recorded so the host UI and diagnostics can say which one is in effect.

| Strategy | Condition | Anchor a device must trust |
| --- | --- | --- |
| `provided` | Operator configured a certificate and key | Whatever their CA chain already is; usually nothing to install |
| `mkcert` | `mkcert` resolves on `PATH` | The mkcert local root CA |
| `self-signed` | Windows, always available | The leaf certificate itself |
| none | Every strategy failed | — plaintext only |

`provided` short-circuits the rest: an operator who names a certificate is never
second-guessed, and a failure there is reported rather than silently replaced by a
generated one.

The mkcert strategy issues a leaf into VidVNC's own state directory rather than reusing
whatever file happens to be lying around, and locates the root to serve by asking mkcert
for its CA root directory. The value of this strategy is entirely that the root is
*already* trusted on the machines its owner uses; it does not install anything.

The self-signed strategy issues through Windows' own certificate tooling, which avoids
adding a runtime npm dependency to a project that currently has none. Three facts were
verified against the real tooling before this was chosen: a certificate can be issued
with IP address entries in its subject alternative name and not merely DNS names; it
exports to PFX; and Node consumes that PFX directly as a TLS credential with no
conversion to PEM. A device trusting such a leaf as its own anchor completes a
handshake to an IP address successfully.

### What the certificate covers

Every name a user might plausibly type, gathered at provisioning time: the machine's
hostname, `localhost`, every current LAN address, and loopback. Addresses are discovered
the way `XRMediaServer` does it — the hostname resolution table, plus the address of the
primary outbound interface, which catches the common case where name resolution is
incomplete. No packets are sent to discover the latter.

Gathering addresses is pure and testable on any platform; issuing them is not. That line
is where the platform boundary sits.

### Renewal and rotation

One idempotent operation runs at startup and reissues when any of the following holds:
the certificate is absent or unreadable; expiry falls inside the renewal window; or its
subject alternative name no longer covers an address the machine currently has.

VidVNC hosts run for days and laptops move between networks, so this is also re-checked
periodically rather than only at startup. Rotation does not disturb the listener: Node can
replace a running server's secure context in place, so existing connections keep the
credential they negotiated with and new ones get the replacement. A reissued certificate
does not require re-enrolment under the mkcert strategy, because the anchor is the CA and
the CA has not changed. Under the self-signed strategy it does, which is a genuine
drawback of that strategy and a reason the host UI should say which one is active.

## Listeners and ports

The plaintext listener keeps the current port and the current firewall rule. The TLS
listener takes a new configurable port. The host displays the HTTPS address once TLS is
running, and the CLI banner does the same.

The plaintext listener serves exactly two things and refuses everything else with a
redirect to its HTTPS equivalent:

- the enrolment page and the trust anchor it offers
- a health or identity response, if one is needed for discovery later

Everything else redirects. The enrolment endpoints must stay reachable without TLS,
because a device that does not yet trust the host has no un-warned way to fetch the anchor
over the very connection the anchor exists to authenticate. This is not a weakness: a
public certificate is public by construction and discloses nothing, and the substitution
risk it does carry is closed by fingerprint comparison rather than by transport.

When provisioning fails entirely, the plaintext listener reverts to serving the whole
application as it does today, and the reason is logged and surfaced in the host UI. The
server never refuses to start because it could not get a certificate.

## Enrolment and trust installation

The host offers the current anchor at a fixed path, in a form each platform accepts, and
a page that explains what to do with it. The host UI shows a QR code pointing at that
page, so the flow from "type the address" to "trusted" involves no file transfer.

The page is device-aware, because the steps genuinely differ and the differences are where
people fail:

- **iOS** requires two separate actions: install the downloaded profile in Settings, then
  enable full trust for it in a different Settings screen. A device that completes only
  the first still shows warnings, and the page must say so explicitly rather than
  implying the install finished the job.
- **Windows** installs into the current user's trusted roots; a script mirroring the
  existing MSIX development certificate helper, with matching install and uninstall
  verbs, is the natural shape.
- **Android** and **macOS** each need their own short sequence, including macOS's separate
  trust-setting step in Keychain Access.

The host UI and the enrolment page both display the anchor's SHA-256 fingerprint. This is
what makes serving over plaintext sound: a user comparing the fingerprint on the host
screen against the one the page shows will detect a substituted anchor, and that
comparison is the only integrity guarantee available before trust exists. The instructions
should ask for it rather than treat it as optional decoration.

Uninstall instructions matter as much as install ones. A trust anchor a user cannot find
and remove later is a liability, and the self-signed strategy's anchors accumulate as
certificates are reissued.

## Configuration

TLS settings live in their own file in the existing per-user state directory, beside the
stream policy, access settings and approved clients. That directory is already shared by
the CLI server and the Windows host, which is exactly the sharing this needs, and adding
another entry to the settings map follows a pattern rather than inventing one.

Environment variables are deliberately not the configuration surface, despite `inventory`
using them. VidVNC configures everything else through a validated settings file reachable
from both the host UI and the CLI, and TLS should not be the one exception a user has to
discover differently.

| Setting | Meaning |
| --- | --- |
| mode | `auto`, `provided` or `off` |
| port | The TLS listener's port |
| certificate and key | Used only in `provided` mode |

`auto` is the default and behaves as described above. `provided` takes an operator's own
certificate, which satisfies the "proper sources" requirement; it accepts both a PEM
certificate and key pair and a single PFX, because Node consumes either and a Windows
operator is more likely to hold a PFX. `off` restores today's behaviour exactly, with no
TLS listener and no redirect.

Validation happens on the whole settings object before it is stored, as the stream policy
already does, so a malformed configuration is rejected at the point of editing rather
than at the next startup. A `provided` certificate is additionally checked for
readability, expiry, and whether it actually covers an address the machine has — a
certificate for the wrong name is a misconfiguration worth catching immediately.

Both surfaces get the setting: a section in the host UI showing mode, port, active
strategy, expiry and fingerprint, with actions to regenerate and to show the enrolment QR
code; and a CLI command consistent with the existing configuration commands.

## Existing behaviour that must change

These are the places where today's single-scheme assumption is load-bearing. Each is a
defect the moment a second scheme exists.

**The origin guard.** The check compares `Origin` against a literal `http://` string
built from the request's host header. It must accept the scheme the request actually
arrived on, and must handle the default-port omission described in the background: a
browser sends no port when it is the scheme's default, so an expected origin that always
appends one will never match on 443. This is the single highest-risk change in the work,
because getting it wrong either breaks every request or silently disables the protection.

**Address construction.** The `http://` strings in `main.mjs` and `cli/console.mjs` must
render the address a user should actually visit, which is the HTTPS one whenever TLS is
running and the plaintext one otherwise. The diagnostics address, which is deliberately
loopback-only, follows the same rule.

**Host UI address display.** The address shown and the QR code encode the HTTPS address
once TLS is up.

**Redirects and the session flow.** A client that lands on the plaintext port mid-session
must be redirected without losing its session; the redirect preserves path and query.

## Failure handling

The governing rule is that TLS is an improvement, not a precondition. Nothing about its
absence may prevent the product from working as it does today.

| Failure | Behaviour |
| --- | --- |
| No provisioning strategy succeeds in `auto` | Plaintext only; reason logged and shown in the host UI |
| `provided` certificate missing, unreadable or expired | Reported as a configuration error; does not silently fall back to a generated certificate |
| mkcert present but issuing fails | Falls through to the self-signed strategy, recording why |
| Certificate expires while running | Periodic re-check reissues and rotates the live listener |
| TLS port already in use | Reported clearly, naming the port; plaintext continues |

A failure that leaves the product plaintext must be visible rather than quiet. A user who
believes they are protected and is not is worse off than one who knows they are not.

## Testing and validation

### Portable, on any operating system

The majority of this is pure logic and must stay runnable in the existing portable suite,
which runs on Windows, macOS and Linux:

- address and hostname gathering, including the case where name resolution is incomplete
- whether a certificate's names cover the machine's current addresses, including the
  address-changed case that forces reissue
- expiry and renewal-window arithmetic, including a certificate that expires while running
- strategy selection order, and the fall-through when a strategy fails
- settings validation, covering each mode and every malformed combination
- origin acceptance across both schemes, with and without an explicit default port — this
  deserves the most thorough table in the work, given the risk noted above
- redirect construction, preserving path and query
- the plaintext allow-list: enrolment endpoints served, everything else redirected

Listener tests need a real credential, which Node cannot generate. A fixture certificate
and key pair is committed for tests, as `inventory` commits its development certificates,
clearly marked as test-only and never loaded outside tests.

### Windows, opt-in

Actual issuance through Windows certificate tooling, actual mkcert issuance when mkcert is
present, and a genuine TLS handshake against the resulting credential belong in the
existing opt-in hardware-test path. They cannot run in portable CI.

### By hand, once

The enrolment flow is a human-factors change and automated tests will not tell us whether
it works. It should be walked end to end on a real iPhone, which is both the hardest case
and a first-class target for this product: fetch the anchor, install it, enable full
trust, and confirm a warning-free connection. The two-step trust requirement means a test
that stops at "profile installed" proves nothing.

## Packaging and documentation

Packaging gains a second port to declare and to describe in firewall guidance. The MSIX
and CLI products both carry the enrolment page, so the web client's asset list grows.

Documentation changes are not optional here, because the current text makes a security
claim that this work invalidates. `ARCHITECTURE.md`'s trust boundaries section states
that the control plane is plain HTTP with no TLS; that becomes a description of `off` mode
rather than of the product. `PACKAGING.md` gains the second port. `ROADMAP.md`'s security
entry is partly satisfied and should say what remains. The changelog entry should be
explicit that a default install still shows a warning on devices that have not enrolled,
because that is what a user will actually see.

## Risks

**The origin guard is a silent-failure surface.** Too strict and every request breaks
loudly, which is survivable; too loose and the protection is gone with no symptom, which
is not. It gets exhaustive tests across scheme, port and default-port permutations.

**A trust anchor is a durable grant.** Anything signed by an anchor a user installed is
trusted by that device until they remove it. This is inherent to the approach and is why
the design insists on fingerprint display, on uninstall instructions being as prominent
as install ones, and on the host UI naming which strategy is active.

**Self-signed reissue invalidates enrolment.** Under the self-signed strategy the leaf is
the anchor, so every reissue — including one caused by moving to a new network — requires
enrolling again. Users with mkcert never hit this. It is a real cost of the
zero-configuration default and should be stated in the UI, not discovered.

**Dependence on external tooling.** The self-signed path shells out to Windows
certificate tooling and the mkcert path to a third-party binary. Both are detected rather
than assumed, and both failures fall through to a working plaintext server, but neither is
as self-contained as a library would be. This is the accepted price of adding no runtime
dependency to a project that has none.

**Scope.** This touches the server, its settings, the CLI, the host UI, the web client and
three documents. It should be planned as several independently shippable pieces rather
than one change, with plaintext behaviour intact at every step.
