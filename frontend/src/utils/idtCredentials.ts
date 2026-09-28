import { loadSecret, saveSecret } from './secretStore';

/** IDT OligoAnalyzer account credentials. Kept per-browser, encrypted at
 * rest (see `secretStore`), and only ever sent to our server's `/idt/token`
 * route, which forwards them straight to IDT without storing them. */
export interface IdtCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  region: 'us' | 'eu';
}

export const EMPTY_IDT_CREDENTIALS: IdtCredentials = { clientId: '', clientSecret: '', username: '', password: '', region: 'eu' };

const SECRET_NAME = 'idt_credentials';
/** Oligool's plaintext `localStorage` keys, migrated on first load. */
const LEGACY_KEYS = ['idt_client_id', 'idt_client_secret', 'idt_username', 'idt_password', 'idt_region'];

export function hasIdtCredentials(c: IdtCredentials): boolean {
  return Boolean(c.clientId && c.clientSecret && c.username && c.password);
}

export async function loadIdtCredentials(): Promise<IdtCredentials> {
  const stored = await loadSecret(SECRET_NAME);
  if (stored) {
    try {
      return { ...EMPTY_IDT_CREDENTIALS, ...(JSON.parse(stored) as Partial<IdtCredentials>) };
    } catch {
      return EMPTY_IDT_CREDENTIALS;
    }
  }
  const legacy: IdtCredentials = {
    clientId: localStorage.getItem('idt_client_id') || '',
    clientSecret: localStorage.getItem('idt_client_secret') || '',
    username: localStorage.getItem('idt_username') || '',
    password: localStorage.getItem('idt_password') || '',
    region: localStorage.getItem('idt_region') === 'us' ? 'us' : 'eu',
  };
  if (LEGACY_KEYS.some((k) => localStorage.getItem(k) !== null)) {
    await saveIdtCredentials(legacy);
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  }
  return legacy;
}

// Saves run one at a time, so a slow encrypt can't land after a newer one.
let saving: Promise<void> = Promise.resolve();

export function saveIdtCredentials(c: IdtCredentials): Promise<void> {
  const empty = !c.clientId && !c.clientSecret && !c.username && !c.password;
  saving = saving.catch(() => {}).then(() => saveSecret(SECRET_NAME, empty ? '' : JSON.stringify(c)));
  return saving;
}
