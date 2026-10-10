import test from 'node:test';
import assert from 'node:assert/strict';
import * as der from '../../src/tls/der.mjs';

const hex = (buffer) => buffer.toString('hex');

test('lengths use the short form below 128 bytes and the long form above', () => {
  assert.equal(hex(der.octetString(Buffer.alloc(3))), '0403000000');
  assert.equal(hex(der.octetString(Buffer.alloc(127))).slice(0, 4), '047f');
  assert.equal(hex(der.octetString(Buffer.alloc(128))).slice(0, 6), '048180');
  assert.equal(hex(der.octetString(Buffer.alloc(300))).slice(0, 8), '0482012c');
});

test('integers are minimal and never negative', () => {
  assert.equal(hex(der.integer(0)), '020100');
  assert.equal(hex(der.integer(2)), '020102');
  assert.equal(hex(der.integer(127)), '02017f');
  assert.equal(hex(der.integer(128)), '02020080');
  assert.equal(hex(der.integer(256)), '02020100');
  assert.equal(hex(der.integer(Buffer.from([0, 0, 1]))), '020101');
  assert.equal(hex(der.integer(Buffer.from([0xff]))), '020200ff');
  assert.throws(() => der.integer(-1), /non-negative/);
});

test('object identifiers encode their first two arcs together and large arcs in base 128', () => {
  // Examples from X.690 and well-known OIDs.
  assert.equal(hex(der.oid('2.5.4.3')), '0603550403');
  assert.equal(hex(der.oid('1.2.840.10045.4.3.2')), '06082a8648ce3d040302');
  assert.equal(hex(der.oid('1.3.6.1.5.5.7.3.1')), '06082b06010505070301');
  assert.throws(() => der.oid('3.1'), /Invalid OID/);
  assert.throws(() => der.oid('1.40'), /Invalid OID/);
  assert.throws(() => der.oid('1.2.x'), /Invalid OID/);
});

test('times are UTCTime through 2049 and GeneralizedTime from 2050', () => {
  assert.equal(
    der.time(new Date('2026-10-10T19:42:46.789Z')).toString('latin1', 2),
    '261010194246Z',
  );
  assert.equal(der.time(new Date('2026-10-10T19:42:46Z'))[0], 0x17);
  const late = der.time(new Date('2050-01-01T00:00:00Z'));
  assert.equal(late[0], 0x18);
  assert.equal(late.toString('latin1', 2), '20500101000000Z');
});

test('named bits drop trailing zeros; byte strings carry no unused bits', () => {
  // KeyUsage digitalSignature alone: one byte, seven unused bits.
  assert.equal(hex(der.namedBits([0])), '03020780');
  // digitalSignature and keyEncipherment (bit 2).
  assert.equal(hex(der.namedBits([0, 2])), '030205a0');
  assert.equal(hex(der.namedBits([8])), '0303070080');
  assert.equal(hex(der.bitString(Buffer.from([1, 2]))), '0303000102');
});

test('context tags wrap explicitly or replace a primitive tag implicitly', () => {
  assert.equal(hex(der.explicit(0, der.integer(2))), 'a003020102');
  assert.equal(hex(der.implicit(2, der.ia5String('a.b'))), '8203612e62');
  assert.equal(hex(der.implicit(7, der.octetString(Buffer.from([127, 0, 0, 1])))), '87047f000001');
  assert.equal(hex(der.implicit(0, der.sequence(der.nullValue()))), 'a0020500');
  assert.throws(() => der.ia5String('ä'), /ASCII/);
});

test('sequences and sets concatenate their items', () => {
  assert.equal(hex(der.sequence(der.boolean(true), der.nullValue())), '30050101ff0500');
  assert.equal(hex(der.set(der.utf8String('Vi'))), '31040c025669');
});
