// Primerool session save / load - the file format and its validation.
//
// A session is a flat map of every durable `useSessionState` value that was
// mounted when it was taken (see `SessionProvider.tsx`), keyed by
// panel-namespaced names ("app.sequenceData", "manual.tmMin", ...). The
// loaded sequence itself is included, so restoring never re-fetches it.
// IDT credentials and the theme are machine-local (plain localStorage) and
// intentionally not part of it.

import type { SequenceData } from '../api/sequence';
import type { Selections } from '../utils/regionMapping';

export const PRIMEROOL_SESSION_APP = 'primerool';
export const PRIMEROOL_SESSION_VERSION = 1;

export type SessionState = Record<string, unknown>;

export interface PrimeroolSession {
  app: typeof PRIMEROOL_SESSION_APP;
  version: number;
  savedAt: string;
  name: string;
  state: SessionState;
}

/** Whether a session holds any real work - a searched gene or a loaded
 * sequence. Panel defaults alone (an untouched app) don't count. */
export function hasSessionContent(state: SessionState): boolean {
  return Boolean(state['app.geneName']) || Boolean(state['app.sequenceData']);
}

function sequenceOf(state: SessionState): SequenceData | null {
  const d = state['app.sequenceData'];
  return d && typeof d === 'object' ? (d as SequenceData) : null;
}

/** A human name for the session: gene + transcript when there are. */
export function sessionName(state: SessionState): string {
  const seq = sequenceOf(state);
  const gene = seq?.gene_name || (typeof state['app.geneName'] === 'string' ? state['app.geneName'] : '');
  const transcript = seq && seq.transcript_id !== 'custom' ? seq.transcript_name || seq.transcript_id : '';
  return [gene, transcript].filter(Boolean).join(' ') || 'Primerool session';
}

export function buildSession(state: SessionState): PrimeroolSession {
  return { app: PRIMEROOL_SESSION_APP, version: PRIMEROOL_SESSION_VERSION, savedAt: new Date().toISOString(), name: sessionName(state), state };
}

/** A filesystem-safe filename like `BRCA1_BRCA1-201_20260928.primerool.json`. */
export function buildSessionFilename(name: string): string {
  const safe =
    (name || 'primerool')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'primerool';
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${safe}_${stamp}.primerool.json`;
}

/** Triggers a browser download of the session as pretty-printed JSON. */
export function downloadSession(session: PrimeroolSession): void {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildSessionFilename(session.name);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Validates a parsed session object, filling safe defaults. Unknown state
 * keys are harmless (nothing reads them) and missing ones fall back to each
 * panel's own default, so older files keep loading. */
export function migrateSession(data: unknown): PrimeroolSession {
  if (!data || typeof data !== 'object' || (data as { app?: unknown }).app !== PRIMEROOL_SESSION_APP) {
    throw new Error('This file is not a Primerool session.');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.version !== 'number' || d.version > PRIMEROOL_SESSION_VERSION) {
    throw new Error(`Unsupported session version (${String(d.version)}). Please update Primerool.`);
  }
  const state = d.state && typeof d.state === 'object' && !Array.isArray(d.state) ? (d.state as SessionState) : {};
  if (!hasSessionContent(state)) throw new Error('This session is empty - nothing to restore.');
  return {
    app: PRIMEROOL_SESSION_APP,
    version: PRIMEROOL_SESSION_VERSION,
    savedAt: typeof d.savedAt === 'string' ? d.savedAt : new Date().toISOString(),
    name: typeof d.name === 'string' ? d.name : sessionName(state),
    state,
  };
}

/** Parses and validates a session file's text. Throws a user-facing Error. */
export function parseSessionText(text: string): PrimeroolSession {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  return migrateSession(data);
}

/** Label/value rows for the "Restore session?" preview. */
export function summarizeSession(session: PrimeroolSession): { label: string; value: string }[] {
  const { state } = session;
  const seq = sequenceOf(state);
  const selections = state['app.selections'] && typeof state['app.selections'] === 'object' ? (state['app.selections'] as Partial<Selections>) : {};
  const picks = Object.values(selections).filter((s) => s != null).length;
  const rows = [
    { label: 'Gene', value: seq?.gene_name || (typeof state['app.geneName'] === 'string' ? state['app.geneName'] : '') || '-' },
    { label: 'Species', value: typeof state['app.species'] === 'string' ? state['app.species'].replace(/_/g, ' ') : '-' },
    {
      label: 'Sequence',
      value: seq ? `${seq.transcript_id === 'custom' ? 'custom sequence' : seq.transcript_name || seq.transcript_id} · ${(seq.upstream_len + seq.gene_len + seq.downstream_len).toLocaleString('en-US')} bp` : 'not loaded',
    },
    { label: 'Primers & probes', value: String(picks) },
    { label: 'Saved', value: new Date(session.savedAt).toLocaleString() },
  ];
  return rows;
}
