// The films' timelines. There are two cuts of the promo from the same scenes:
//
//   consumer   about 70 s, for people choosing a way to watch their desktop on a phone,
//              tablet or TV: what it feels like, how to start, one line on safety.
//   developer  about 100 s, for developers and power users: the comparison with
//              traditional VNC, sign-in, and the full security design.
//
// Each cut lists its scenes in order and how long each lasts. Start and end times follow
// from the lengths, so changing one scene moves everything after it. Times inside a scene
// (its storyboard stills, its marks, and the voiceover lines in voiceover.json) count from
// the scene's start. scenes/<id>.mjs draws each scene (opts tune it per cut),
// engine/film.mjs plays a cut as one film, promo.mjs takes the stills, and music.py places
// its cues on the same times. Pure data, so Node and the browser both read it.
const CUTS = {
  consumer: [
    { id: 'hook', length: 7, stills: [4] },
    { id: 'lag', length: 8.5, stills: [7], opts: { label: 'Typical remote desktop' } },
    { id: 'race', length: 11.8, stills: [7.8], opts: { label: 'Typical remote desktop' } },
    { id: 'number', length: 7, stills: [3.5] },
    { id: 'app-code', length: 4, stills: [2.5] },
    { id: 'scan', length: 5.5, stills: [4] },
    { id: 'screens', length: 6.5, stills: [4] },
    { id: 'touch', length: 7, stills: [4.5] },
    { id: 'safe', length: 6.5, stills: [4.5] },
    { id: 'end', length: 7, stills: [3], opts: { audience: 'consumer' } },
  ],
  developer: [
    { id: 'lag', length: 12.2, stills: [10.5], opts: { label: 'Traditional VNC' } },
    { id: 'race', length: 11.8, stills: [7.8] },
    { id: 'number', length: 7, stills: [3.5] },
    { id: 'app-code', length: 4, stills: [2.5] },
    { id: 'scan', length: 5, stills: [4] },
    { id: 'accounts', length: 9.5, stills: [4.5] },
    { id: 'control', length: 4, stills: [2.5] },
    { id: 'platforms', length: 5, stills: [2] },
    { id: 'trust', length: 4, stills: [2] },
    // marks: when the spotlight moves to the edge, the sandbox and the trusted side
    { id: 'security', length: 26, stills: [9, 15, 22], marks: [6, 12.2, 19.4] },
    { id: 'network', length: 6.4, stills: [3] },
    { id: 'devices', length: 3, stills: [1.8] },
    { id: 'end', length: 7, stills: [3], opts: { audience: 'developer' } },
  ],
};
export const CUT_NAMES = Object.keys(CUTS);

// One cut's scenes with their start and end times, its length, and placeLines, which gives
// each voiceover line (named by scene, timed from the scene's start) its time in the film.
export function cut(name) {
  if (!CUTS[name]) throw new Error(`unknown cut: ${name} (cuts: ${CUT_NAMES.join(', ')})`);
  let at = 0;
  const scenes = CUTS[name].map((s, i) => {
    const start = at;
    at = Math.round((at + s.length) * 1000) / 1000;
    return { file: `${s.id}.mjs`, opts: {}, ...s, n: i + 1, start, end: at };
  });
  const placeLines = (lines) =>
    lines.map((l) => {
      const s = scenes.find((x) => x.id === l.scene);
      if (!s) throw new Error(`a ${name} voiceover line names a scene not in the cut: ${l.scene}`);
      return { ...l, at: Math.round((s.start + l.at) * 1000) / 1000 };
    });
  return { name, scenes, duration: at, placeLines };
}
