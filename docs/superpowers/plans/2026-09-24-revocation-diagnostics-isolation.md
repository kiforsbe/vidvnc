# F2/F4/F5 follow-up implementation plan

> **For Codex:** Use superpowers:executing-plans inline on main, with superpowers:test-driven-development for each code task. The user explicitly requested main rather than a worktree.

**Goal:** Make revoked client permissions immediately invalidate active sessions, move diagnostics off public-capable ports, and accurately label the approved secret.

**Spec:** [2026-09-24 design](../specs/2026-09-24-revocation-and-diagnostics-isolation-design.md).

**Context:** `apps/server/src/owner-security-commands.mjs`, `http-app.mjs`, `main.mjs`, `cli/console.mjs`, Windows host, and their tests. Preserve current F1/F7 controls and compatibility of approved-client storage fields. Do not create a worktree or claim Internet readiness.

## Task 1: F2 immediate invalidation and stream teardown

**Interfaces:** Owner command produces session invalidation for HTTP and stream runtime; consumes `SessionStore.disconnect`, `StreamRuntime.stopSession`, approved-client persistence. No owner success before teardown and persistence.

1. Add tests in `apps/server/tests/owner-security-commands.test.mjs` for synchronous bearer invalidation on permission edit/removal, multiple matching sessions, unrelated sessions surviving, pending teardown delaying success, and failure closing sharing. Run the focused test and observe failure.
2. Implement the owner command ordering and fail-closed shutdown. Recheck any protected asynchronous HTTP route that can finish after disconnect. Add an HTTP regression test for that race, see it fail, then make it pass.
3. Run focused tests and `npm test`. Expected: all pass. Update host copy so permission changes warn about disconnects.

## Task 2: F4 separate private diagnostics listener

**Interfaces:** New local listener produces a URL for owner pipe and CLI; public app no longer consumes diagnostics objects/capabilities; Windows host consumes URL plus token from owner reply.

1. Change public HTTP tests to require 404 for diagnostics page/API/assets with no redirect or bearer exception. Add failing private-listener tests for loopback binding, bearer-only API, static allowlist, and public route absence.
2. Build `apps/server/src/diagnostics-http.mjs`; remove public routes and diagnostic-only assets. Wire private bind/close into `main.mjs` and owner reply; remove misleading address property; update CLI, tests, startup check.
3. Update Windows host and navigation fixture/test to use and validate the owner-provided private URL. Run `npm test`, startup check, Windows build/navigation. Expected: all pass.

## Task 3: F5 wording, status, and changelog

**Interfaces:** User-facing copy and current docs; no protocol/storage change.

1. Change browser and Windows copy to say browser/client secret additional to username/password, copyable and not device proof. Add/update copy assertions where present.
2. Update the security status and remediation-proposal addendum to distinguish implemented F2/F4 from remaining F3/F6 and accepted F5 model. Keep historical review unchanged. Update `CHANGELOG.md` Unreleased.
3. Run formatting check, full tests, Windows build/navigation, and startup check. Expected: all pass. Review the complete diff against this spec before handoff.

## Review focus

Check all asynchronous authenticated response paths after mid-request disconnect; native input/stream teardown races and failure behavior; HTTP/HTTPS route parity and TLS redirects; private listener bind/shutdown failures; host URL validation; documentation overclaims.

## Execution record (2026-09-24)

Implemented on `main` without a worktree, per the owner's instruction. Focused F2 and F4 tests were observed failing before their corresponding code changes, then passing. The complete Node suite passed 776/776; formatting, production startup, Windows host build, and Windows navigation passed. A read-only fresh-context security review found no Critical or Important issue. Deferred minor coverage: a synthetic multi-session approved-client fixture (normal admission enforces one session per credential), and an injected private-listener bind-failure/close assertion. Native hardware timeout behavior and a physical desktop Diagnostics click remain unexercised, as tracked in the security status.
