# Streaming profile host/runtime integration

> Use superpowers:executing-plans inline without subagents in this checkout.

**Goal:** Connect the approved native profile editor to persisted server policy
and effective numeric media plans, with no unauthenticated administration API.
**Architecture:** Server owns StreamPolicyStore; bounded correlated owner-pipe
commands manage it. HTTP resolves allowed choices at connect and checks policy
revision again before offer. Worker validates numeric encoder fields independently.
**Spec:** `../specs/2026-09-13-stream-profiles-client-design.md`.

## 1. Owner commands and live enforcement

Create `apps/server/src/policy-controller.mjs` and colocated tests. Controller
exposes `snapshot()`, `busy`, and async `replace(candidate, revision, disconnect)`.
Reject updates affecting connected clients unless disconnect is explicitly true.
Block new connect/offer while saving, then revoke all current sessions and await
worker shutdown before success acknowledgment. A failed save keeps sessions alive.

Wire `main.mjs` to open per-user stream-policy.json and emit policy with ready.
Owner command `{type:'policy-set',requestId,revision,policy,disconnect}` produces
`{type:'policy-result',requestId,ok,policy,error}`. Bound command bytes to 128KiB,
serialize updates, and keep stop/disconnect working. Never add a public write route.
Add authenticated POST `/api/profiles` for permitted records. At connect resolve
profile and audio from policy and record revision in session; stale offers fail
and retire session. Return an effective numeric profile, not editable transport.
Use real HTTP tests to reject denied/custom requests and prove audio denial.

## 2. Native numeric plan

Create pure `native/media-worker/src/stream-profile.hpp` with strict JSON numeric
plan parser; test bounds, booleans/strings, unknown/missing fields and valid custom
1600x900/30/3000. Add test target linked to json-glib. NativeMedia sends streamPlan
alongside legacy profile name; supplied invalid numeric plans must not fall back.
Retain legacy fixed-profile route for compatibility tests. Preserve encoder tuning;
only request H.264 level3.1 when the output fits its frame-size/rate limits.

## 3. Native host UI

Create `HostWindow.Profiles.cs`: immutable policy snapshots, request acknowledgment
tracking, Streaming profiles render and New/Edit ContentDialog. Add tab immediately
after Displays, retaining shell. Rows: left ToggleSwitch, name/description, right
numeric columns and MenuFlyout Edit/Duplicate/Remove. Toggle/save/remove operate
on a deep-copied document; await server result, display failures, disable during
pending save. Ask before disconnecting current clients. Description is editable.
Variable mode and advanced options stay disabled until their runtime/UI gates.
Create/edit uses native NumberBox controls with server validation authoritative.
No changes to existing running host unless user starts the rebuilt executable.

## Verification steps

- Write failing controller/HTTP/native/UI tests before the respective change.
- Run Node suites, build native Debug and CTest, then build/run Navigation fixture.
- Check profile row identity, enabled switches only with server connection, modal
  fields and cancel path, six-tab navigation and existing layout regressions.
- Update progress with actual results; live GPU custom-plan playback requires a
  separate real-client acceptance run, not inferred from unit tests/builds.

Display overrides, real secondary capture/input and web shell remain following
batches from the approved design. Do not claim this batch completes those features.
