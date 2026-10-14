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

A game sees an Xbox controller only through a driver, or a device, that presents one.
XInput, which most PC games use, sees only Xbox-class controllers: an Xbox 360 controller
on USB (Windows' in-box `xusb22` driver), an Xbox One controller (GIP), or a HID gamepad
whose hardware ID carries `IG_` (Windows' in-box `xinputhid` driver). Every option below
was surveyed from its documentation in October 2026; **none has been tested yet**. Where
a claim comes only from the project itself, it says so.

### Most promising

1. **VIIPER with usbip-win2.** [VIIPER](https://github.com/Alia5/VIIPER) emulates USB
   devices in user space and hands them to Windows over USB/IP through
   [usbip-win2](https://github.com/vadimgrn/usbip-win2), so Windows sees a real **USB Xbox
   360 controller** and binds its own `xusb22` driver. That is the most widely supported
   controller kind, and VidVNC would ship no driver code of its own. It also emulates
   DualShock 4, DualSense, keyboards and mice.
   - _Risks:_
     - usbip-win2 is a kernel driver, so a bug in it can crash or compromise Windows.
       VIIPER calls it signed; which fork and release carry a production signature is not
       yet confirmed. Some forks still require test-signing mode.
     - VIIPER's TCP API documents no authentication. Any local process, or any remote one
       if it listened beyond loopback, could create input devices. It would have to be
       bound to loopback and owned by VidVNC, or embedded.
     - The server is GPL-3.0 (its client libraries are MIT). VidVNC could only talk to it as
       a separate process, not link it.
     - usbip-win2 is a general USB/IP client: installing it also lets a USB/IP server attach
       arbitrary USB devices, which widens what the PC accepts.
2. **A hardware controller dongle.** A Raspberry Pi Pico (about $5) running open firmware
   such as GP2040-CE presents itself as a USB Xbox 360 controller. The worker would send it
   the pad state over its serial port. To Windows and to games it is a real controller.
   - _Risks:_ few. No driver, signing or certificate is needed, and anti-cheat sees genuine
     hardware. The firmware must be one we trust and pin. Each user needs the device
     plugged in, and its serial port must be one VidVNC alone opens.

### Possible, with caveats

3. **WinUHid.** [WinUHid](https://github.com/cgutman/WinUHid), by Moonlight's developer and
   proposed for Sunshine, is a user-mode (UMDF 2) driver built on Microsoft's Virtual HID
   Framework. It emulates DualShock 4, DualSense and an Xbox One controller whose hardware
   ID (`HID\VID_045E&PID_02FF&IG_00`) should make `xinputhid` bind, so XInput should see
   it. MIT licence. Its installer's `RootDevCA` is a custom action that creates the root
   device, not a certificate authority.
   - _Risks:_
     - No releases and no signed build. We would sign it ourselves: an EV code-signing
       certificate and Microsoft attestation signing through Partner Center.
     - Who may create devices through it is not yet reviewed; if any local process can,
       that is a new input-injection path.
     - Last commit May 2025; we may end up maintaining a fork.
4. **Our own VHF driver.** The same design as WinUHid, written by us. It gains nothing over
   WinUHid and adds the cost of writing, signing and maintaining a driver.
5. **libvirtualhid.** LizardByte's
   [libvirtualhid](https://docs.lizardbyte.dev/projects/libvirtualhid/latest/md_docs_2windows-driver.html)
   is a UMDF/VHF driver with Xbox One/Series (XInput), DualShock 4, DualSense and Switch Pro
   profiles, but no Xbox 360. Its security design is the best seen: only its broker service
   may create devices, and the broker refuses remote clients.
   - _Risks:_ source-available (LB-SAL 1.0), not open source, and device creation needs a
     paid licence per machine. Release signing is still pending.

### Ruled out

- **HIDMaestro.** [HIDMaestro](https://github.com/hifihedgehog/HIDMaestro) (MIT, active) says
  XInput, DirectInput, the browser Gamepad API and Windows.Gaming.Input all see its
  controllers. It avoids driver signing by creating a self-signed certificate and adding it
  to the machine's **Root** and **TrustedPublisher** stores. The PC then trusts anything
  that certificate's key signs: drivers, programs, even TLS certificates. Whoever obtains
  the key can do that too. Its documentation does not say what happens to the key. That
  undoes driver signing for the whole machine and conflicts with VidVNC's security
  position.
- **ViGEmBus.** [ViGEmBus](https://github.com/nefarius/ViGEmBus) presents an Xbox 360 or
  DualShock 4 controller, and Sunshine and Apollo still use it. It is an unmaintained
  kernel driver, archived in November 2023. Its announced successor, VirtualPad, has not
  been released.
- **vJoy.** A kernel driver that DirectInput sees but XInput does not.
- **x360ce and similar.** They place an `xinput` DLL in each game's folder, which
  anti-cheat treats as tampering.
- **Sunshine's paid Virtual HID Driver, and Parsec's and Steam's drivers.** Commercial or
  proprietary, and not reusable.
- **`InputInjector`.** This branch's approach; see above.

### Next step

Probe VIIPER with usbip-win2 first, then the dongle. Before any probe, confirm which
usbip-win2 release carries a production signature and read VIIPER's API documentation.
The owner installs any driver. Then, as with `tests/pad-probe.cpp`, plug in the controller
and check that XInput, joy.cpl and a gamepad test page on the PC see its buttons move, each
run capped at 30 seconds. Only then write VidVNC code: only
`platform/windows/input.cpp`'s injection would change.

References: [ViGEmBus (archived)](https://github.com/nefarius/ViGEmBus),
[Sunshine: transition away from ViGEmBus](https://github.com/LizardByte/Sunshine/issues/3527),
[LizardByte roadmap: replace ViGEmBus](https://github.com/LizardByte/roadmap/issues/10),
[OpenController: VIIPER as a ViGEmBus alternative](https://github.com/Brunovncs/OpenController/issues/1),
[usbip-win2 (Alia5 fork)](https://github.com/Alia5/usbip-win2),
[VhfCreate](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/vhf/nf-vhf-vhfcreate),
[attestation signing](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-attestation),
[InputInjector.InjectGamepadInput](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector.injectgamepadinput).
