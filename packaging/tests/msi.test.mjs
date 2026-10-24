import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveMsiConfiguration } from '../windows/msi.mjs';

const template = JSON.parse(readFileSync(new URL('../windows/msi.json', import.meta.url)));
const files = ['VidVnc.Host.exe', 'runtime/node/node.exe', 'files.json'];

test('one MSI offers per-user and all-user scope, defaulting to Just me', () => {
  const config = resolveMsiConfiguration(template, { version: '0.12.1', files });
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.installation.scope, 'choice');
  assert.equal(config.installation.defaultScope, 'user');
  assert.equal(config.installation.restartManager, 'graceful');
  assert.equal(config.installation.directoryName, 'VidVNC');
  assert.equal(config.installation.menuDirectoryName, 'VidVNC');
  assert.equal(config.architecture, 'x64');
  assert.deepEqual(config.payload.allowedFiles, files);
  assert.deepEqual(Object.keys(config.components), files);
  assert.equal(config.identityNamespace, undefined);
  assert.equal(template.components, undefined, 'template must not be mutated');
});

test('v2 keeps the legacy v1 machine upgrade/product/component identities', () => {
  const first = resolveMsiConfiguration(template, { version: '0.12.1', files });
  const next = resolveMsiConfiguration(template, {
    version: '0.12.2',
    files: [...files, 'new-file.txt'],
  });
  // Golden values independently obtained from the tagged v1 Get-MsiGuid function.
  assert.equal(first.product.upgradeCode, '{4F4DB94B-6A58-85DB-B51D-AC13D201838E}');
  assert.equal(first.product.productCode, '{473652F3-B707-8CB3-A31B-54DA2FEC2420}');
  assert.equal(first.components['runtime/node/node.exe'], '{D9FEA735-AF80-8B55-8E73-4A134AB3DD7C}');
  assert.equal(next.product.upgradeCode, first.product.upgradeCode);
  assert.notEqual(next.product.productCode, first.product.productCode);
  assert.equal(next.components['runtime/node/node.exe'], first.components['runtime/node/node.exe']);
});

test('reject incompatible versions and ambiguous payload identities', () => {
  for (const version of ['1.2.3-beta.1', '256.0.0', '0.1.65535', '01.2.3'])
    assert.throws(() => resolveMsiConfiguration(template, { version, files }), /version/i);
  for (const extra of ['../escape', 'files.json', 'FILES.JSON', 'folder/../escape'])
    assert.throws(
      () => resolveMsiConfiguration(template, { version: '0.12.1', files: [...files, extra] }),
      /path|duplicate/i,
    );
});
