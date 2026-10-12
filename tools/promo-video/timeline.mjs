// The film's timeline: every scene in order, the seconds it starts and ends, and the moments
// the storyboard stills are taken. scenes/<file> draws each one, engine/film.mjs plays them
// as one film, promo.mjs takes the stills, and music.py places its cues on the same times.
// Pure data, so Node and the browser both read it.
export const SCENES = [
  { id: 'lag', file: '01-lag.mjs', start: 0, end: 12.2, stills: [10.5] },
  { id: 'race', file: '02-race.mjs', start: 12.2, end: 24, stills: [20] },
  { id: 'number', file: '03-number.mjs', start: 24, end: 29.5, stills: [27.5] },
  { id: 'app-code', file: '04-app-code.mjs', start: 29.5, end: 33.5, stills: [32] },
  { id: 'scan', file: '05-scan.mjs', start: 33.5, end: 38.5, stills: [37.5] },
  { id: 'accounts', file: '06-accounts.mjs', start: 38.5, end: 48, stills: [43] },
  { id: 'control', file: '07-control.mjs', start: 48, end: 52, stills: [50.5] },
  { id: 'platforms', file: '08-platforms.mjs', start: 52, end: 57, stills: [54] },
  { id: 'trust', file: '09-trust.mjs', start: 57, end: 61, stills: [59] },
  // marks: when the spotlight moves to the edge, the sandbox and the trusted side
  {
    id: 'security',
    file: '10-security.mjs',
    start: 63.5,
    end: 89.5,
    stills: [72.5, 78.5, 85.5],
    marks: [6, 12.2, 19.4],
  },
  { id: 'network', file: '11-network.mjs', start: 87, end: 93.2, stills: [90] },
  { id: 'devices', file: '12-devices.mjs', start: 93.2, end: 96.2, stills: [95] },
  { id: 'end', file: '13-end.mjs', start: 96.2, end: 102.5, stills: [99] },
];
export const DURATION = SCENES[SCENES.length - 1].end;
