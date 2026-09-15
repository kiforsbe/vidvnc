import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { fillManifest, msixVersion, placeholderLogo } from '../windows/msix.mjs';

test('fills manifest placeholders with escaped values and rejects gaps', () => {
  assert.equal(
    fillManifest('<a n="{{name}}">{{text}}</a>', { name: 'CN=A & "B"', text: "<it's>" }),
    '<a n="CN=A &amp; &quot;B&quot;">&lt;it&apos;s&gt;</a>',
  );
  assert.throws(() => fillManifest('{{name}}', {}), /name is missing/);
  assert.throws(() => fillManifest('{{name}}', { name: '' }), /name is missing/);
  assert.throws(() => fillManifest('{{name}}', { name: 'a', extra: 'b' }), /no extra/);
});

test('converts release versions to four-part MSIX versions only', () => {
  assert.equal(msixVersion('0.1.0'), '0.1.0.0');
  assert.equal(msixVersion('65535.2.3'), '65535.2.3.0');
  assert.throws(() => msixVersion('1.0.0-beta.1'), /MSIX version/);
  assert.throws(() => msixVersion('65536.0.0'), /MSIX version/);
});

test('draws square RGBA PNG logos of the requested size', () => {
  const png = placeholderLogo(44);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [44, 44, 8, 6]);
  const idat = png.indexOf('IDAT', 0, 'latin1');
  const pixels = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(pixels.length, 44 * (1 + 44 * 4));
});
