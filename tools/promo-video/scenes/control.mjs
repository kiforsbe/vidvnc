import { shotScene } from '../engine/kit.mjs';

// Scene: keyboard and mouse only when you allow it.

export const { build, update } = shotScene(
  'mac/access-dark.png',
  [460, 330, 1760, 403],
  'Keyboard and mouse, only when you allow it.',
);
