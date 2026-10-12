// Assembles the project website (site/) into out/site/ for GitHub Pages, adding the screenshots
// from docs/images/ and the app icon so each image has one home in the repository. Uses only
// Node's own modules, so the Pages workflow needs no npm install.
import { cp, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Published name under images/ -> source in the repository.
export const SITE_IMAGES = {
  'icon.png': 'apps/macos-host/VidVNC/Assets.xcassets/AppIcon.appiconset/icon_256x256.png',
  'overview-light.png': 'docs/images/overview-light.png',
  'overview-dark.png': 'docs/images/overview-dark.png',
  'windows-overview-light.png': 'docs/images/windows-host/overview-light.png',
  'windows-overview-dark.png': 'docs/images/windows-host/overview-dark.png',
  'mac-overview-light.png': 'docs/images/macos-host/overview-light.png',
  'mac-overview-dark.png': 'docs/images/macos-host/overview-dark.png',
  'mac-connect-device-light.png': 'docs/images/macos-host/connect-device-qr-light.png',
  'mac-connect-device-dark.png': 'docs/images/macos-host/connect-device-qr-dark.png',
};

// Files under site/ that document the folder rather than belong on the website.
const notPublished = new Set(['README.md']);

// Every local file a page refers to with src, srcset or href.
export function localReferences(html) {
  const found = new Set();
  for (const [, value] of html.matchAll(/\s(?:src|srcset|href)="([^"]*)"/g)) {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(value) || value === '') continue;
    found.add(value.split(/[?#]/)[0]);
  }
  return [...found].sort();
}

export async function buildSite(output = path.join(root, 'out', 'site')) {
  await rm(output, { recursive: true, force: true });
  await cp(path.join(root, 'site'), output, {
    recursive: true,
    filter: (source) => !notPublished.has(path.basename(source)),
  });
  await mkdir(path.join(output, 'images'), { recursive: true });
  for (const [name, source] of Object.entries(SITE_IMAGES))
    await copyFile(path.join(root, source), path.join(output, 'images', name));

  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  const css = await readFile(path.join(output, 'styles.css'), 'utf8');
  const fonts = [...css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((match) => match[1]);
  const missing = [];
  for (const reference of [...localReferences(html), ...fonts]) {
    try {
      await stat(path.join(output, reference));
    } catch {
      missing.push(reference);
    }
  }
  if (missing.length) throw new Error(`The website refers to missing files: ${missing.join(', ')}`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const output = await buildSite(process.argv[2] && path.resolve(process.argv[2]));
    console.log(`Website built in ${path.relative(process.cwd(), output) || '.'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
