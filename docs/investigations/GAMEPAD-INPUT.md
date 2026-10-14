# Gamepad input

## Current state (2026-10-14): failed test, not merged

The `feature/gamepad-input` branch passes a viewer's gamepads to a Windows host, but only as
far as VidVNC itself. The gamepad's buttons, sticks and triggers travel from the browser to
the media worker, the worker plugs in a virtual controller, and the VidVNC app draws the
controller's live state. No game or other program on the PC sees that controller, so the
feature does nothing useful. The branch is kept as a record and is not to be merged as it
stands.

- **Works, end to end:** a DualShock 4 on a Samsung TV's browser, over HTTPS, with Access →
  Gamepads on and the TV in control. The viewer's toolbar icon lights while gamepad input is
  sent, the worker logs `PAD plugged index=0`, Windows lists the "Xbox Virtual Game
  Controller" as present, and the Sessions page shows the held buttons and stick positions.
- **Does not work:** the controller is invisible outside VidVNC. With it plugged in and
  buttons held, XInput reported nothing in any slot, Windows.Gaming.Input reported no
  gamepads and no raw controllers (`pad-probe observe`), and Game Controllers (joy.cpl) did
  not list it. The DS4's touchpad moving the pointer is the TV browser's own mouse
  emulation, sent as ordinary mouse input, not gamepad input.
- **Why:** the branch creates the controller with `InputInjector` (WinRT
  `Windows.UI.Input.Preview.Injection`). Its virtual gamepad is an in-box software device
  that desktop games' controller APIs do not report. Nothing in Microsoft's documentation
  says otherwise; the API is aimed at UWP input injection. The first probe, before any
  VidVNC code, already showed no XInput or Windows.Gaming.Input pad. That result should
  have stopped the work and was instead recorded as "not yet validated".

## What the branch contains

| Commit    | Change                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `24b3a11` | Access → Gamepads (off by default), viewer polling, `pad` messages, worker validation and `InputInjector`            |
| `1747f0d` | `PAD` log lines, the worker's `pads` report, `gamepads` in host status, the app's drawing, the viewer's toolbar icon |
| `858a9b3` | Host build warning fix                                                                                               |
| `021f2fc` | Worker exit codes in the server log, and gamepad changes sent to the app within 100 ms                               |
| `f7aadf9` | `CRASH` lines in `native-worker.log`, and an idle keepalive (later removed)                                          |
| `166b59e` | Every WinRT call moved to a thread of its own, fixing the worker crash                                               |

How it works is described in
[ARCHITECTURE.md → Gamepads](../ARCHITECTURE.md#gamepads) on the branch. Everything up to
the worker is independent of how the controller is created: the owner setting, leases that
carry `gamepads`, the viewer's polling and messages, the worker's validation and limits,
the status report and the app's drawing. Only `platform/windows/input.cpp`'s injection
would change with another driver.

## Found along the way

- **Worker crash, fixed on the branch.** The video worker died about 30 s after a pad was
  plugged in (exit code `0xC0000005`), ending the stream while the viewer stayed signed in.
  The new `CRASH` line placed it in C++/WinRT's cached activation factory, constructing an
  `InjectedInputGamepadInfo` on the GLib main thread. Other code in the process starts and
  ends that thread's COM apartment, which leaves the cached factory pointing at freed
  memory. `166b59e` makes every WinRT call on one thread that joins the multithreaded
  apartment for the worker's life. Any future WinRT use in the worker needs the same care.
- **Crash diagnostics.** Before `021f2fc` and `f7aadf9`, a crashed worker left only "Worker
  exited unexpectedly" with no code, no stderr and no Windows Error Reporting event. The
  exit code in the server log and the `CRASH` line (module+offset and call frames) are
  worth keeping whatever happens to gamepads.
- **The device's life.** The first injection installs
  `SWD\XBOXGIPSYNTHETIC\XBOXGIPSYNTHETIC_000`. It stays present while the process that
  used it runs, even after `UninitializeGamepadInjection`, and Windows removes it some time
  after that process exits. Removing it outright needs an administrator.
- **Sandbox.** Under the relay's sandbox launcher, `InputInjector::TryCreate` throws, so
  the low-integrity processes cannot inject. media-net's own launch path was not tested.
- **Anti-cheat.** No vendor statement about virtual controllers was found. The setting is
  off by default for that reason.

## Options for a working version

A game sees an Xbox controller only through a driver that presents one. As of October
2026:

1. **ViGEmBus.** Presents a real Xbox 360 (XUSB) or DualShock 4 controller, so XInput games
   see it. It is what the free game-streaming hosts, Sunshine and Apollo, still use. It was
   archived in November 2023 and gets no fixes; asking users to install an unmaintained
   kernel driver conflicts with VidVNC's security position.
2. **A Virtual HID Framework (VHF) driver,** such as WinUHid, proposed for Sunshine, or our
   own. Maintained and modern, but it needs a signed driver, and the HID gamepads it creates
   (a virtual DualSense, say) are not seen by XInput-only games.
3. **Sunshine's paid Virtual HID Driver.** A commercial licence; not considered further.
4. **Park it** until an open-source driver that XInput sees exists. This is the current
   decision.

Before writing VidVNC code for any driver, prove it first with a small probe like
`tests/pad-probe.cpp`: plug in the driver's controller and confirm that joy.cpl and a
gamepad test page on the PC see its buttons move.

References: [ViGEmBus (archived)](https://github.com/nefarius/ViGEmBus),
[Sunshine: transition away from ViGEmBus](https://github.com/LizardByte/Sunshine/issues/3527),
[LizardByte roadmap: replace ViGEmBus](https://github.com/LizardByte/roadmap/issues/10),
[Sunshine: getting started](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2getting__started.html),
[InputInjector.InjectGamepadInput](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.injectgamepadinput).
