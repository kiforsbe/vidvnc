# Promo video

Scripts that generate the VidVNC promo films from code: the voiceover, the music, every
shot, the mix and the captions. There are two cuts from the same scenes:

- **consumer**, about 55 s, for people at home: watching what's on your computer from the
  sofa, on a TV or phone, and taking control of it from there; how to connect, and one line
  on safety.
- **developer**, about 115 s, for developers and power users: productivity with a remote
  desktop that keeps up (the comparison with traditional VNC, the 63 ms figure, typing and
  scrolling), sign-in for registered devices, and the full security design.

| File                                       | What it does                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [promo.mjs](promo.mjs)                     | The build: installs the tools, then renders the drafts or the final film                                                                                                 |
| [timeline.mjs](timeline.mjs)               | Each cut's scenes in order, their lengths and per-cut options, and the moments taken as stills                                                                           |
| [scenes/](scenes)                          | One file per scene, each drawing its shot at any moment (HTML, CSS, SVG and canvas)                                                                                      |
| [engine/film.mjs](engine/film.mjs)         | The engine: plays one cut's scenes back to back as one film, over the backdrop                                                                                           |
| [engine/kit.mjs](engine/kit.mjs)           | What the scenes share: timing helpers, the shared desktop and its music player, the film, the devices and the shots                                                      |
| [engine/backdrop.mjs](engine/backdrop.mjs) | A WebGL (Three.js) light field behind the 2D shots that only adds depth and glow                                                                                         |
| [engine/film.html](engine/film.html)       | The page the film is recorded from, with the shared styles                                                                                                               |
| [voiceover.json](voiceover.json)           | Each cut's voiceover: each line, its scene, when it starts in it, and its caption if that differs                                                                        |
| [voiceover.py](voiceover.py)               | Speaks the voiceover with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) and writes the captions                                                                  |
| [music.py](music.py)                       | Synthesises the score, the song on the shared desktop (heard in the race only) and its spectrum for the desktop's visualiser, with numpy, so there is nothing to license |
| [voice-samples.py](voice-samples.py)       | Reads four sample lines in six candidate voices                                                                                                                          |

The scenes are only source: each cut is one continuous film with one soundtrack. To change
a cut's scenes, their order or their length, edit `timeline.mjs`; the stills, the music's
cues, the voiceover and the film follow it, because voiceover lines and stills are timed
from the start of their scene.

## Build it

Needs Node 20 or later, Python 3.10 or later and Chrome or Edge, on Windows, macOS or Linux.
From the repository root:

```sh
node tools/promo-video/promo.mjs setup    # once: playwright-core, ffmpeg-static, three, Kokoro and its model
node tools/promo-video/promo.mjs voices   # out/promo-video/voice-samples/
node tools/promo-video/promo.mjs draft    # out/promo-video/drafts/NN/, both cuts (1080p, 30 fps)
node tools/promo-video/promo.mjs final    # out/promo-video/final/NN/, both cuts (2K masters, 30 fps)
node tools/promo-video/promo.mjs web      # the web copies again, from the latest final
```

`draft consumer` or `final developer` builds only that cut. Each draft gets the next number
and never overwrites an earlier one. A draft folder holds one folder per cut:

```text
drafts/10/
  consumer/
    vidvnc-promo.mp4      the cut
    vidvnc-promo.en.srt   its captions
    storyboard/           one still per scene, numbered in the cut's order (`frame-03-race.png`),
                          contact-sheet.png with all of them, and index.html: each scene's
                          stills with the lines spoken over it
    audio/                voiceover.wav, music.wav and mix.wav
  developer/              the same for the developer cut
  build-info.txt          the commit, the command and when it was built
  commit.url              opens that commit on GitHub
```

A final in `final/NN/` holds, per cut, the 2K master `vidvnc-promo-2k.mp4` (2560 x 1440,
30 fps, near-lossless), its captions, and `web/` with what the website needs, in two sizes:
`vidvnc-promo-<cut>-1mb.av1.mp4` and `-1mb.hevc.mp4` (at most 1 MB per minute of film, 40
kbit/s Opus) and the same with `-2mb` (at most 2 MB per minute, 64 kbit/s Opus), all 1080p
and 10-bit (AV1 for most browsers, HEVC for Apple devices without an AV1 decoder), plus
`-poster.jpg` (the frame `poster` marks in `timeline.mjs`) and `.en.vtt` captions.
`promo.mjs web [NN]` makes them again from final NN's masters without rendering anything, and
keeps copies that are already up to date and within budget; copy them into
[site/media](../../site/media) to publish them. A final has the same two links as a draft. The
page is always laid out at 1920 x 1080; a final records it at 4/3 the pixel ratio, and the
canvases and the backdrop draw at that ratio, so nothing is upscaled. Drafts 01 to 09 came
before the two cuts and hold one film each. Any revision can be rebuilt by checking out its
commit, so commit and push script changes before rendering one for review; uncommitted changes
are noted in `build-info.txt` with a warning.
`setup` puts its tools in `.deps/promo-video/`
(`PROMO_CACHE` moves it); `PROMO_OUT` moves the output. `CHROMIUM=/path/to/chrome` picks a
browser, and `FFMPEG=/path/to/ffmpeg` a system ffmpeg instead of ffmpeg-static's. Render on
a machine with a real GPU: under software rendering (a cloud machine, for example) the WebGL
backdrop's glow comes out wrong.

## Where the pictures and words come from

- The app screens are the screenshots in [docs/images](../../docs/images/README.md), the icon is
  the Mac app's, and the type is the website's own fonts in [site/fonts](../../site/fonts)
  (SIL Open Font License). Nothing is copied: the build serves them from where they are.
- The voice is Kokoro's `af_heart` (Apache 2.0), run locally.
- The phones, the living room, the film playing on the screens, the code editor and the
  side-by-side with a traditional VNC client are animated illustrations, and the film says so on screen.
- Smart TVs are named as "compatible smart TVs": the viewer is a web page, so a TV whose
  browser runs it can show it, but no TV has been tested yet. The end card's requirements
  are the [README's](../../README.md). The one measured figure, about 63 ms glass to glass at 1080p60
  on a Mac, is from [MACOS-PROTOTYPE-GATES.md](../../docs/investigations/MACOS-PROTOTYPE-GATES.md).
- The security act follows the process split in
  [the architecture](../../docs/ARCHITECTURE.md#system-overview): the media relay, the
  sandboxed network process, the capture worker with no network access, and the pipes between
  them. Change it when that design changes.
