import { useEffect, useState } from 'react';
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

  const [geneName, setGeneName] = useState('');
  const [species, setSpecies] = useState('homo_sapiens');
  // The organism currently picked in the input panel's toggle (updated
  // live, unlike `species` which only moves when a gene is actually
  // searched) - forwarded to the sequence map's "Find in sequence" as an
  // rsID-lookup fallback, so a variant that exists only in the organism
  // the user is analyzing can still be found.
  const [selectedSpecies, setSelectedSpecies] = useState('homo_sapiens');
  const [apiSource, setApiSource] = useState<'ensembl' | 'ncbi'>('ncbi');
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [sequenceData, setSequenceData] = useState<SequenceData | null>(null);
  const [truncateIntrons, setTruncateIntrons] = useState(false);
  const [selections, setSelections] = useState<Selections>(EMPTY_SELECTIONS);
  // Primer sets are remembered per loaded sequence (gene, transcript and
  // view settings - see `primerSetKey`): loading a sequence restores the
  // sets made on it, and every change is saved back. Switched at render
  // time, not in an effect, so the save below can never write one
  // sequence's sets under another's key.
  const setKey = primerSetKey(sequenceData);
  const [loadedSetKey, setLoadedSetKey] = useState<string | null>(null);
  if (setKey !== loadedSetKey) {
    setLoadedSetKey(setKey);
    setSelections(loadPrimerSets(setKey));
  }
  useEffect(() => {
    if (setKey === loadedSetKey) savePrimerSets(setKey, selections);
  }, [setKey, loadedSetKey, selections]);
  const [primerMode, setPrimerMode] = useState<'flanking' | 'junction' | 'general' | 'arms'>('flanking');
  const [ampTarget, setAmpTarget] = useState(150);
  const [ampDev, setAmpDev] = useState(50);

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
    setSelections((prev) => ({ ...prev, [key]: value }));
  }

  const isCustomSequence = sequenceData?.transcript_id === 'custom';

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-base">
        <div className="mx-auto flex h-14 max-w-[110rem] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[15px] font-semibold tracking-tight text-ink">Primerool</span>
            <span className="hidden text-xs text-ink-faint sm:inline">Primer design for any organism</span>
          </div>
          <ThemeToggle theme={theme} onThemeChange={applyTheme} />
        </div>
      </header>

      <main className="mx-auto max-w-[110rem] px-4 py-6 sm:px-6 lg:px-8">
        <Section step={1} title="Input Sequence">
          <InputPanel onGeneFound={handleGeneFound} onCustomSequence={handleCustomSequence} onSpeciesSelectionChange={setSelectedSpecies} />
        </Section>

        {transcripts.length > 0 && (
          <Section step={2} title="Select Transcript & Configure">
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
          <Section step={3} title="Sequence & Features">
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
          <Section step={4} title="Primer Design: Automatic">
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
          <Section step={5} title="Primer Design: Manual">
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

        <Section step={6} title="Multi-Sequence Alignment (Conserved-Region Primers)" defaultCollapsed>
          <AlignmentPanel />
        </Section>

        <Section title="IDT OligoAnalyzer Account" defaultCollapsed>
          <IdtSettingsPanel credentials={idtCredentials} onChange={handleIdtCredentialsChange} />
        </Section>
      </main>
    </div>
  );
}

export default App;
