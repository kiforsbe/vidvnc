import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { TYPES, parseStun, receiverUfrag, verifyIntegrity } from '../src/media-relay/stun.mjs';

// RFC 5769 test vectors (as also used by coturn's rfc5769check.c and pion/stun).
const PASSWORD = 'VOkJxbRl1RmTxUk/WvJxBt';
const hex = (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex');
const REQUEST = hex(`
  00010058 2112a442 b7e7a701bc34d686fa87dfae
  80220010 5354554e207465737420636c69656e74
  00240004 6e0001ff
  80290008 932ff9b151263b36
  00060009 6576746a3a68367659202020
  00080014 9aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a2
  80280004 e57a3bcf`);
const RESPONSE_V4 = hex(`
  0101003c 2112a442 b7e7a701bc34d686fa87dfae
  8022000b 7465737420766563746f7220
  00200008 0001a147e112a643
  00080014 2b91f599fd9e90c38c7489f92af9ba53f06be7d7
  80280004 c07d4c96`);
const RESPONSE_V6 = hex(`
  01010048 2112a442 b7e7a701bc34d686fa87dfae
  8022000b 7465737420766563746f7220
  00200014 0002a147 0113a9faa5d3f179bc25f4b5bed2b9d9
  00080014 a382954e4be67bf11784c97c8292c275bfe3ed41
  80280004 c8fb0b4c`);

test('the RFC 5769 request parses and verifies with the short-term password', () => {
  const parsed = parseStun(REQUEST);
  assert.equal(parsed.type, TYPES.bindingRequest);
  assert.equal(parsed.username, 'evtj:h6vY');
  assert.equal(receiverUfrag(parsed), 'evtj');
  assert.equal(verifyIntegrity(REQUEST, parsed, PASSWORD), true);
  assert.equal(verifyIntegrity(REQUEST, parsed, `${PASSWORD}x`), false);
});

test('the RFC 5769 IPv4 and IPv6 responses parse and verify', () => {
  for (const message of [RESPONSE_V4, RESPONSE_V6]) {
    const parsed = parseStun(message);
    assert.equal(parsed.type, TYPES.bindingSuccess);
    assert.equal(parsed.username, undefined);
    assert.equal(verifyIntegrity(message, parsed, PASSWORD), true);
  }
});

test('flipping any single bit makes a vector fail to parse or to verify', () => {
  for (const vector of [REQUEST, RESPONSE_V4, RESPONSE_V6]) {
    for (let bit = 0; bit < vector.length * 8; bit++) {
      const copy = Buffer.from(vector);
      copy[bit >> 3] ^= 1 << (bit & 7);
      const parsed = parseStun(copy);
      assert.equal(
        parsed !== null && verifyIntegrity(copy, parsed, PASSWORD),
        false,
        `bit ${bit} still verifies`,
      );
    }
  }
});

test('truncated messages are not STUN', () => {
  for (let length = 0; length < REQUEST.length; length++)
    assert.equal(parseStun(REQUEST.subarray(0, length)), null, `length ${length}`);
});

// Builds a request with the given attributes, a valid MESSAGE-INTEGRITY and optionally a
// FINGERPRINT, then lets a test append or alter attributes.
function request({ username = 'abcd:wxyz', password = PASSWORD, after = [], fingerprint = true }) {
  const attribute = (type, value) => {
    const padded = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
    padded.writeUInt16BE(type, 0);
    padded.writeUInt16BE(value.length, 2);
    value.copy(padded, 4);
    return padded;
  };
  const header = Buffer.alloc(20);
  header.writeUInt16BE(TYPES.bindingRequest, 0);
  header.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(header, 8);
  const body = [attribute(0x0006, Buffer.from(username))];
  const beforeIntegrity = Buffer.concat(body);
  header.writeUInt16BE(beforeIntegrity.length + 24, 2);
  const mac = createHmac('sha1', password).update(header).update(beforeIntegrity).digest();
  const parts = [header, beforeIntegrity, attribute(0x0008, mac), ...after];
  let message = Buffer.concat(parts);
  message.writeUInt16BE(message.length - 20 + (fingerprint ? 8 : 0), 2);
  if (fingerprint) {
    // CRC-32 via zlib when available; the module has its own table and must agree.
    const crc = crc32(message) ^ 0x5354554e;
    const fp = Buffer.alloc(8);
    fp.writeUInt16BE(0x8028, 0);
    fp.writeUInt16BE(4, 2);
    fp.writeUInt32BE(crc >>> 0, 4);
    message = Buffer.concat([message, fp]);
  }
  return message;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('a request built here verifies, with and without FINGERPRINT', () => {
  for (const fingerprint of [true, false]) {
    const message = request({ fingerprint });
    const parsed = parseStun(message);
    assert.ok(parsed, `fingerprint ${fingerprint}`);
    assert.equal(verifyIntegrity(message, parsed, PASSWORD), true);
  }
});

test('attributes appended after MESSAGE-INTEGRITY make the message malformed', () => {
  const extra = Buffer.from([0x80, 0x22, 0x00, 0x04, 0x41, 0x41, 0x41, 0x41]); // SOFTWARE
  assert.equal(parseStun(request({ after: [extra] })), null);
  const priority = Buffer.from([0x00, 0x24, 0x00, 0x04, 0x6e, 0x00, 0x01, 0xff]);
  assert.equal(parseStun(request({ after: [priority], fingerprint: false })), null);
});

test('MESSAGE-INTEGRITY-SHA256 may follow MESSAGE-INTEGRITY and is ignored', () => {
  const sha256 = Buffer.concat([Buffer.from([0x00, 0x1c, 0x00, 0x20]), randomBytes(32)]);
  const message = request({ after: [sha256] });
  const parsed = parseStun(message);
  assert.ok(parsed);
  assert.equal(verifyIntegrity(message, parsed, PASSWORD), true);
});

test('usernames must be printable, bounded and hold exactly one colon', () => {
  for (const username of ['ab', 'no-colon', 'a:b:c', 'sp ace:x', 'é:x'])
    assert.equal(parseStun(request({ username })), null, username);
  assert.ok(parseStun(request({ username: 'a:b' })));
});

test('a request without USERNAME or MESSAGE-INTEGRITY is not accepted', () => {
  const noIntegrity = Buffer.from(REQUEST.subarray(0, 20 + 20 + 8 + 12 + 16));
  noIntegrity.writeUInt16BE(noIntegrity.length - 20, 2);
  assert.equal(parseStun(noIntegrity), null);
});

test('indications, other methods and non-STUN bytes are not accepted', () => {
  const indication = Buffer.from(REQUEST);
  indication.writeUInt16BE(0x0011, 0);
  assert.equal(parseStun(indication), null);
  const allocate = Buffer.from(REQUEST);
  allocate.writeUInt16BE(0x0003, 0);
  assert.equal(parseStun(allocate), null);
  assert.equal(parseStun(Buffer.from([0x16, 0xfe, 0xfd, ...randomBytes(40)])), null); // DTLS
  assert.equal(parseStun('not a buffer'), null);
  assert.equal(parseStun(Buffer.alloc(1300)), null);
});

test('random buffers never throw and never verify', () => {
  for (let round = 0; round < 200_000; round++) {
    const length = 20 + ((round * 7) % 200);
    const buffer = randomBytes(length);
    // Make a fraction look like STUN so the attribute walk is exercised too.
    if (round % 2 === 0) {
      buffer.writeUInt16BE(round % 4 === 0 ? 0x0001 : 0x0101, 0);
      buffer.writeUInt16BE((length - 20) & ~3, 2);
      buffer.writeUInt32BE(0x2112a442, 4);
    }
    const parsed = parseStun(buffer);
    if (parsed) assert.equal(verifyIntegrity(buffer, parsed, PASSWORD), false);
  }
});
