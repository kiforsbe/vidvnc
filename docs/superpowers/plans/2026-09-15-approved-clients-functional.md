# Approved Clients Functional Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement approved-client setup, host approval, durable credentials, browser-secret storage, username/password sign-in, and selectable ordinary-connection modes end to end.

**Architecture:** A shared in-memory `ConnectionKeyRegistry` owns only active Session, Client setup, and One-time connection keys and enforces purpose, expiry, and usage. `ApprovedClientStore` persists only readable metadata, username, and salted/verifier material; pending setup claims remain in memory and release a generated client secret only to the submitting browser after host approval. HTTP endpoints expose key dispatch, registration status, and approved sign-in; the desktop owner pipe creates single-use keys and manages pending/approved records; the web client switches among connection-key, registration, pending, and sign-in states.

**Tech Stack:** Node.js ESM, `node:crypto` scrypt/SHA-256, atomic JSON persistence, C# 14 / WinUI 3 owner pipe, browser IndexedDB, existing Node and Playwright test infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-15-approved-clients-design.md`

## Global Constraints

- All key types render as exactly `AAAA-BBBB`; first-letter index modulo four identifies Session (`0`), Client setup (`1`), One-time connection (`2`), or reserved/invalid (`3`).
- Server registry lookup, expiry, and usage are authoritative; client-side decoding is only a presentation hint.
- Client setup and One-time connection keys are short-lived, atomically removed on successful use, and cannot be reused. Session keys are multi-use only for their sharing instance.
- Approved sign-in requires matching client ID, readable username, password verifier, client-secret verifier, and source rate limit.
- Persist no plaintext password, client secret, Session key, Client setup key, pending claim token, or session bearer.
- Never expose password or client-secret values to the native host.
- QR codes and platform passkeys remain out of scope.
- Access selects `session-key`, `one-time-keys`, or `approved-only`; approved sign-in and setup keys remain available in every mode.

---

### Task 1: Typed key registry and durable approved-client domain

**Files:**
- Create: `apps/server/src/connection-keys.mjs`
- Create: `apps/server/src/approved-clients.mjs`
- Create: `apps/server/tests/connection-keys.test.mjs`
- Create: `apps/server/tests/approved-clients.test.mjs`
- Modify: `apps/server/src/session-store.mjs`
- Modify: `apps/server/src/paths.mjs`

**Interfaces:**
- `ConnectionKeyRegistry`: `sessionKey`, `rotateSession()`, `createSetup({ ttlMs })`, `createOneTimeConnection({ ttlMs })`, `inspect(key)`, and atomic `consume(key, purpose)` for single-use records.
- `ApprovedClientStore.open(filename, { keys, clock })`; `submit`, `status`, `approve`, `reject`, `registrationStatus`, `authenticate`, `remove`, `setPermission`.
- `SessionStore.connectApproved(approvedClient, clientKey, userAgent)` creates a standard short-lived session carrying `approvedClientId`.

- [x] Write tests for all purpose-bit patterns, exact lookup, expiry, multi-use Session admission, atomic deletion of both single-use types, persistence redaction, claim isolation, approval/rejection, three-part authentication, and removal.
- [x] Run the new tests and confirm failures are missing-module/missing-method failures.
- [x] Implement the key registry, approved-client store, session admission seam, and settings path.
- [x] Run the new tests and existing session-store tests until green.

### Task 2: HTTP registration and approved sign-in

**Files:**
- Modify: `apps/server/src/http-app.mjs`
- Create: `apps/server/tests/approved-client-http.test.mjs`

**Interfaces:**
- `POST /api/connection-key` `{ key }` → `{ purpose, expiresAt? }` or generic 401.
- `POST /api/approved-clients/register` registration fields → `{ requestId, claimToken }`.
- `POST /api/approved-clients/status` claim handle → pending/rejected/approved; approved returns `{ clientId, clientSecret, username }`.
- `POST /api/approved-clients/sign-in` saved credential plus username/password → normal connection response.

- [x] Write HTTP tests proving flow separation, generic invalid responses, no secret leakage, host approval completion, and approved sign-in.
- [x] Run the HTTP tests and confirm the routes fail before implementation.
- [x] Add the routes and factor common post-admission session setup without changing existing `/api/connect` behavior.
- [x] Run approved-client HTTP, HTTP security, session, and client-settings tests until green.

### Task 3: Desktop owner protocol and functional Clients controls

**Files:**
- Modify: `apps/server/src/main.mjs`
- Modify: `apps/windows-host/HostWindow.cs`
- Modify: `apps/windows-host/HostWindow.Clients.cs`
- Modify: `apps/windows-host/HostWindow.Layout.cs`
- Modify: `apps/windows-host/tests/Navigation/owner-fixture.mjs`
- Modify: `apps/windows-host/tests/Navigation/App.xaml.cs`

**Interfaces:**
- Owner commands: `client-setup-create`, `client-request-command` (`approve`/`reject`), and `approved-client-command` (`remove`/`permission`).
- Owner events: `client-setup-result`, `client-command-result`, and `clients` status.

- [x] Extend the owner fixture and Navigation test to require real setup-key presentation and correctly addressed client commands.
- [x] Run the Navigation regression and confirm failure against disabled controls.
- [x] Wire persistent store startup, status output, setup creation, approval/rejection/removal, and host request/reply handling.
- [x] Run the Navigation regression until green.

### Task 4: Web-client registration and sign-in states

**Files:**
- Create: `apps/web-client/src/approved-client.js`
- Create: `apps/web-client/tests/approved-client.test.mjs`
- Modify: `apps/web-client/src/index.html`
- Modify: `apps/web-client/src/app.js`
- Modify: `apps/web-client/src/shell.css`
- Modify: `apps/web-client/tests/web-browser-check.mjs`

**Interfaces:**
- Origin-scoped IndexedDB record `{ clientId, clientSecret, username }`.
- UI modes: `connection-key`, `register`, `pending`, and `sign-in`; one-time connection remains the fallback.

- [x] Write unit/browser assertions for saved-credential validation, mode choice, setup registration, pending approval, credential storage, username/password sign-in, and connection-key fallback.
- [x] Run the tests and confirm failure before adding the new module/UI.
- [x] Implement IndexedDB storage and the four UI states, reusing existing stream startup after either admission route.
- [x] Run web-client unit tests, approved-client HTTP tests, and the browser fixture until green.

### Task 5: Verification and documentation sync

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-approved-clients-design.md` only if implementation names differ.
- Modify: this plan to mark completed steps.

- [x] Run formatter checks, focused server/web unit suites, Navigation regression, production host build, and the full browser fixture.
- [x] Confirm persisted test fixtures contain no plaintext password or client secret and all HTTP/owner payloads redact secrets from host status.
- [ ] Commit the functional milestone on `main` with focused checkpoint commits.
