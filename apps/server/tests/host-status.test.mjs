import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session-store.mjs';
import * as statusModule from '../src/host-status.mjs';
const { hostStatus } = statusModule;

test('concurrent host status keeps each worker history and control permission with its owner', () => {
  const sessions = [
    { sessionId: 'a', createdAt: 1000, profile: { name: 'mobile', fps: 15 } },
    { sessionId: 'b', createdAt: 1000, profile: { name: 'balanced', fps: 30 } },
  ];
  const worker = (fps) => ({
    diagnostics: {
      snapshot: () => ({
        at: 3000,
        clientAgeMs: 0,
        client: { decodeFps: fps },
        history: [{ source: 'client', at: 3000, decodeFps: fps }],
      }),
    },
  });
  const workers = new Map([
    ['a', worker(15)],
    ['b', worker(3)],
  ]);
  const result = statusModule.multiHostStatus(
    sessions,
    workers,
    { sessionId: 'a', streamId: 'a' },
    2,
  );
  assert.equal(result.sessions[0].health, 'Smooth');
  assert.equal(result.sessions[1].health, 'Playback struggling');
  assert.equal(result.sessions[0].streams[0].stability.points[0].fps, 15);
  assert.equal(result.sessions[1].streams[0].stability.points[0].fps, 3);
  assert.equal(result.sessions[0].control, 'Granted');
  assert.equal(result.sessions[1].control, 'View only');
  assert.equal(result.streamCount, 2);
  workers.delete('a');
  const after = statusModule.multiHostStatus(sessions, workers, null, 2);
  assert.equal(after.sessions[0].streams.length, 0);
  assert.equal(after.sessions[1].streams[0].stability.points[0].fps, 3);
});

test('stability history uses interval events, excludes old sessions and preserves unavailable FPS', () => {
  const sessions = [{ sessionId: 'current', createdAt: 2000, profile: { fps: 30 } }];
  const client = (at, fps, dropped, freezes, pli) => ({
    source: 'client',
    at,
    decodeFps: fps,
    framesDropped: dropped,
    freezeCount: freezes,
    pliCount: pli,
    firCount: 0,
    packetsLost: 0,
  });
  const metrics = {
    at: 66000,
    history: [
      client(1000, 30, 999, 99, 99),
      client(5000, 30, 10, 2, 4),
      client(6000, 20, 12, 3, 5),
      client(7000, null, 12, 3, 5),
      client(7000, 999, 99, 99, 99),
      client(12000, 30, 1, 0, 0),
    ],
  };
  const graph = hostStatus(sessions, 'current', metrics).sessions[0].streams[0].stability;
  assert.equal(graph.at, 66000);
  assert.deepEqual(
    graph.points.map((p) => [p.at, p.fps, p.drops, p.freezes, p.recovery]),
    [
      [6000, 20, 2, 1, 1],
      [7000, null, 0, 0, 0],
      [12000, 30, null, null, null],
    ],
  );
  assert.equal(graph.stale, true);
  assert.equal(hostStatus(sessions, 'other', metrics).sessions[0].streams.length, 0);
});

test('stream rows report the profile bitrate mode and quality, or null without a resolved profile', () => {
  const vbr = { name: 'sharp', fps: 30, bitrateMode: 'vbr', quality: 'high' };
  const row = (profile) =>
    hostStatus([{ sessionId: 'a', createdAt: 1000, profile }], 'a').sessions[0].streams[0];
  assert.equal(row(vbr).bitrateMode, 'vbr');
  assert.equal(row(vbr).quality, 'high');
  assert.equal(row(undefined).bitrateMode, null);
  assert.equal(row(undefined).quality, null);
});

test('device labels identify browser platforms without trusting a claimed user identity', () => {
  const store = new SessionStore();
  store.connect(store.password, '127.0.0.1', 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0)');
  assert.equal(hostStatus(store.list(), null).sessions[0].device, 'iPhone');
});

test('stability compares independent capture/encode and decode sample times without interpolation', () => {
  const sessions = [{ sessionId: 'current', createdAt: 1000, profile: { fps: 30 } }];
  const metrics = {
    at: 65000,
    history: [
      { source: 'server', at: 4000, captureFps: 999, encodeFps: 999 },
      { source: 'server', at: 6000, captureFps: 30, encodeFps: 29 },
      { source: 'client', at: 6500, decodeFps: 24 },
      { source: 'server', at: 8000, captureFps: null, encodeFps: 28 },
      { source: 'server', at: 64000, captureFps: 30, encodeFps: 30 },
    ],
  };
  const graph = hostStatus(sessions, 'current', metrics).sessions[0].streams[0].stability;
  assert.deepEqual(graph.generated, [
    { at: 6000, captureFps: 30, encodeFps: 29 },
    { at: 8000, captureFps: null, encodeFps: 28 },
    { at: 64000, captureFps: 30, encodeFps: 30 },
  ]);
  assert.equal(graph.points[0].at, 6500);
  assert.equal(graph.points[0].fps, 24);
  assert.equal(graph.serverStale, false);
  assert.equal(graph.stale, true);
});

test('host session listing does not keep abandoned clients alive', () => {
  let now = 100;
  const store = new SessionStore({ clock: () => now, sessionTtlMs: 1000 });
  store.connect(store.password, '127.0.0.1');
  now = 900;
  assert.equal(store.list().length, 1);
  now = 1100;
  assert.equal(store.list().length, 0);
});

test('host status uses current session metrics and never claims missing telemetry is smooth', () => {
  const store = new SessionStore();
  const { sessionId } = store.connect(store.password, '192.168.1.2');
  store.setProfile(sessionId, { name: 'mobile', width: 1280, height: 720, fps: 15 });
  const diagnostics = {
    clientAgeMs: 100,
    client: { decodeFps: 15, lostInterval: 0, frameWidth: 1280, frameHeight: 720 },
  };
  const snapshot = (id, metrics) => hostStatus(store.list(), id, metrics);
  assert.equal(snapshot(sessionId, diagnostics).sessions[0].health, 'Smooth');
  assert.equal(snapshot('other', diagnostics).streamCount, 0);
  assert.equal(snapshot(sessionId, {}).sessions[0].health, 'Waiting for playback');
  assert.equal(
    snapshot(sessionId, { ...diagnostics, clientAgeMs: 10000 }).sessions[0].health,
    'Status unavailable',
  );
  assert.equal(
    snapshot(sessionId, { ...diagnostics, client: { decodeFps: 1, lostInterval: 0 } }).sessions[0]
      .health,
    'Playback struggling',
  );
  const text = JSON.stringify(snapshot(sessionId, diagnostics));
  assert.ok(!text.includes(store.password));
  assert.equal(snapshot(sessionId, diagnostics).sessions[0].control, 'Unknown');
});
