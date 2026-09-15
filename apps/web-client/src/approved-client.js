const DATABASE = 'vidvnc-approved-client';
const STORE = 'values';

export function validateApprovedCredential(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.clientId !== 'string' ||
    value.clientId.length < 1 ||
    value.clientId.length > 128 ||
    typeof value.clientSecret !== 'string' ||
    value.clientSecret.length < 32 ||
    value.clientSecret.length > 256 ||
    typeof value.username !== 'string' ||
    value.username.length < 1 ||
    value.username.length > 64
  )
    return null;
  return {
    clientId: value.clientId,
    clientSecret: value.clientSecret,
    username: value.username,
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Browser storage is unavailable'));
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function read(key) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
}

async function write(key, value) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function loadApprovedCredential() {
  return validateApprovedCredential(await read('credential').catch(() => null));
}

export async function saveApprovedCredential(value) {
  const credential = validateApprovedCredential(value);
  if (!credential) throw new Error('Invalid approved-client credential');
  await write('credential', credential);
  return credential;
}

export async function forgetApprovedCredential() {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete('credential');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function createInstallationId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function')
    throw new Error('Secure random generation is unavailable');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function browserInstallationId() {
  const existing = await read('installation-id').catch(() => null);
  if (typeof existing === 'string' && existing.length >= 16 && existing.length <= 128)
    return existing;
  const value = createInstallationId();
  await write('installation-id', value);
  return value;
}
