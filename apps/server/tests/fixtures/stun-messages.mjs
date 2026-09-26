import { createHmac, randomBytes } from 'node:crypto';

// Builds STUN Binding messages the way browsers send them: attributes, then
// MESSAGE-INTEGRITY keyed with the receiver's ICE password, then FINGERPRINT.

function attribute(type, value) {
  const padded = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  padded.writeUInt16BE(type, 0);
  padded.writeUInt16BE(value.length, 2);
  value.copy(padded, 4);
  return padded;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function stunMessage({ type = 0x0001, username, password, fingerprint = true }) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(header, 8);
  const body = Buffer.concat([
    ...(username === undefined ? [] : [attribute(0x0006, Buffer.from(username))]),
    attribute(0x0024, Buffer.from([0x6e, 0x00, 0x01, 0xff])), // PRIORITY
  ]);
  header.writeUInt16BE(body.length + 24, 2);
  const mac = createHmac('sha1', password).update(header).update(body).digest();
  let message = Buffer.concat([header, body, attribute(0x0008, mac)]);
  if (fingerprint) {
    message.writeUInt16BE(message.length - 20 + 8, 2);
    const value = Buffer.alloc(4);
    value.writeUInt32BE((crc32(message) ^ 0x5354554e) >>> 0);
    message = Buffer.concat([message, attribute(0x8028, value)]);
  }
  return message;
}

export const bindingRequest = (username, password) => stunMessage({ username, password });
export const bindingResponse = (password) => stunMessage({ type: 0x0101, password });
