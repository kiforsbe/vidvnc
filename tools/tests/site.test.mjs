import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The website (site/) is published as it is, so these check what a visitor would load.
const site = fileURLToPath(new URL('../../site/', import.meta.url));
const html = await readFile(path.join(site, 'index.html'), 'utf8');
const css = await readFile(path.join(site, 'styles.css'), 'utf8');

// Values of src, srcset and href on elements that load something, and url() in the styles.
const loaded = [
  ...[...html.matchAll(/<(?:script|link|img|source)\b[^>]*?\s(?:src|srcset|href)="([^"]*)"/g)].map(
    (match) => match[1],
  ),
  ...[...css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((match) => match[1]),
];

test('the website loads nothing from another site', () => {
  assert.ok(loaded.length > 10);
  for (const value of loaded)
    assert.doesNotMatch(value, /^(?:[a-z]+:)?\/\//i, `loads ${value} from another site`);
});

test('every file the website refers to is in site/', async () => {
  const local = [...html.matchAll(/\s(?:src|srcset|href)="([^"#:]+)"/g)].map((match) => match[1]);
  for (const file of new Set([...local, ...loaded])) await stat(path.join(site, file));
});

test('every image in site/images is used, in light and dark', async () => {
  for (const name of await readdir(path.join(site, 'images'))) {
    assert.ok(html.includes(`images/${name}`), `${name} is not used`);
    const pair = name.replace(/-(light|dark)\.png$/, (_, theme) =>
      theme === 'light' ? '-dark.png' : '-light.png',
    );
    if (pair !== name) assert.ok(html.includes(`images/${pair}`), `${name} has no ${pair}`);
  }
});
