// The viewer's gamepads, read from the browser's Gamepad API and sent to the host as `pad`
// messages: each pad's whole state in the API's "standard" layout. The host's worker checks
// every value again (input-policy.hpp) and turns it into a virtual Xbox controller.
export const MAX_PADS = 4;
// At most this often, however fast the display refreshes: four pads at 60 a second stay well
// inside the worker's 1000 input messages a second, next to pointer moves.
export const POLL_INTERVAL_MS = 16;
// Standard buttons 6 and 7 are the triggers, sent as `lt` and `rt`; 16 (home) is not sent.
const DIGITAL_BUTTONS = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15];

const round = (value) => Math.round(value * 1000) / 1000 || 0;
const clamp = (value, low, high) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : 0;

// The `pad` message for one browser gamepad, or null when it cannot be sent: disconnected, not
// in the standard layout (its buttons could mean anything), or beyond the first four.
export function padMessage(gamepad) {
  if (!gamepad?.connected || gamepad.mapping !== 'standard') return null;
  if (!Number.isInteger(gamepad.index) || gamepad.index < 0 || gamepad.index >= MAX_PADS)
    return null;
  let buttons = 0;
  for (const index of DIGITAL_BUTTONS) if (gamepad.buttons[index]?.pressed) buttons |= 1 << index;
  const axis = (index) => round(clamp(gamepad.axes[index], -1, 1));
  const trigger = (index) => round(clamp(gamepad.buttons[index]?.value, 0, 1));
  return {
    type: 'pad',
    index: gamepad.index,
    buttons,
    lx: axis(0),
    ly: axis(1),
    rx: axis(2),
    ry: axis(3),
    lt: trigger(6),
    rt: trigger(7),
  };
}

const FIELDS = ['buttons', 'lx', 'ly', 'rx', 'ry', 'lt', 'rt'];
const same = (a, b) => FIELDS.every((field) => a[field] === b[field]);

// Sends what changed since the last poll: a pad's new state, or `pad-remove` for one that went
// away. `reset` forgets everything sent, for when control ends (the host unplugs its pads then).
export class PadSender {
  #sent = new Map();
  #send;
  constructor(send) {
    this.#send = send;
  }
  get active() {
    return this.#sent.size > 0;
  }
  poll(gamepads) {
    for (let index = 0; index < MAX_PADS; index++) {
      const gamepad = gamepads?.[index];
      const message = gamepad?.index === index ? padMessage(gamepad) : null;
      const previous = this.#sent.get(index);
      if (message) {
        if (!previous || !same(previous, message)) {
          if (this.#send(message) === false) return;
          this.#sent.set(index, message);
        }
      } else if (previous) {
        if (this.#send({ type: 'pad-remove', index }) === false) return;
        this.#sent.delete(index);
      }
    }
  }
  reset() {
    this.#sent.clear();
  }
}
