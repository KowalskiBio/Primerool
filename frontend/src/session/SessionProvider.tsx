import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { buildSession, downloadSession, hasSessionContent, migrateSession, parseSessionText, type PrimeroolSession } from './session';
import { createSessionStore, SessionControlsContext, SessionStoreContext, type SessionControls } from './sessionContext';

const AUTOSAVE_KEY = 'primerool.session.autosave';
const AUTOSAVE_DELAY_MS = 2000;

function readAutosave(): PrimeroolSession | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? migrateSession(JSON.parse(raw)) : null;
  } catch {
    clearAutosave();
    return null;
  }
}

function clearAutosave() {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // storage unavailable - nothing to clear
  }
}

/** Owns the saved-session machinery: every `useSessionState` below it
 * reports its value here; Save snapshots those values into a file,
 * Restore remounts the whole tree with the snapshot as the initial state,
 * and an autosave (debounced, browser storage) is offered back on the
 * next visit - the same flow as Oligool's session feature. */
export default function SessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createSessionStore);
  const [rev, setRev] = useState(0);
  const [hasContent, setHasContent] = useState(false);
  const [pending, setPending] = useState<PrimeroolSession | null>(readAutosave);

  // Track "is there anything to save" and autosave, debounced.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = store.subscribe(() => {
      setHasContent(hasSessionContent(store.snapshot()));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const state = store.snapshot();
        if (!hasSessionContent(state)) return;
        try {
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildSession(state)));
        } catch {
          // over quota (a large intron-inclusive sequence) or storage
          // unavailable - the explicit Save still works
        }
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [store]);

  // The seed is only for the commit that remounted the tree: the children's
  // initializers have read it by the time this (parent) effect runs, so a
  // panel mounting later - e.g. for a new gene - starts fresh.
  useEffect(() => {
    store.setSeed(null);
  }, [rev, store]);

  const controls = useMemo<SessionControls>(
    () => ({
      hasContent,
      save: () => {
        const state = store.snapshot();
        if (!hasSessionContent(state)) throw new Error('Nothing to save yet - search a gene, load a sequence or import a SNP batch first.');
        downloadSession(buildSession(state));
        clearAutosave();
      },
      loadFile: async (file: File) => {
        setPending(parseSessionText(await file.text()));
      },
      pending,
      confirmPending: () => {
        if (!pending) return;
        store.setSeed(pending.state);
        setPending(null);
        clearAutosave();
        setRev((r) => r + 1);
      },
      dismissPending: () => setPending(null),
    }),
    [hasContent, pending, store],
  );

  return (
    <SessionStoreContext.Provider value={store}>
      <SessionControlsContext.Provider value={controls}>
        <Fragment key={rev}>{children}</Fragment>
      </SessionControlsContext.Provider>
    </SessionStoreContext.Provider>
  );
}
