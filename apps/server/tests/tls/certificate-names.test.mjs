import test from 'node:test';
import assert from 'node:assert/strict';
import { certificateNames } from '../../src/tls/certificate-names.mjs';

const local = {
  hostnames: ['KIMS-DESKTOP', 'localhost'],
  ips: ['127.0.0.1', '192.168.1.20', '::1'],
  errors: [],
};

test('with remote access off the certificate covers every local name', () => {
  assert.deepEqual(certificateNames(local, { remoteAccess: false, publicHostnames: [] }), local);
});

test('with remote access on it names the public hosts and not the PC', () => {
  const names = certificateNames(local, {
    remoteAccess: true,
    publicHostnames: ['vnc.example.com', '203.0.113.10'],
  });
  assert.deepEqual(names.hostnames, ['localhost', 'vnc.example.com']);
  assert.deepEqual(names.ips, ['127.0.0.1', '192.168.1.20', '::1', '203.0.113.10']);
  assert.deepEqual(names.errors, []);
});
