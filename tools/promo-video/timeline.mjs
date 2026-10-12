// The film's timeline: every scene in order, the seconds it starts and ends, and the moments
// the storyboard stills are taken. scenes/<file> draws each one, engine/film.mjs plays them
// as one film, promo.mjs takes the stills, and music.py places its cues on the same times.
// Pure data, so Node and the browser both read it.
export const SCENES = [
  { id: 'lag', file: '01-lag.mjs', start: 0, end: 12.2, stills: [10.5] },
  { id: 'race', file: '02-race.mjs', start: 12.2, end: 24, stills: [20] },
  { id: 'number', file: '03-number.mjs', start: 24, end: 32, stills: [29.5] },
  { id: 'app-code', file: '04-app-code.mjs', start: 32, end: 36, stills: [34.5] },
  { id: 'scan', file: '05-scan.mjs', start: 36, end: 41, stills: [40] },
  { id: 'accounts', file: '06-accounts.mjs', start: 41, end: 50.5, stills: [45.5] },
  { id: 'control', file: '07-control.mjs', start: 50.5, end: 54.5, stills: [53] },
  { id: 'platforms', file: '08-platforms.mjs', start: 54.5, end: 59.5, stills: [56.5] },
  { id: 'trust', file: '09-trust.mjs', start: 59.5, end: 63.5, stills: [61.5] },
  // marks: when the spotlight moves to the edge, the sandbox and the trusted side
  {
    id: 'security',
    file: '10-security.mjs',
    start: 63.5,
    end: 89.5,
    stills: [72.5, 78.5, 85.5],
    marks: [6, 12.2, 19.4],
  },
  { id: 'network', file: '11-network.mjs', start: 89.5, end: 95.7, stills: [92.5] },
  { id: 'devices', file: '12-devices.mjs', start: 95.7, end: 98.7, stills: [97.5] },
  { id: 'end', file: '13-end.mjs', start: 98.7, end: 105, stills: [101.5] },
];
export const DURATION = SCENES[SCENES.length - 1].end;
