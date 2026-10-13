// The film's timeline: every scene in order and how long it lasts. Start and end times
// follow from the lengths, so changing one scene moves everything after it. Times inside a
// scene (its storyboard stills, its marks, and the voiceover lines in voiceover.json) count
// from the scene's start. scenes/<file> draws each scene, engine/film.mjs plays them as one
// film, promo.mjs takes the stills, and music.py places its cues on the same times. Pure
// data, so Node and the browser both read it.
const ORDER = [
  { id: 'lag', file: '01-lag.mjs', length: 12.2, stills: [10.5] },
  { id: 'race', file: '02-race.mjs', length: 11.8, stills: [7.8] },
  { id: 'number', file: '03-number.mjs', length: 5.5, stills: [3.5] },
  { id: 'app-code', file: '04-app-code.mjs', length: 4, stills: [2.5] },
  { id: 'scan', file: '05-scan.mjs', length: 5, stills: [4] },
  { id: 'accounts', file: '06-accounts.mjs', length: 9.5, stills: [4.5] },
  { id: 'control', file: '07-control.mjs', length: 4, stills: [2.5] },
  { id: 'platforms', file: '08-platforms.mjs', length: 5, stills: [2] },
  { id: 'trust', file: '09-trust.mjs', length: 4, stills: [2] },
  // marks: when the spotlight moves to the edge, the sandbox and the trusted side
  {
    id: 'security',
    file: '10-security.mjs',
    length: 26,
    stills: [9, 15, 22],
    marks: [6, 12.2, 19.4],
  },
  { id: 'network', file: '11-network.mjs', length: 6.2, stills: [3] },
  { id: 'devices', file: '12-devices.mjs', length: 3, stills: [1.8] },
  { id: 'end', file: '13-end.mjs', length: 6.3, stills: [2.8] },
];

let at = 0;
export const SCENES = ORDER.map((s) => {
  const start = at;
  at = Math.round((at + s.length) * 1000) / 1000;
  return { ...s, start, end: at };
});
export const DURATION = at;

// Voiceover lines name their scene and start that many seconds into it; this gives each
// line its time in the film.
export function placeLines(lines) {
  return lines.map((l) => {
    const s = SCENES.find((x) => x.id === l.scene);
    if (!s) throw new Error(`voiceover line names an unknown scene: ${l.scene}`);
    return { ...l, at: Math.round((s.start + l.at) * 1000) / 1000 };
  });
}
