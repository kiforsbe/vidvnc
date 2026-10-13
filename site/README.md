# Website

The project's website, published with GitHub Pages at <https://kiforsbe.github.io/vidvnc/>.
It is one static page: plain HTML, CSS and a small script, published as it is, with no build
step.

| File                     | What it holds                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| [index.html](index.html) | The page                                                                                       |
| [styles.css](styles.css) | Layout and the light and dark colour tokens                                                    |
| [theme.js](theme.js)     | The System / Light / Dark switch; a choice is kept in the browser's local storage              |
| [film.js](film.js)       | Opens the promo films in a player dialog                                                       |
| [media/](media/)         | The promo films' web copies, posters and captions                                              |
| [images/](images/)       | The hero image, copies of the app screenshots, and the app icon                                |
| [fonts/](fonts/)         | Instrument Sans and JetBrains Mono, Latin subset (from Fontsource 5.3.0), with their OFL texts |

The page loads nothing from other sites: no web fonts service, analytics or scripts.

## Images

Every picture comes in a light and a dark version. Each is a `<picture>` with the light image
and a dark `<source>` marked `data-dark`; `theme.js` points that source at the visitor's choice.

- `hero-light.png`, `hero-dark.png`: the Windows and Mac Overview pages, overlapping, with
  shadows on a transparent background. [tools/site-hero.py](../tools/site-hero.py) draws them
  from the screenshots in [docs/images/](../docs/images/README.md)
  (`python3 tools/site-hero.py`, which needs Pillow). The page lets the image hang into the
  margins so the windows line up with the text.
- `windows-overview-*`, `mac-overview-*`, `mac-connect-device-*`: copies of
  `windows-host/overview-*`, `macos-host/overview-*` and `macos-host/connect-device-qr-*` from
  `docs/images/`.
- `icon.png`: the Mac app icon at 256 px, from
  `apps/macos-host/VidVNC/Assets.xcassets/AppIcon.appiconset/icon_256x256.png`.

After regenerating the screenshots, copy the new ones over and run `site-hero.py` again.

## Films

The two promo films play from the page itself. A **Watch the film** button in the hero opens
the consumer cut, and a link under the features heading opens the developer cut. Each opens a
`<dialog>` with a `<video>` that has `preload="none"` and no poster until it opens, so the page
downloads nothing for the films until someone clicks.

`media/` holds, for each cut (`consumer`, `developer`):

- `vidvnc-promo-<cut>.av1.mp4`: 10-bit AV1 at 1080p with Opus sound, which browsers try first.
- `vidvnc-promo-<cut>.hevc.mp4`: 10-bit HEVC (`hvc1`) with Opus, for browsers without AV1
  (older Safari).
- `vidvnc-promo-<cut>-poster.jpg`: the still shown before it plays.
- `vidvnc-promo-<cut>.en.vtt`: English captions.

Each copy is at most 2 MB per minute of film. They are the only generated media
committed to the repository, kept small so the site stays well inside GitHub Pages' limits.
`node tools/promo-video/promo.mjs web <draft>` makes them from a 2K master (see
[tools/promo-video/README.md](../tools/promo-video/README.md)); copy the files from
`out/promo-video/final/<draft>/<cut>/web/` into `media/`.

Behind the hero, the page draws a soft blue and violet glow and a fading dot grid in CSS, in
the theme's colours.

## Preview it

```sh
python3 -m http.server -d site
```

Then open <http://localhost:8000/>. Opening `index.html` straight from disk works too, but
the browser then blocks the fonts.

## Publish it

[.github/workflows/pages.yml](../.github/workflows/pages.yml) (the **Website** workflow)
publishes this folder when it changes on `main`, and can be run by hand from the Actions tab.
The repository's **Settings > Pages > Source** must be set to **GitHub Actions** once.

The portable tests check the page ([tools/tests/site.test.mjs](../tools/tests/site.test.mjs)):
every file it refers to exists, it loads nothing from another site, and every image is used
in both light and dark.
