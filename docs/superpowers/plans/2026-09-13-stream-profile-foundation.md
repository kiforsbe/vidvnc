# Streaming profile foundation implementation plan

> Execute inline using superpowers:executing-plans, without subagents, in the
> existing approved feature checkout. This is the first independently testable
> batch of the approved design, not the complete UI/media integration milestone.

**Goal:** Persist and resolve a validated server-owned catalog of streaming profiles.
**Architecture:** Pure schema/selection logic plus an atomic file-backed store;
neither module starts media or exposes administration over HTTP.
**Tech stack:** Node ESM, node:test, built-in filesystem APIs; no new dependency.
**Spec:** `docs/superpowers/specs/2026-09-13-stream-profiles-client-design.md`.

## Task 1 — Schema, seed catalog and effective selection

Files: create `apps/server/src/stream-policy.mjs` and
`apps/server/tests/stream-policy.test.mjs`; consume existing `profiles.mjs` seeds.

Interfaces:
```js
defaultStreamPolicy() // fresh schemaVersion=1, revision=0 document
validateStreamPolicy(value) // canonical deep copy or descriptive Error
resolveStreamPolicy(policy, {profileId='auto', displayId, userAgent='', custom, audio=true})
// => {profile:{name,width,height,fps,bitrateKbps,mtu}, audio:{mode}, revision, selectedBy}
```

- [ ] Write node:test cases with literal iPhone/desktop expected settings, denied
  explicit IDs, custom-list membership, stale default references, audio denial,
  schema versions, duplicate IDs, invalid dimensions and snapshot independence.
- [ ] Run `node --test apps/server/tests/stream-policy.test.mjs`; verify failure.
- [ ] Build the seed records from getProfile without changing original profiles.
  Validate bounded values, exact keys and enabled-default references. Keep auto
  compatibility behavior only when no explicit request/default overrides it.
- [ ] Resolve named/custom requests into copies, force transport MTU 1200 and host
  audio upper bounds. Reject variable delivery and unknown explicit requests.
- [ ] Rerun tests until passing; run existing profiles tests unchanged.

## Task 2 — Atomic persistence and revision conflict handling

Files: create `apps/server/src/stream-policy-store.mjs` and
`apps/server/tests/stream-policy-store.test.mjs`.

Interfaces:
```js
await StreamPolicyStore.open(filename) // ENOENT => seed in memory; corruption fails
store.snapshot() // independent document
await store.replace(candidate, expectedRevision) // canonical committed snapshot
```

- [ ] Write tests using mkdtemp under OS temp: first open defaults, save/reopen,
  concurrent updates against one revision (exactly one succeeds), no mutation via
  snapshot, validation failure preserves disk, corrupt/future schema rejected,
  filesystem failure leaves revision and previous configuration untouched.
- [ ] Run `node --test apps/server/tests/stream-policy-store.test.mjs`; verify failure.
- [ ] Serialize replace calls. Validate before I/O, write unique sibling temporary
  file with exclusive creation and owner-only mode, sync/close, rename, then publish
  memory state. Remove only that temporary file on failure. Never overwrite a file
  whose on-disk revision differs. Reject overlarge files before parsing.
- [ ] Run both new suites and `npm.cmd test`. Format only the new JS/test files.
- [ ] Record exact completed scope in this plan and roadmap. No automatic commit
  or claim of active runtime enforcement before integration.

## Following batches (dependencies, not completed by this foundation)

1. Wire schema to bounded correlated owner commands and effective numeric native
   worker plans; authenticated permitted catalog and offer-time enforcement.
2. Implement the approved profiles tab, availability switches and ContentDialog
   with server acknowledgments; defaults/overrides on Displays, atomic Apply.
3. Finish actual display selection/input/topology/revocation from the existing
   display-selection plan. Verify two-monitor capture and coordinate mapping.
4. Implement approved single-input pairing and light/dark responsive browser shell
   without replacing player/overlay; connect picker and effective quality choices.
5. Complete native/browser/system acceptance; investigate variable delivery only
   after fixed-profile behavior remains stable. Per-display allowed-profile lists,
   multisession and multistream remain later roadmap work.

Each integration batch gets focused tests and a detailed execution checklist
before changes to media or administration. Preserve current working streams while
developing/testing; do not terminate an existing user session to run tests.
