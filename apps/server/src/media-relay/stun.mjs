import { createHmac, timingSafeEqual } from 'node:crypto';

// The media relay's STUN checks (design: docs/superpowers/specs/2026-09-26-r4-media-relay-
// and-privilege-split-design.md). These functions are the only code that reads datagrams
// from senders that have not proved an ICE password, so they are pure, bounded and never
// throw: anything unexpected is simply not a valid message.

export const MAGIC_COOKIE = 0x2112a442;
export const MAX_STUN_BYTES = 1280;
export const TYPES = Object.freeze({
  bindingRequest: 0x0001,
  bindingSuccess: 0x0101,
  bindingError: 0x0111,
});

const HEADER_BYTES = 20;
const MAX_ATTRIBUTES = 32;
const USERNAME = 0x0006;
const MESSAGE_INTEGRITY = 0x0008;
const MESSAGE_INTEGRITY_SHA256 = 0x001c;
const FINGERPRINT = 0x8028;
const FINGERPRINT_XOR = 0x5354554e;
const KNOWN_TYPES = new Set(Object.values(TYPES));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Printable ASCII without spaces, and exactly one colon: "<receiver ufrag>:<sender ufrag>".
function validUsername(bytes) {
  if (bytes.length < 3 || bytes.length > 512) return false;
  let colons = 0;
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) return false;
    if (byte === 0x3a) colons++;
  }
  return colons === 1;
}

// A structurally valid Binding request or response, or null. Returns offsets, not copies,
// so verification can hash the original bytes.
export function parseStun(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES || buffer.length > MAX_STUN_BYTES)
    return null;
  if ((buffer[0] & 0xc0) !== 0) return null;
  const type = buffer.readUInt16BE(0);
  const length = buffer.readUInt16BE(2);
  if (!KNOWN_TYPES.has(type)) return null;
  if (length % 4 !== 0 || length !== buffer.length - HEADER_BYTES) return null;
  if (buffer.readUInt32BE(4) !== MAGIC_COOKIE) return null;

  let username;
  let integrityOffset = -1;
  let fingerprintOffset = -1;
  let sha256Seen = false;
  let count = 0;
  let offset = HEADER_BYTES;
  while (offset < buffer.length) {
    if (++count > MAX_ATTRIBUTES || offset + 4 > buffer.length) return null;
    const attribute = buffer.readUInt16BE(offset);
    const valueLength = buffer.readUInt16BE(offset + 2);
    const next = offset + 4 + Math.ceil(valueLength / 4) * 4;
    if (next > buffer.length) return null;
    // Nothing may follow FINGERPRINT; after MESSAGE-INTEGRITY only MESSAGE-INTEGRITY-SHA256
    // and FINGERPRINT may appear (RFC 8489 section 14.5), which rejects the "attributes
    // appended after the integrity check" trick.
    if (fingerprintOffset !== -1) return null;
    if (
      integrityOffset !== -1 &&
      attribute !== FINGERPRINT &&
      attribute !== MESSAGE_INTEGRITY_SHA256
    )
      return null;
    const value = buffer.subarray(offset + 4, offset + 4 + valueLength);
    if (attribute === USERNAME) {
      if (username !== undefined || !validUsername(value)) return null;
      username = value.toString('latin1');
    } else if (attribute === MESSAGE_INTEGRITY) {
      if (integrityOffset !== -1 || valueLength !== 20) return null;
      integrityOffset = offset;
    } else if (attribute === MESSAGE_INTEGRITY_SHA256) {
      if (integrityOffset === -1 || sha256Seen || valueLength < 16 || valueLength > 32) return null;
      if (valueLength % 4 !== 0) return null;
      sha256Seen = true;
    } else if (attribute === FINGERPRINT) {
      if (valueLength !== 4 || next !== buffer.length) return null;
      fingerprintOffset = offset;
    }
    offset = next;
  }
  if (integrityOffset === -1) return null;
  if (type === TYPES.bindingRequest && username === undefined) return null;
  if (fingerprintOffset !== -1) {
    const expected = (crc32(buffer.subarray(0, fingerprintOffset)) ^ FINGERPRINT_XOR) >>> 0;
    if (buffer.readUInt32BE(fingerprintOffset + 4) !== expected) return null;
  }
  return {
    type,
    transactionId: buffer.subarray(8, 20),
    username,
    integrityOffset,
    fingerprintOffset,
  };
}

// HMAC-SHA1 per RFC 5389 section 15.4, with ICE short-term credentials: the key is the ICE
// password (ICE passwords are ASCII, so SASLprep leaves them unchanged), and the header's
// length field counts the message up to and including MESSAGE-INTEGRITY.
export function verifyIntegrity(buffer, parsed, password) {
  if (!parsed || typeof password !== 'string' || password.length === 0) return false;
  const end = parsed.integrityOffset;
  const header = Buffer.from(buffer.subarray(0, HEADER_BYTES));
  header.writeUInt16BE(end + 24 - HEADER_BYTES, 2);
  const digest = createHmac('sha1', Buffer.from(password, 'utf8'))
    .update(header)
    .update(buffer.subarray(HEADER_BYTES, end))
    .digest();
  return timingSafeEqual(digest, buffer.subarray(end + 4, end + 24));
}

// The receiver's ufrag, from "<receiver ufrag>:<sender ufrag>".
export function receiverUfrag(parsed) {
  return parsed?.username?.split(':')[0];
}
