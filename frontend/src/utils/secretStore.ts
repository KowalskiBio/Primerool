/** Per-browser storage for secrets (account passwords, API secrets) that
 * keeps them encrypted at rest. Values are AES-GCM encrypted with a
 * non-extractable key held in IndexedDB - page script can use the key but
 * never read its bytes, so the ciphertext in `localStorage` is useless when
 * copied out of the browser profile (disk, backups, a devtools dump).
 *
 * WebCrypto only exists in a secure context (https or localhost). Elsewhere
 * secrets fall back to `sessionStorage`: kept for this tab only, never
 * written to disk. */

const DB_NAME = 'primerool-secrets';
const STORE = 'keys';
const KEY_ID = 'aes-gcm';
const PREFIX = 'secret:';

function canEncrypt(): boolean {
  return typeof crypto !== 'undefined' && Boolean(crypto.subtle) && typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = op(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

let keyPromise: Promise<CryptoKey> | null = null;

/** The browser's one encryption key, created on first use. */
function getKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const db = await openDb();
    const existing = await idb<CryptoKey | undefined>(db, 'readonly', (s) => s.get(KEY_ID));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb(db, 'readwrite', (s) => s.put(key, KEY_ID));
    return key;
  })();
  keyPromise.catch(() => {
    keyPromise = null;
  });
  return keyPromise;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function saveSecret(name: string, value: string): Promise<void> {
  if (!value) return clearSecret(name);
  if (!canEncrypt()) {
    sessionStorage.setItem(PREFIX + name, value);
    return;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(value)));
  localStorage.setItem(PREFIX + name, `${toBase64(iv)}.${toBase64(ct)}`);
}

/** `null` when nothing is stored, or when the stored value can't be
 * decrypted (e.g. site data partly cleared, losing the key). */
export async function loadSecret(name: string): Promise<string | null> {
  if (!canEncrypt()) return sessionStorage.getItem(PREFIX + name);
  const stored = localStorage.getItem(PREFIX + name);
  if (!stored) return null;
  try {
    const [iv, ct] = stored.split('.').map(fromBase64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await getKey(), ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function clearSecret(name: string): Promise<void> {
  localStorage.removeItem(PREFIX + name);
  sessionStorage.removeItem(PREFIX + name);
}
