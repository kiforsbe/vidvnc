# Promo video

Scripts that generate the VidVNC promo film from code: the voiceover, the music, every
shot, the mix and the captions. Nothing is filmed or edited by hand, and no generated media is
kept in the repository; it all goes to `out/promo-video/` (ignored by git).

| File                                 | What it does                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [promo.mjs](promo.mjs)               | The build: installs the tools, then renders the drafts or the final film                                |
| [scenes.html](scenes.html)           | Every shot, drawn as a web page at any moment `t` (HTML, CSS and SVG); `promo.mjs` records it           |
| [backdrop.mjs](backdrop.mjs)         | A WebGL (Three.js) light field behind the 2D shots that only adds depth and glow                        |
| [voiceover.json](voiceover.json)     | The voiceover: each line, when it starts, and its caption if that differs                               |
| [voiceover.py](voiceover.py)         | Speaks the voiceover with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) and writes the captions |
| [music.py](music.py)                 | Synthesises the score and sound effects with numpy, so there is nothing to license                      |
| [voice-samples.py](voice-samples.py) | Reads four sample lines in six candidate voices                                                         |

## Build it

Needs Node 20 or later, Python 3.10 or later and Chrome or Edge, on Windows, macOS or Linux.
From the repository root:

```sh
node tools/promo-video/promo.mjs setup    # once: playwright-core, ffmpeg-static, three, Kokoro and its model
node tools/promo-video/promo.mjs voices   # out/promo-video/drafts/NN-voice-samples/
node tools/promo-video/promo.mjs frames   # out/promo-video/drafts/NN-style-frames/
node tools/promo-video/promo.mjs rough    # out/promo-video/drafts/NN-rough-cut/ (30 fps)
node tools/promo-video/promo.mjs final    # out/promo-video/final/NN-final-cut/ (60 fps)
```

Each run writes to the next numbered folder, such as `drafts/05-rough-cut/` or
`final/01-final-cut/`, and never overwrites an earlier one. In it, `commit.url` opens the commit
that built it on GitHub and `build-info.txt` names it, so any revision can be rebuilt by
checking out that commit. Commit and push script changes before rendering a draft for review:
uncommitted changes are noted in `build-info.txt` with a warning. Each film comes with an `.en.srt` caption file. `setup` puts its tools in `.deps/promo-video/`
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
