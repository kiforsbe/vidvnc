# Promo video

Scripts that generate the VidVNC promo film from code: the voiceover, the music, every
shot, the mix and the captions. Nothing is filmed or edited by hand, and no generated media is
kept in the repository; it all goes to `out/promo-video/` (ignored by git).

| File                                 | What it does                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [promo.mjs](promo.mjs)               | The build: installs the tools, then renders the drafts or the final film                                                                                                      |
| [scenes.html](scenes.html)           | Every shot, drawn as a web page at any moment `t` (HTML, CSS, SVG and canvas); `promo.mjs` records it                                                                         |
| [backdrop.mjs](backdrop.mjs)         | A WebGL (Three.js) light field behind the 2D shots that only adds depth and glow                                                                                              |
| [voiceover.json](voiceover.json)     | The voiceover: each line, when it starts, and its caption if that differs                                                                                                     |
| [voiceover.py](voiceover.py)         | Speaks the voiceover with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) and writes the captions                                                                       |
| [music.py](music.py)                 | Synthesises the score, the song playing on the shared desktop and its spectrum (`eq.json`, which drives the desktop's visualiser), with numpy, so there is nothing to license |
| [voice-samples.py](voice-samples.py) | Reads four sample lines in six candidate voices                                                                                                                               |

## Build it

Needs Node 20 or later, Python 3.10 or later and Chrome or Edge, on Windows, macOS or Linux.
From the repository root:

```sh
node tools/promo-video/promo.mjs setup    # once: playwright-core, ffmpeg-static, three, Kokoro and its model
node tools/promo-video/promo.mjs voices   # out/promo-video/voice-samples/
node tools/promo-video/promo.mjs draft    # out/promo-video/drafts/NN/ (30 fps)
node tools/promo-video/promo.mjs final    # out/promo-video/final/NN/ (60 fps)
```

Each draft gets the next number and never overwrites an earlier one. A draft folder holds:

```text
drafts/04/
  vidvnc-promo.mp4      the cut
  vidvnc-promo.en.srt   its captions
  storyboard/           one still per shot, and contact-sheet.png with all of them
  audio/                voiceover.wav, music.wav and mix.wav
  build-info.txt        the commit, the command and when it was built
  commit.url            opens that commit on GitHub
```

A final cut in `final/NN/` holds the film at 60 fps, its captions and the same two links. Any
revision can be rebuilt by checking out its commit, so commit and push script changes before
rendering one for review; uncommitted changes are noted in `build-info.txt` with a warning.
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
- The phones and the side-by-side with a traditional VNC client are animated illustrations, and
  the film says so on screen. The one measured figure, about 63 ms glass to glass at 1080p60
  on a Mac, is from [MACOS-PROTOTYPE-GATES.md](../../docs/investigations/MACOS-PROTOTYPE-GATES.md).
- The security act follows the process split in
  [the architecture](../../docs/ARCHITECTURE.md#system-overview): the media relay, the
  sandboxed network process, the capture worker with no network access, and the pipes between
  them. Change it when that design changes.
