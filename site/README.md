# Website

The project's website, published with GitHub Pages at <https://kiforsbe.github.io/vidvnc/>.
It is one static page: plain HTML, CSS and a small script, with no framework or build step
of its own.

| File                     | What it holds                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| [index.html](index.html) | The page                                                                                       |
| [styles.css](styles.css) | Layout and the light and dark colour tokens                                                    |
| [theme.js](theme.js)     | The System / Light / Dark switch; a choice is kept in the browser's local storage              |
| [fonts/](fonts/)         | Instrument Sans and JetBrains Mono, Latin subset (from Fontsource 5.3.0), with their OFL texts |

The page loads nothing from other sites: no web fonts service, analytics or scripts.

## Screenshots

The screenshots aren't kept here. [tools/build-site.mjs](../tools/build-site.mjs) copies them
from [docs/images/](../docs/images/README.md), with the app icon, into `images/` when it builds
the site, so regenerating the screenshots updates the website too. `SITE_IMAGES` in that file
lists which ones. Each is a `<picture>` with a light image and a dark `<source>` marked
`data-dark`; `theme.js` points that source at the visitor's choice.

## Preview it

```sh
npm run site
python3 -m http.server -d out/site
```

`npm run site` builds the site into `out/site/` and stops if the page refers to a file that
isn't there. Open <http://localhost:8000/>. Opening `index.html` straight from disk works
too, but the browser then blocks the fonts.

## Publish it

[.github/workflows/pages.yml](../.github/workflows/pages.yml) (the **Website** workflow) builds
and publishes the site when `site/`, a screenshot or the build script changes on `main`, and
can be run by hand from the Actions tab. The repository's **Settings > Pages > Source** must
be set to **GitHub Actions** once.

The portable tests check the build ([tools/tests/build-site.test.mjs](../tools/tests/build-site.test.mjs)):
every file the page refers to exists, and it loads nothing from another site.
