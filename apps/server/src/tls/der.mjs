// A minimal DER (X.690) writer: only the types a self-signed X.509 certificate needs
// (strategies/self-signed.mjs). Every function returns the complete encoding as a Buffer,
// so values nest by passing one result into another. Nothing here parses DER; certificates
// are read back with node:crypto's X509Certificate, which is how the tests check this.

const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
};

function length(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function encode(tag, content) {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

export const sequence = (...items) => encode(TAG.sequence, Buffer.concat(items));
export const set = (...items) => encode(TAG.set, Buffer.concat(items));
export const nullValue = () => encode(TAG.null, Buffer.alloc(0));
export const boolean = (value) => encode(TAG.boolean, Buffer.from([value ? 0xff : 0]));
export const octetString = (bytes) => encode(TAG.octetString, Buffer.from(bytes));
export const utf8String = (text) => encode(TAG.utf8String, Buffer.from(text, 'utf8'));

export function ia5String(text) {
  if (!/^[\x00-\x7f]*$/.test(text)) throw new Error('IA5String must be ASCII');
  return encode(TAG.ia5String, Buffer.from(text, 'ascii'));
}

// A non-negative integer, from a number, a bigint or big-endian bytes. A leading zero byte is
// added when the top bit is set, so the value never reads as negative.
export function integer(value) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = value;
  else {
    let big = BigInt(value);
    if (big < 0n) throw new Error('Only non-negative integers are supported');
    const out = [];
    do {
      out.unshift(Number(big & 0xffn));
      big >>= 8n;
    } while (big > 0n);
    bytes = Buffer.from(out);
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && bytes[start + 1] < 0x80) start++;
  bytes = bytes.subarray(start);
  if (!bytes.length) bytes = Buffer.from([0]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return encode(TAG.integer, bytes);
}

// A BIT STRING of whole bytes (no unused bits), as keys and signatures are.
export const bitString = (bytes) =>
  encode(TAG.bitString, Buffer.concat([Buffer.from([0]), Buffer.from(bytes)]));

// A named-bit BIT STRING (KeyUsage): bit 0 is the most significant bit of the first byte.
// Trailing zero bits are dropped, as DER requires.
export function namedBits(bits) {
  const highest = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(highest / 8) + 1);
  for (const bit of bits) bytes[Math.floor(bit / 8)] |= 0x80 >> (bit % 8);
  const unused = 7 - (highest % 8);
  return encode(TAG.bitString, Buffer.concat([Buffer.from([unused]), bytes]));
}

export function oid(dotted) {
  const parts = dotted.split('.').map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`Invalid OID ${dotted}`);
    return BigInt(part);
  });
  if (parts.length < 2 || parts[0] > 2n || (parts[0] < 2n && parts[1] > 39n))
    throw new Error(`Invalid OID ${dotted}`);
  const arcs = [parts[0] * 40n + parts[1], ...parts.slice(2)];
  const bytes = [];
  for (const arc of arcs) {
    const chunk = [Number(arc & 0x7fn)];
    for (let rest = arc >> 7n; rest > 0n; rest >>= 7n) chunk.unshift(Number(rest & 0x7fn) | 0x80);
    bytes.push(...chunk);
  }
  return encode(TAG.oid, Buffer.from(bytes));
}

// RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050, always UTC, whole
// seconds.
export function time(date) {
  const iso = new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
  const digits = iso.replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 9999) throw new Error('Certificate time out of range');
  return year < 2050
    ? encode(TAG.utcTime, Buffer.from(digits.slice(2), 'ascii'))
    : encode(TAG.generalizedTime, Buffer.from(digits, 'ascii'));
}

// A context-specific tag [n]. Explicit tagging wraps a complete encoding; implicit tagging
// replaces the tag of a primitive value with [n] and keeps its content.
export const explicit = (number, inner) => encode(0xa0 | number, inner);

export function implicit(number, inner) {
  const constructed = inner[0] & 0x20;
  // The inner encoding's own length bytes say where its content starts.
  const contentStart = inner[1] < 0x80 ? 2 : 2 + (inner[1] & 0x7f);
  return encode(0x80 | constructed | number, inner.subarray(contentStart));
}
