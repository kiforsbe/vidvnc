import { sessionStability } from './session-stability.mjs';

export function multiHostStatus(sessions, workers, owner, maxSessions) {
  const rows = sessions.map((session) => {
    const worker = workers.get(session.sessionId);
    const row = hostStatus(
      [session],
      worker ? session.sessionId : null,
      worker?.diagnostics.snapshot() ?? {},
    ).sessions[0];
    row.control = worker && owner?.sessionId === session.sessionId ? 'Granted' : 'View only';
    return row;
  });
  return {
    type: 'status',
    sessions: rows,
    streamCount: rows.reduce((n, row) => n + row.streams.length, 0),
    capabilities: { maxSessions, primaryDisplayOnly: false, hostControl: true },
  };
}

export function hostStatus(sessions, activeId, metrics = {}) {
  const rows = sessions.map((session) => {
    const active = session.sessionId === activeId;
    const fresh = active && metrics.client && metrics.clientAgeMs < 5000;
    const sample = fresh ? metrics.client : null;
    let health = active ? 'Waiting for playback' : 'Connecting';
    if (active && metrics.client && !fresh) health = 'Status unavailable';
    else if (sample) {
      if (sample.lostInterval > 0) health = 'Connection unstable';
      else if (typeof sample.decodeFps === 'number')
        health =
          sample.decodeFps < (session.profile?.fps || 15) * 0.7 ? 'Playback struggling' : 'Smooth';
    }
    return {
      id: session.sessionId,
      device: session.device || 'Browser client',
      address: session.clientKey,
      connectedAt: session.createdAt,
      health,
      control: 'Unknown',
      audio: session.audio?.enabled === true,
      streams: active
        ? [
            {
              name: session.display?.name || 'Primary display',
              displayId: session.display?.id,
              sourceWidth: session.display?.width,
              sourceHeight: session.display?.height,
              profile: session.profile?.name || 'Automatic',
              width: sample?.frameWidth || session.profile?.width || null,
              height: sample?.frameHeight || session.profile?.height || null,
              fps: sample?.decodeFps ?? null,
              targetFps: session.profile?.fps ?? null,
              bitrateMode: session.profile?.bitrateMode ?? null,
              quality: session.profile?.quality ?? null,
              stability: sessionStability(metrics, session.createdAt),
            },
          ]
        : [],
    };
  });
  return {
    type: 'status',
    sessions: rows,
    streamCount: rows.reduce((n, r) => n + r.streams.length, 0),
    capabilities: { maxSessions: 1, primaryDisplayOnly: false, hostControl: false },
  };
}
