import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The server sends `default-src 'self'; script-src 'self'; style-src 'self'` on every
// response, so anything inline is silently dropped by the browser: a page that "works" in a
// test but does nothing on a phone. These tests read the page and its script as files and
// hold them to that policy.
const source = (name) => new URL(`../src/${name}`, import.meta.url);
const read = (name) => readFileSync(source(name), 'utf8');

const html = read('trust.html');

test('the page loads the client shell, its own stylesheet and its own script', () => {
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  for (const expected of ['/theme.js', '/style.css', '/shell.css', '/trust.css', '/trust.js'])
    assert.ok(references.includes(expected), `${expected} is referenced`);
  assert.match(html, /<script type="module" src="\/trust\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/trust\.css" \/>/);
});

test('the page has no inline script, inline style or inline event handler for the CSP to drop', () => {
  assert.doesNotMatch(html, /<style\b/i, 'no <style> element');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no onclick-style handler');
  assert.doesNotMatch(html, /javascript:/i, 'no javascript: URL');
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(script[1], /\bsrc="/, 'every <script> has a src');
    assert.equal(script[2].trim(), '', 'no inline script body');
  }
});

test('every page reference is a same-origin absolute path, never a CDN or a relative guess', () => {
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  for (const reference of references) {
    if (reference.startsWith('#')) continue;
    assert.match(reference, /^\/[^/]/, reference);
  }
});

test('the page states what it needs in plain text when scripts cannot run', () => {
  assert.match(html, /<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1"/);
});

test('every module the page script imports exists, and the script builds the page with text, not markup', () => {
  const script = read('trust.js');
  const imports = [...script.matchAll(/from\s+'(\.\/[^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length >= 2, 'the renderer imports the pure modules');
  for (const specifier of imports) assert.ok(existsSync(source(specifier)), specifier);
  // Status text comes from an unauthenticated plaintext response.
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
  assert.doesNotMatch(script, /crypto\.subtle/, 'not a secure context on plaintext non-localhost');
  assert.doesNotMatch(
    script,
    /location\.(href|assign|replace)\s*=|location\.(assign|replace)\(/,
    'no scripted redirect',
  );
});

test('the stylesheet pulls in nothing from outside the origin', () => {
  const css = read('trust.css');
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /url\(\s*['"]?(?:https?:)?\/\//i);
});

test('theme.js does not throw on a page without an #appearance control', () => {
  const listeners = [];
  const dataset = {};
  const context = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      documentElement: { dataset },
      addEventListener: (type, listener) => listeners.push([type, listener]),
      getElementById: () => null,
    },
  };
  runInNewContext(read('theme.js'), context);
  for (const [type, listener] of listeners) if (type === 'DOMContentLoaded') listener();
  assert.equal(dataset.theme, 'system');
});

test('theme.js still wires the #appearance control where there is one', () => {
  const listeners = [];
  const dataset = {};
  const stored = {};
  const select = { value: '', addEventListener: (type, listener) => (select[type] = listener) };
  const context = {
    localStorage: {
      getItem: (key) => stored[key] ?? null,
      setItem: (key, value) => (stored[key] = value),
      removeItem: (key) => delete stored[key],
    },
    document: {
      documentElement: { dataset },
      addEventListener: (type, listener) => listeners.push([type, listener]),
      getElementById: (id) => (id === 'appearance' ? select : null),
    },
  };
  runInNewContext(read('theme.js'), context);
  for (const [type, listener] of listeners) if (type === 'DOMContentLoaded') listener();
  select.value = 'dark';
  select.change();
  assert.equal(dataset.theme, 'dark');
  assert.equal(stored['vidvnc-appearance'], 'dark');
});
