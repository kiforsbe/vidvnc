# Latency probe from Diagnostics — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. This plan, by the owner's preference, names files,
> interfaces, behaviour and tests but contains no implementation code.

**Goal:** Start the latency probe from the host's Diagnostics page for one stream, run it on
that stream's viewer without any probe code or UI in a normal session, and show the results
in Diagnostics.

**Architecture:** A server-side `LatencyProbes` registry holds at most one measurement. The
diagnostics listener creates it; the viewer learns of it in the reply to its per-second
`stream-telemetry` post, lazily imports the probe module (served only to that session while
the measurement is active), runs it, and posts results to a new strictly validated route.
Diagnostics reads the measurement from its existing snapshot.

**Tech stack:** Node.js (built-in `node:test`), browser JavaScript (no framework),
`requestVideoFrameCallback`, Canvas 2D, Playwright for the browser check.

**Spec:** [2026-10-14-latency-probe-from-diagnostics-design.md](../specs/2026-10-14-latency-probe-from-diagnostics-design.md)

## Global constraints

- One measurement at a time per server; ids are 128 random bits, base64url.
- Timeouts: `requested` expires after 15 s without pickup; `running` expires after 120 s
  without a result. History: last five finished measurements per stream, memory only.
- Run: 40 moves and 40 presses of `KeyL`, alternating, pauses 150–400 ms, 2 s per-trial
  timeout, probe page must read within 2 s of start.
- Reasons, exactly: `no-control`, `no-probe-page`, `unsupported`, `cancelled`,
  `stream-changed`, `control-lost` (viewer); `expired`, `ended`, `invalid-report` (server).
- Bodies: `POST /api/diagnostics/latency-probe` at most 1 KiB; `POST /api/latency-result`
  at most 8 KiB.
- Timings `{count, min, median, p95, max}`, finite, 0–60,000 ms (glass-to-glass from
  -60,000), `count` integer ≤ 1,000, or `{count: 0}`; `browser` ≤ 200 characters, text only;
  `video` integers ≤ 16,384; unknown fields rejected.
- Banner text: "Measuring latency for the host. Keep your hands off the screen." with
  **Cancel**.
- The normal viewer never fetches `/viewer/latency-probe.js`; the server 404s it unless the
  grant's session has a measurement `requested` or `running`.
- Repository rules: [AGENTS.md](../../../AGENTS.md) (docs in the same commit, changelog under
  `## [Unreleased]`, `npm run format:check` and `npm test` before each commit; Markdown
  tables aligned with `npx prettier --write`). Commit subjects in the imperative with a
  `Area: ` prefix.

## Review focus

1. **The viewer reloads or reconnects mid-run.** The measurement must end (`ended` or
   `expired`), Diagnostics must say so, and the module must stop being served. Test in
   Task 2.
2. **The stream picked in Diagnostics is not the one the viewer shows** (two streams on a
   device). The viewer must report `stream-changed`, not measure the wrong video. Test in
   Task 5.
3. **Control is lost during a run** (the host revokes it, or another device takes it). The
   run must stop sending input at once and report `control-lost`. Test in Task 5.
4. **A results post arrives after expiry or for a finished measurement.** It must be a 404,
   and it must not overwrite the recorded outcome. Test in Task 1.
5. **Diagnostics is polled from two windows and Measure is pressed in both.** The second
   must get a 409 and show "A measurement is already running". Test in Task 3.

---

### Task 1: Server measurement registry and results validation

**Files:**

- Create: `apps/server/src/latency-probes.mjs`, `apps/server/src/latency-results.mjs`
- Test: `apps/server/tests/latency-probes.test.mjs`, `apps/server/tests/latency-results.test.mjs`

**Interfaces:**

- Produces `validateLatencyResults(value)` in `latency-results.mjs`: returns a deep copy
  holding exactly the schema's fields, or throws `Error('Invalid latency results')`. Also
  exports `LATENCY_REASONS` (the six viewer reasons, frozen).
- Produces `class LatencyProbes` in `latency-probes.mjs`, constructed with
  `{ isLive(sessionId, streamId) → boolean, now = Date.now, randomId }`. Methods:
  - `request(streamId, sessionId)` → `{id, state: 'requested'}`; throws
    `Object.assign(new Error('A measurement is already running'), {code: 'busy'})` when one
    is `requested` or `running`.
  - `pickup(sessionId, streamId)` → `{id}` once for a `requested` measurement of that
    session and stream, then `null` on every later call; `null` when there is none.
  - `report(sessionId, {streamId, id, state, reason, results})` → `true`, or `false` when
    the id is not this session's active measurement for that stream (the route turns
    `false` into 404). `state: 'running'` only from `requested`; `done` needs `results`
    (validated with `validateLatencyResults`); `failed` needs a reason from
    `LATENCY_REASONS`. Anything else throws `Error('Invalid latency report')`, and the
    measurement becomes `failed` with reason `invalid-report`.
  - `allowsAsset(sessionId)` → `true` while that session's measurement is `requested` or
    `running`.
  - `snapshot(streamId)` → `{active: <measurement or null>, history: [<up to five, newest
first>]}`, each measurement `{id, state, reason, requestedAt, endedAt, results}`.
  - Every method first settles timeouts (`requested` older than 15 s → `failed`/`expired`;
    `running` older than 120 s → `failed`/`expired`) and liveness (`isLive` false →
    `failed`/`ended`), so no timer is needed.

- [ ] **Step 1: Write the failing results tests.** Cases: a complete valid body passes and
      is copied; each timing field rejects a negative, `NaN`, `Infinity`, a string and
      60,001 (but `glassToGlassMs.min` accepts -59,999); `count` rejects 1.5 and 1,001;
      `{count: 0}` passes on its own; an unknown top-level field and an unknown field inside
      `receiver` are rejected; `receiver` fields accept `null`; `browser` of 201 characters
      is rejected; `video.width` of 16,385 is rejected; `overhead.skippedFrames` must be an
      integer.
- [ ] **Step 2: Run** `node --test apps/server/tests/latency-results.test.mjs`; expect
      failures (module missing).
- [ ] **Step 3: Implement `latency-results.mjs`** to the schema in the spec and Global
      constraints.
- [ ] **Step 4: Write the failing registry tests,** with an injected clock and `isLive`:
      request then busy (`code: 'busy'`); pickup returns the id once, never for another
      session or stream; expiry after 15,001 ms without pickup, and after 120,001 ms of
      running; `isLive` turning false ends it with `ended`; `report` for a wrong id, another
      session, or after it finished returns `false` and leaves the outcome unchanged (Review
      focus 4); `done` with invalid results fails it with `invalid-report`; history keeps
      five, newest first, per stream; `allowsAsset` is true only while requested or running
      and only for its session (Review focus 1: after `ended`, false).
- [ ] **Step 5: Run** `node --test apps/server/tests/latency-probes.test.mjs`; expect
      failures.
- [ ] **Step 6: Implement `latency-probes.mjs`.** Use `crypto.randomBytes(16)` as base64url
      for the default `randomId`.
- [ ] **Step 7: Run both test files;** expect all to pass.
- [ ] **Step 8: Commit** `Server: track latency measurements and validate their results`.
      No documentation yet: nothing is reachable until Task 2.

### Task 2: Viewer routes — request pickup, module gate, results

**Files:**

- Modify: `apps/server/src/viewer-asset-grants.mjs` (add `sessionFor`),
  `apps/server/src/http-app.mjs` (the `/api/stream-telemetry` branch, the `VIEWER_ASSETS`
  serving branch, a new `/api/latency-result` route, its body limit, `createHttpApp`
  options), `apps/server/src/main.mjs` (construct `LatencyProbes` once and pass it to both
  listeners)
- Test: `apps/server/tests/viewer-asset-grants.test.mjs`, and the server test that drives
  `/api/stream-telemetry` (find it with `git grep -l "stream-telemetry" apps/server/tests`);
  `apps/server/tests/http-security.test.mjs` for the gate

**Interfaces:**

- Consumes `LatencyProbes` from Task 1.
- Produces `ViewerAssetGrants#sessionFor(cookieHeader, peer, sessionStore)` → the session
  id the valid grant belongs to, or `null`; `allows()` becomes `sessionFor(...) !== null`.
- Produces `createHttpApp({ ..., latencyProbes })`; when omitted, the routes behave as
  today and `/viewer/latency-probe.js` is always a 404.
- Produces route `POST /api/latency-result`: session bearer; 204 on success, 404 for a
  report `LatencyProbes#report` refuses, 400 for an invalid body, 413 over 8 KiB. Add it to
  whatever list makes stream routes reachable from the internet, exactly as
  `/api/stream-telemetry` is.
- `main.mjs`: `isLive` is `(sessionId, streamId) => runtime.registry.get(sessionId,
streamId)?.state === 'live'`.

- [ ] **Step 1: Write failing tests.** `sessionFor` returns the session for a valid grant
      and `null` for each case `allows` refuses today. The telemetry reply is 204 normally,
      `200 {latencyProbe: {id}}` once after `request`, then 204 again. The module is 404
      without a measurement, 200 for the session that has one requested or running, 404 for
      another session's valid grant, and 404 again after the measurement ends (Review
      focus 1: end the stream, then fetch). `/api/latency-result`: 204 for `running` then
      `done`; 404 for a wrong id; 400 for an unknown field; 413 for a 9 KiB body; 401 or the
      existing missing-token response without a bearer.
- [ ] **Step 2: Run** those test files; expect the new cases to fail.
- [ ] **Step 3: Implement** `sessionFor`, the three route changes and the `main.mjs` wiring.
      Keep `/viewer/latency-probe.js` in `VIEWER_ASSETS` and check
      `latencyProbes?.allowsAsset(sessionId)` only for that path.
- [ ] **Step 4: Run** the same files, then `npm test`; expect all to pass.
- [ ] **Step 5: Commit** `Server: deliver latency measurements to the viewer and accept
  results`, with the security architecture updated in the same commit
      ([docs/ARCHITECTURE.md → Attack surface and Threat model](../../ARCHITECTURE.md#attack-surface)):
      the new viewer route, the conditional module, and the "forged or hostile results"
      threat row from the spec.

### Task 3: Diagnostics route and snapshot

**Files:**

- Modify: `apps/server/src/diagnostics-http.mjs`, `apps/server/src/main.mjs` (pass
  `latencyProbes`)
- Test: `apps/server/tests/diagnostics-http.test.mjs`

**Interfaces:**

- Consumes `LatencyProbes` from Task 1 and `runtime.diagnosticStreams()` /
  `runtime.registry` for the stream's session.
- Produces `createDiagnosticsHttp({ ..., latencyProbes })`.
- Produces `POST /api/diagnostics/latency-probe`, body `{streamId}` ≤ 1 KiB, bearer and an
  `Origin` header both required: `202 {id, state}`, `404` unknown stream, `409 {error: 'A
measurement is already running'}`, `400` bad body, `403` without bearer or Origin.
  Every other route stays GET-only.
- Produces `latencyProbe: LatencyProbes#snapshot(selectedStreamId)` in the
  `GET /api/diagnostics` body.

- [ ] **Step 1: Write failing tests:** each response above; a second request while the
      first is active gets 409 (Review focus 5); a POST to `/api/diagnostics` is still 405;
      the snapshot carries `latencyProbe` for the selected stream and an empty one for
      another stream.
- [ ] **Step 2: Run** `node --test apps/server/tests/diagnostics-http.test.mjs`; expect
      failures.
- [ ] **Step 3: Implement.** Find the stream's session through the runtime; a stream not
      `live` is a 404.
- [ ] **Step 4: Run** the file, then `npm test`; expect all to pass.
- [ ] **Step 5: Commit** `Diagnostics: start a latency measurement for a stream`, with the
      security architecture's diagnostics paragraph, attack surface (the listener's first
      POST) and the "stolen diagnostics bearer" threat row updated in the same commit.

### Task 4: Probe module as a run function, read only during runs

**Files:**

- Modify: `apps/web-client/src/viewer/latency-probe.js`, `apps/web-client/src/viewer/app.js`
  (drop the static import and the `?latency-probe` block, so the viewer keeps working
  between this task and the next), `apps/web-client/src/viewer/style.css` (drop the
  `.latency-probe` rules)
- Test: `apps/web-client/tests/latency-probe.test.mjs`

**Interfaces:**

- Keeps the pure exports (`GRID`, `LAYOUT`, `PROBE_KEY`, `MOVE_TARGETS`,
  `encodeTimestamp`, `decodeTimestamp`, `unwrapTimestamp`, `classify`, `readFrame`,
  `desktopRect`, `summarize`, `videoReceiverStats`) unchanged; the probe-page sync test
  stays.
- Removes `createLatencyProbe` and all panel DOM code.
- Produces `runLatencyProbe({ video, send, canControl, source, getStats, summarizeReceiver,
signal, trials = 40 })` → a promise of `{state: 'done', results}` or
  `{state: 'failed', reason}`, where `reason` is one of the viewer reasons. It: checks
  `requestVideoFrameCallback` (`unsupported`); checks `canControl()` (`no-control`);
  registers its frame callback; waits up to 2 s for a readable barcode (`no-probe-page`);
  runs the trials; stops at once and reports `cancelled` when `signal` aborts, or
  `control-lost` when `canControl()` turns false between trials; stops reading frames when
  it returns.
- Produces `buildResults({ samples, timeouts, glass, overhead, receiver, video, browser })`
  → the results object exactly in the server's schema (Task 1), with `browser` cut to 200
  characters.
- Canvas: `getContext('2d')` without `willReadFrequently`.
- Overhead: time each frame callback (`performance.now()` around the read); count missed
  frames as the sum of `metadata.presentedFrames - previous - 1` when positive.

- [ ] **Step 1: Write failing tests** for `buildResults` (shape matches the schema field for
      field; `browser` truncated; empty sample lists give `{count: 0}`), and for
      `runLatencyProbe` with fakes: a `video` whose `requestVideoFrameCallback` feeds frames
      from a scripted list through a stubbed `read` seam, a fake `send` that flips the
      scripted patch state after a fixed delay, and a fake clock. Cases: no
      `requestVideoFrameCallback` → `unsupported`; no barcode within 2 s → `no-probe-page`;
      `canControl()` false → `no-control`; abort mid-run → `cancelled` and no `send` after
      the abort; `canControl()` turning false mid-run → `control-lost` and no further
      `send` (Review focus 3); a full run → `done` with 40 + 40 samples. Expose the frame
      reader as an injectable option (`readFrameFrom`, default reads the canvas) so the
      tests need no canvas.
- [ ] **Step 2: Run** `node --test apps/web-client/tests/latency-probe.test.mjs`; expect
      failures.
- [ ] **Step 3: Implement** the run function, results builder, overhead counting and the
      canvas change; delete the panel code.
- [ ] **Step 4: Run** the file, then `npm test`; expect all to pass. Until Task 5 the
      viewer has no way to start a run, which is expected.
- [ ] **Step 5: Commit** `Viewer: run the latency probe as a function, reading frames only
  while it runs`.

### Task 5: Viewer — load on request, banner, report

**Files:**

- Modify: `apps/web-client/src/viewer/app.js` (handle requests),
  `apps/web-client/src/stream-subscriptions.js` (pass the telemetry reply on),
  `apps/web-client/src/viewer/fragment.html` (banner markup, hidden),
  `apps/web-client/src/viewer/style.css` (the banner's rules)
- Test: `apps/web-client/tests/stream-control.test.mjs` (or the test that constructs
  `StreamSubscriptions`), `apps/web-client/tests/web-browser-check.mjs`

**Interfaces:**

- Consumes `runLatencyProbe` from Task 4 (via `await import('./latency-probe.js')`), the
  `200 {latencyProbe: {id}}` telemetry reply and `POST /api/latency-result` from Task 2.
- Produces a `StreamSubscriptions` constructor option `onLatencyProbe(streamId,
{id})`, called when a `stream-telemetry` reply carries `latencyProbe`.
- In `app.js`: `startLatencyProbe(streamId, id)`: if a run is active, report the new one
  `failed`/`stream-changed`; if `streamId` is not the selected row's id, report
  `stream-changed` (Review focus 2); otherwise import the module (failure → `unsupported`),
  post `running`, show the banner, call `runLatencyProbe` with an `AbortController`
  whose abort is wired to **Cancel**, to the selected stream changing and to
  `disconnect()`; post the outcome; hide the banner. `canControl` is `() => enabled`.
- Banner: an element inside `#stage` so it shows in immersive mode and element full screen;
  text and button as in Global constraints; `role="status"`.

- [ ] **Step 1: Write failing tests:** `StreamSubscriptions` calls `onLatencyProbe` with
      the stream id and request when the telemetry reply has `latencyProbe`, and not for a 204. In the browser check: a normal session makes no request for
      `/viewer/latency-probe.js`; after the test server marks a measurement for the session
      (use the test server's `LatencyProbes` instance), the viewer fetches the module, shows
      the banner, and **Cancel** results in a `failed`/`cancelled` report.
- [ ] **Step 2: Run** `npm test --workspace @vidvnc/web-client` and the browser check
      (`node apps/web-client/tests/web-browser-check.mjs`, see
      [CONTRIBUTING.md](../../../CONTRIBUTING.md) for its prerequisites); expect failures.
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run** both again, then `npm test`; expect all to pass.
- [ ] **Step 5: Commit** `Viewer: run the latency probe only when the host asks for it`.

### Task 6: Diagnostics page — Measure latency and results

**Files:**

- Create: `apps/web-client/src/latency-report.js` (pure: snapshot → display rows and
  sentences)
- Modify: `apps/web-client/src/diagnostics.html`, `apps/web-client/src/diagnostics.js`,
  `apps/web-client/src/diagnostics.css`, `apps/server/src/diagnostics-http.mjs` (add
  `/latency-report.js` to `ASSETS`)
- Test: `apps/web-client/tests/latency-report.test.mjs`,
  `apps/server/tests/diagnostics-http.test.mjs` (the new asset is served)

**Interfaces:**

- Consumes `GET /api/diagnostics` → `latencyProbe` and
  `POST /api/diagnostics/latency-probe` from Task 3.
- Produces `describeState(measurement)` → a sentence ("Waiting for the viewer…",
  "Measuring…", "Done", or the failure in words: `no-control` → "The viewer doesn't have
  keyboard and mouse control.", `no-probe-page` → "The probe page isn't visible on the
  shared display.", `unsupported` → "The viewer's browser can't measure.", `cancelled` →
  "Cancelled on the viewer.", `stream-changed` → "The viewer isn't showing this stream.",
  `control-lost` → "The viewer lost control during the run.", `expired` → "The viewer
  didn't respond.", `ended` → "The stream ended.", `invalid-report` → "The viewer sent
  invalid results.") and `resultRows(results)` → rows of `[label, median, p95, range,
count]` for moves and key presses (hand-to-glass and to last packet), glass-to-glass
  (labelled "exact only when the viewer runs on this PC"), receiver figures, overhead,
  browser and video size.
- Page: a **Latency** section under the stream picker with the reminder line from the spec,
  **Measure latency** (disabled while `latencyProbe.active` exists; a 409 shows "A
  measurement is already running"), the state sentence, the newest result as a table, the
  history list with **Copy as JSON** per run. All text set with `textContent`.

- [ ] **Step 1: Write failing tests** for `describeState` (every reason) and `resultRows`
      (`{count: 0}` shows "—"; numbers rounded to 0.1 ms), and that the diagnostics listener
      serves `/latency-report.js`.
- [ ] **Step 2: Run** them; expect failures.
- [ ] **Step 3: Implement** the module, the page section and the asset entry.
- [ ] **Step 4: Run** them, then `npm test`; expect all to pass. Open Diagnostics from the
      host (Diagnostics action) and check the section renders with no streams and with one.
- [ ] **Step 5: Commit** `Diagnostics: measure latency from the page and show the results`.

### Task 7: Documentation and wrap-up

**Files:**

- Modify: `tools/debug/README.md` (rewrite the Latency probe section around Diagnostics;
  drop the "single-stream sessions only" claim: it measures the stream the viewer shows),
  `docs/ARCHITECTURE.md` (Diagnostics: the measurement flow with the sequence diagram from
  the spec; confirm the security rows from Tasks 2 and 3), `CHANGELOG.md` (replace the
  unreleased latency-probe entry: started from Diagnostics, results shown there),
  `README.md` (the diagnostics paragraph: one sentence on Measure latency)

- [ ] **Step 1: Update the documents.** Check every route, limit, reason and timeout
      against the code. Make sure both Mermaid diagrams parse (no semicolons in messages).
- [ ] **Step 2: Run** `npx prettier --write` on each edited Markdown file and check the diff
      touches only these sections; then `npm run format:check` and `npm test`.
- [ ] **Step 3: Commit** `Docs: latency measurements from Diagnostics`.
- [ ] **Step 4: Hand over for the manual check:** a run from Diagnostics with the viewer on
      the host, and one on an iPhone, recording the results in the spec's terms; not done
      by the implementing agent.
