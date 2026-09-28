import { createContext, useContext, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { PrimeroolSession, SessionState } from './session';

/** Stable for the provider's lifetime - so the many `useSessionState`
 * consumers never re-render just because some other value changed. */
export interface SessionStore {
  /** The snapshot being restored - read by initializers during the restore
   * commit only, then cleared (see `SessionProvider`). */
  getSeed: () => SessionState | null;
  setSeed: (state: SessionState | null) => void;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
  /** Live value of every mounted `useSessionState` with a key. */
  snapshot: () => SessionState;
  /** Called after every change; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

export function createSessionStore(): SessionStore {
  const values = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let seed: SessionState | null = null;
  const emit = () => listeners.forEach((l) => l());
  return {
    getSeed: () => seed,
    setSeed: (state) => {
      seed = state;
    },
    set: (key, value) => {
      values.set(key, value);
      emit();
    },
    delete: (key) => {
      values.delete(key);
      emit();
    },
    snapshot: () => Object.fromEntries(values),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const SessionStoreContext = createContext<SessionStore | null>(null);

export interface SessionControls {
  /** Whether there is work worth saving (a gene or a loaded sequence). */
  hasContent: boolean;
  /** Downloads the current session; throws a user-facing Error if empty. */
  save: () => void;
  /** Parses a session file into `pending`; throws a user-facing Error. */
  loadFile: (file: File) => Promise<void>;
  /** A session waiting on the "Restore session?" confirmation - from a
   * loaded file, or last visit's autosave. */
  pending: PrimeroolSession | null;
  confirmPending: () => void;
  dismissPending: () => void;
}

export const SessionControlsContext = createContext<SessionControls | null>(null);

export function useSession(): SessionControls {
  const ctx = useContext(SessionControlsContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** `useState` whose value is part of the saved session under `key`: it
 * starts from the session being restored when there is one, and its live
 * value is what "Save" writes. `key: null` is plain `useState` - for a
 * component instance that must not persist (e.g. a viewer inside a modal).
 * Only JSON-safe values belong here. `revive` adjusts a restored value -
 * e.g. dropping entries saved mid-request, whose request is long gone. */
export function useSessionState<T>(key: string | null, init: T | (() => T), revive?: (saved: T) => T): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(SessionStoreContext);
  const [value, setValue] = useState<T>(() => {
    const seed = store?.getSeed();
    if (key && seed && key in seed) return revive ? revive(seed[key] as T) : (seed[key] as T);
    return typeof init === 'function' ? (init as () => T)() : init;
  });

  useEffect(() => {
    if (!key || !store) return;
    store.set(key, value);
  }, [store, key, value]);

  // A session captures what is mounted: an unmounted panel's state is gone
  // from the app, so it leaves the session too.
  useEffect(() => {
    if (!key || !store) return;
    return () => {
      store.delete(key);
    };
  }, [store, key]);

  return [value, setValue];
}

/** A `useSessionState` reviver for a record of per-item request states:
 * keeps only the entries `finished` accepts, so one saved mid-request
 * doesn't come back as a spinner that never stops. */
export function dropUnfinished<V>(finished: (v: V) => boolean): (saved: Record<string, V>) => Record<string, V> {
  return (saved) => Object.fromEntries(Object.entries(saved).filter(([, v]) => finished(v)));
}
