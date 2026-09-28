import { useEffect, useMemo, useRef, useState } from 'react';
import type { Transcript } from './api/gene';
import type { SequenceData } from './api/sequence';
import { EMPTY_SELECTIONS, type Selection, type Selections } from './utils/regionMapping';
import { loadPrimerSets, primerSetKey, savePrimerSets } from './utils/primerSetStore';
import Section from './components/ui/Section';
import InputPanel from './components/InputPanel';
import TranscriptPanel from './components/TranscriptPanel';
import SequenceFeaturesPanel from './components/SequenceFeaturesPanel';
import AutoDesignPanel from './components/AutoDesignPanel';
import ManualDesignPanel from './components/ManualDesignPanel';
import AlignmentPanel from './components/AlignmentPanel';
import IdtSettingsPanel, { type IdtCredentials } from './components/IdtSettingsPanel';
import SessionRestoreDialog from './components/SessionRestoreDialog';
import Button from './components/ui/Button';
import { useSession, useSessionState } from './session/sessionContext';

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function ThemeToggle({ theme, onThemeChange }: { theme: 'light' | 'dark'; onThemeChange: (t: 'light' | 'dark') => void }) {
  const dark = theme === 'dark';
  return (
    <button
      onClick={() => onThemeChange(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'));

  const [geneName, setGeneName] = useSessionState('app.geneName', '');
  const [species, setSpecies] = useSessionState('app.species', 'homo_sapiens');
  // The organism currently picked in the input panel's toggle (updated
  // live, unlike `species` which only moves when a gene is actually
  // searched) - forwarded to the sequence map's "Find in sequence" as an
  // rsID-lookup fallback, so a variant that exists only in the organism
  // the user is analyzing can still be found.
  const [selectedSpecies, setSelectedSpecies] = useSessionState('app.selectedSpecies', 'homo_sapiens');
  const [apiSource, setApiSource] = useSessionState<'ensembl' | 'ncbi'>('app.apiSource', 'ncbi');
  const [transcripts, setTranscripts] = useSessionState<Transcript[]>('app.transcripts', []);
  const [sequenceData, setSequenceData] = useSessionState<SequenceData | null>('app.sequenceData', null);
  const [truncateIntrons, setTruncateIntrons] = useSessionState('app.truncateIntrons', true);
  const [storedSelections, setSelections] = useSessionState<Selections>('app.selections', EMPTY_SELECTIONS);
  // A session saved before a slot existed lacks it - fill it with `null`.
  const selections = useMemo(() => ({ ...EMPTY_SELECTIONS, ...storedSelections }), [storedSelections]);
  // Primer sets are remembered per loaded sequence (gene, transcript and
  // view settings - see `primerSetKey`): loading a sequence restores the
  // sets made on it, and every change is saved back. Switched at render
  // time, not in an effect, so the save below can never write one
  // sequence's sets under another's key.
  const setKey = primerSetKey(sequenceData);
  // Starts at the mounted sequence's key, so a restored session's own
  // `selections` aren't replaced by that sequence's stored sets.
  const [loadedSetKey, setLoadedSetKey] = useState<string | null>(() => setKey);
  if (setKey !== loadedSetKey) {
    setLoadedSetKey(setKey);
    setSelections(loadPrimerSets(setKey));
  }
  useEffect(() => {
    if (setKey === loadedSetKey) savePrimerSets(setKey, selections);
  }, [setKey, loadedSetKey, selections]);
  const [primerMode, setPrimerMode] = useSessionState<'flanking' | 'junction' | 'general' | 'arms'>('app.primerMode', 'flanking');
  const [ampTarget, setAmpTarget] = useSessionState('app.ampTarget', 150);
  const [ampDev, setAmpDev] = useSessionState('app.ampDev', 50);

  // IDT OligoAnalyzer credentials - five discrete `localStorage` keys,
  // matching Oligool's own storage shape exactly (the rewrite plan's
  // locked-in decision), assembled into one object only here at the point
  // of use, never persisted server-side.
  const [idtClientId, setIdtClientId] = useState(() => localStorage.getItem('idt_client_id') || '');
  const [idtClientSecret, setIdtClientSecret] = useState(() => localStorage.getItem('idt_client_secret') || '');
  const [idtUsername, setIdtUsername] = useState(() => localStorage.getItem('idt_username') || '');
  const [idtPassword, setIdtPassword] = useState(() => localStorage.getItem('idt_password') || '');
  const [idtRegion, setIdtRegion] = useState<'us' | 'eu'>(() => (localStorage.getItem('idt_region') === 'us' ? 'us' : 'eu'));

  const idtCredentials: IdtCredentials = { clientId: idtClientId, clientSecret: idtClientSecret, username: idtUsername, password: idtPassword, region: idtRegion };
  const hasIdtCredentials = Boolean(idtClientId && idtClientSecret && idtUsername && idtPassword);

  function handleIdtCredentialsChange(next: IdtCredentials) {
    setIdtClientId(next.clientId);
    localStorage.setItem('idt_client_id', next.clientId);
    setIdtClientSecret(next.clientSecret);
    localStorage.setItem('idt_client_secret', next.clientSecret);
    setIdtUsername(next.username);
    localStorage.setItem('idt_username', next.username);
    setIdtPassword(next.password);
    localStorage.setItem('idt_password', next.password);
    setIdtRegion(next.region);
    localStorage.setItem('idt_region', next.region);
  }

  function applyTheme(t: 'light' | 'dark') {
    setTheme(t);
    localStorage.setItem('theme', t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }

  function handleGeneFound(name: string, sp: string, source: 'ensembl' | 'ncbi', ts: Transcript[]) {
    setGeneName(name);
    setSpecies(sp);
    setApiSource(source);
    setTranscripts(ts);
    setSequenceData(null);
  }

  function handleCustomSequence(data: SequenceData) {
    setTranscripts([]);
    setSequenceData(data);
  }

  /** `null` clears that slot (e.g. removing a set from the primer list). */
  function handleSelect(key: keyof Selections, value: Selection | null) {
    // A mutant probe only makes sense beside its wild-type allele probe -
    // replacing that with a general probe (or removing it) drops the pair.
    const dropsAlleleTwin = key === 'geneProbe' && !value?.allele;
    setSelections((prev) => ({ ...prev, [key]: value, ...(dropsAlleleTwin ? { geneProbeAlt: null } : {}) }));
  }

  const isCustomSequence = sequenceData?.transcript_id === 'custom';

  const session = useSession();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sessionMsg, setSessionMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashSessionMsg(type: 'ok' | 'err', text: string, ms = 3000) {
    setSessionMsg({ type, text });
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setSessionMsg(null), ms);
  }
  function saveSession() {
    try {
      session.save();
      flashSessionMsg('ok', 'Session saved');
    } catch (e) {
      flashSessionMsg('err', e instanceof Error ? e.message : 'Failed to save session', 5000);
    }
  }
  async function loadSessionFile(file: File) {
    try {
      await session.loadFile(file);
    } catch (e) {
      flashSessionMsg('err', e instanceof Error ? e.message : 'Failed to load session', 5000);
    }
  }
  // Ctrl/Cmd+S saves the session instead of the browser's "save page".
  const saveRef = useRef(saveSession);
  useEffect(() => {
    saveRef.current = saveSession;
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-base">
        <div className="mx-auto flex h-14 max-w-[110rem] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[15px] font-semibold tracking-tight text-ink">Primerool</span>
            <span className="hidden text-xs text-ink-faint sm:inline">Primer design for any organism</span>
          </div>
          <div className="flex items-center gap-2">
            {sessionMsg && (
              <span role="status" className={`hidden text-xs sm:inline ${sessionMsg.type === 'ok' ? 'text-ink-muted' : 'text-danger'}`}>
                {sessionMsg.text}
              </span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadSessionFile(file);
                e.target.value = ''; // allow re-loading the same file
              }}
            />
            <Button size="sm" onClick={() => fileInputRef.current?.click()} title="Load a saved Primerool session (.primerool.json)">
              Load
            </Button>
            <Button size="sm" onClick={saveSession} disabled={!session.hasContent} title="Save this session - gene, transcript, sequence, primers, probes and design results - to a file (Ctrl+S)">
              Save
            </Button>
            <ThemeToggle theme={theme} onThemeChange={applyTheme} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[110rem] px-4 py-6 sm:px-6 lg:px-8">
        <Section step={1} title="Input Sequence" persistKey="section.input">
          <InputPanel onGeneFound={handleGeneFound} onCustomSequence={handleCustomSequence} onSpeciesSelectionChange={setSelectedSpecies} />
        </Section>

        {transcripts.length > 0 && (
          <Section step={2} title="Select Transcript & Configure" persistKey="section.transcript">
            <TranscriptPanel
              key={`${geneName}-${species}-${apiSource}`}
              geneName={geneName}
              species={species}
              apiSource={apiSource}
              transcripts={transcripts}
              truncateIntrons={truncateIntrons}
              onTruncateIntronsChange={setTruncateIntrons}
              onSequenceLoaded={setSequenceData}
            />
          </Section>
        )}

        {sequenceData && (
          <Section step={3} title="Sequence & Features" persistKey="section.features">
            <SequenceFeaturesPanel
              data={sequenceData}
              selections={selections}
              truncateIntrons={truncateIntrons}
              primerMode={primerMode}
              onPrimerModeChange={setPrimerMode}
              onClearSelections={() => setSelections(EMPTY_SELECTIONS)}
              onSelect={handleSelect}
              species={isCustomSequence ? undefined : species}
              apiSource={isCustomSequence ? undefined : apiSource}
              selectedSpecies={selectedSpecies}
            />
          </Section>
        )}

        {sequenceData && !isCustomSequence && (
          <Section step={4} title="Primer Design: Automatic" persistKey="section.auto">
            <AutoDesignPanel
              data={sequenceData}
              species={species}
              apiSource={apiSource}
              primerMode={primerMode}
              onPrimerModeChange={setPrimerMode}
              onSelect={handleSelect}
              idtCredentials={hasIdtCredentials ? idtCredentials : undefined}
            />
          </Section>
        )}

        {sequenceData && (
          <Section step={5} title="Primer Design: Manual" persistKey="section.manual">
            <ManualDesignPanel
              data={sequenceData}
              onSelect={handleSelect}
              ampTarget={ampTarget}
              ampDev={ampDev}
              onAmpTargetChange={setAmpTarget}
              onAmpDevChange={setAmpDev}
              idtCredentials={hasIdtCredentials ? idtCredentials : undefined}
            />
          </Section>
        )}

        <Section step={6} title="Multi-Sequence Alignment (Conserved-Region Primers)" defaultCollapsed persistKey="section.align">
          <AlignmentPanel />
        </Section>

        <Section title="IDT OligoAnalyzer Account" defaultCollapsed>
          <IdtSettingsPanel credentials={idtCredentials} onChange={handleIdtCredentialsChange} />
        </Section>
      </main>

      <SessionRestoreDialog
        session={session.pending}
        onCancel={session.dismissPending}
        onConfirm={() => {
          const name = session.pending?.name;
          session.confirmPending();
          flashSessionMsg('ok', `Loaded "${name ?? 'session'}"`);
        }}
      />
    </div>
  );
}

export default App;
