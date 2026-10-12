import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SITE_IMAGES, buildSite, localReferences } from '../build-site.mjs';

test('localReferences lists only files on the site itself', () => {
  const html = `<link href="styles.css" /><a href="#top"></a><a href="https://example.com/x">
    <img src="images/a.png?v=1" /><source srcset="images/b.png" /><a href="mailto:x@y"></a>`;
  assert.deepEqual(localReferences(html), ['images/a.png', 'images/b.png', 'styles.css']);
});

test('the built website has every file its page refers to and nothing from elsewhere', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vidvnc-site-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await buildSite(path.join(directory, 'site'));

  const images = (await readdir(path.join(output, 'images'))).sort();
  assert.deepEqual(images, Object.keys(SITE_IMAGES).sort());
  assert.ok(!(await readdir(output)).includes('README.md'));

  // The page loads nothing from another site: fonts, scripts and images are all its own.
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  for (const [, value] of html.matchAll(
    /<(?:script|link|img|source)\b[^>]*\s(?:src|srcset|href)="([^"]*)"/g,
  ))
    assert.doesNotMatch(value, /^(?:[a-z]+:)?\/\//i, `loads ${value} from another site`);
  const css = await readFile(path.join(output, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /url\(\s*['"]?(?:[a-z]+:)?\/\//i);
});
