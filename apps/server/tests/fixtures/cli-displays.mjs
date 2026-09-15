import { DisplayInventory } from '../../src/displays.mjs';

export const MAIN = 'a'.repeat(64);
export const SIDE = 'b'.repeat(64);
export const PROJECTOR = 'c'.repeat(64);

export function rawDisplays() {
  return [
    {
      id: MAIN,
      name: 'Main',
      primary: true,
      persistent: true,
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
      rotation: 0,
    },
    {
      id: SIDE,
      name: 'Side',
      primary: false,
      persistent: true,
      x: 2560,
      y: 0,
      width: 1920,
      height: 1080,
      rotation: 0,
    },
    {
      id: PROJECTOR,
      name: 'Projector\u001b[31m',
      primary: false,
      persistent: false,
      x: 4480,
      y: 0,
      width: 1920,
      height: 1080,
      rotation: 0,
    },
  ];
}

export const displayInventory = () => new DisplayInventory(rawDisplays());
export const displayRows = () => displayInventory().rows;
