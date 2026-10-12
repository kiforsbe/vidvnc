# macOS clean-Mac acceptance (phase 7)

The hands-on acceptance of the Mac packages from phase 7 of the
[macOS plan](../superpowers/plans/2026-10-09-macos-support.md#phase-7-acceptance-and-documentation).
It installs the notarized packages on a Mac with no developer tools, as a user would, and
checks what the package checks in [packaging/macos](../../packaging/macos/README.md) cannot:
onboarding, viewing from a browser and an iPhone, control, audio, displays and removal.
Results go in [Results](#results) below, one dated entry per run.

## What you need

- **The packages under test,** built from the commit being accepted with
  `npm run package:macos` ([Mac packages](../../README.md#mac-packages)), notarized: the DMG
  from `out/installers/macos-server/<version>/` and the ZIP from
  `out/installers/macos-cli/<version>/`. Run
  `node packaging/macos/tests/package-check.mjs macos-server` and `… macos-cli` on them
  first; acceptance starts only from packages that pass.
- **A clean Mac:** a fresh clone of the MG8 virtual machine (macOS 27, no Xcode, no command
  line tools, no Homebrew, no GStreamer, no Node.js), never the original, so every run
  starts clean. Its network must be bridged to the LAN for the iPhone steps; with NAT only
  the browser inside the VM can connect.
- **Downloading, not copying.** Get the packages into the VM by downloading them in Safari
  (for example from `python3 -m http.server` in the installers folder on the build Mac), so
  they carry the quarantine flag and Gatekeeper checks them as it would a real download.
- **For the steps a VM can't do:** a second display and display hotplug need a real Mac
  with an external display; system audio needs a Mac with an output device. Run those
  steps on the owner's Mac with the same packages, after removing any development build
  (`out/macos-host`) from the Dock and login items so the installed app is the one used.
- A browser on another device (Safari or Chrome) and an iPhone on the same network.

## Steps

Record each step as pass, fail (with what happened) or not run (with why).

### App

1. **Install.** Open the DMG and drag **VidVNC** to Applications. Gatekeeper opens it with
   the "downloaded from the internet" question and no warning about an unidentified
   developer. The app opens with no permission prompt.
2. **Onboarding.** Turn sharing on. The introduction appears first, then macOS asks for
   Screen & System Audio Recording and Local Network, naming VidVNC. After allowing them,
   the app asks to confirm the network; allow it. Overview shows sharing on and the
   viewer address.
3. **Permissions page.** Each permission shows its real state, and each button opens the
   right pane in System Settings. Turning Screen Recording off there shows in the app
   within a few seconds.
4. **Browser.** From the other device, open the viewer address, accept the certificate,
   sign in, and watch display 1 at the default profile. The picture is live, the pointer
   follows, and switching profiles works.
5. **iPhone.** The same from Safari on the iPhone, with the
   [iPhone notes](../../README.md#viewing-on-an-iphone): picture, touch, switching profiles.
6. **Control.** Give a viewer control. The app explains, then macOS asks for Device Control
   & Data Access. Before it is allowed the viewer is told input is unavailable; after,
   mouse, keyboard and scrolling work, and taking control back stops them.
7. **Audio.** Pick a stream with sound. macOS asks for System Audio Recording; after
   allowing it, a video playing on the Mac is heard on the viewer in sync and without
   crackle.
8. **Two displays** (real Mac). Both appear in Displays with Identify overlays, and a
   viewer can watch each one and both together.
9. **Hotplug** (real Mac). Unplug the second display while it is being watched: its stream
   ends and the other keeps going. Plug it back: it reappears in
   Displays and can be watched again.
10. **Restart.** Quit VidVNC from the menu bar and open it again. Sharing starts on its own
    with no new prompts, and the confirmed network is not asked again. Run
    `ps ax | grep -i vidvnc` after quitting: nothing is left running.

### Command line

11. **Bundled command.** Choose **VidVNC > Install Command-Line Tool…**, confirm, and enter
    an administrator's password if asked. With the app's sharing off, `vidvnc` in Terminal
    starts the server with the app's settings (the same profiles and access settings); a
    browser can view. macOS asks Terminal, not VidVNC, for Screen Recording.
12. **Standalone server.** Quit the app. Unzip the CLI ZIP in Downloads and run `./vidvnc`.
    The first run checks notarization online and starts without a Gatekeeper warning. It
    uses the same settings as the app (`~/Library/Application Support/VidVNC`), and a
    browser can view. Repeat once with the network off after the first run: it still
    starts.
13. **Shared settings.** With the server stopped, run `./vidvnc config max-devices 2`, then
    open the app: Access shows a limit of two devices. Set it back the same way.

### Removal

14. **Uninstall.** Choose **Remove** next to **Command-line tool** in Settings, General
    (`/usr/local/bin/vidvnc` is gone), then quit VidVNC and move it to the Bin. Nothing VidVNC
    is left running, there is no login item in System Settings > General > Login Items,
    and `~/Library/Application Support/VidVNC` remains with the settings and logs, as the
    README says.

## Results

No run recorded yet.
