import { useState } from 'react';
import type { Transcript } from './api/gene';
import type { SequenceData } from './api/sequence';
import { EMPTY_SELECTIONS, type Selection, type Selections } from './utils/regionMapping';
import Card from './components/Card';
import InputPanel from './components/InputPanel';
import TranscriptPanel from './components/TranscriptPanel';
import SequenceFeaturesPanel from './components/SequenceFeaturesPanel';
import AutoDesignPanel from './components/AutoDesignPanel';
import ManualDesignPanel, { type ProbeSearchRequest } from './components/ManualDesignPanel';
import AlignmentPanel from './components/AlignmentPanel';
import IdtSettingsPanel, { type IdtCredentials } from './components/IdtSettingsPanel';

function ThemeDensityToggle({
  theme,
  onThemeChange,
  density,
  onDensityChange,
}: {
  theme: 'light' | 'dark';
  onThemeChange: (t: 'light' | 'dark') => void;
  density: 'airy' | 'squish';
  onDensityChange: (d: 'airy' | 'squish') => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
        aria-label="Toggle dark mode"
        className="px-3 py-1.5 text-xs rounded-full font-medium border border-slate-300 dark:border-slate-600 bg-white/50 dark:bg-slate-700 hover:bg-white dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 transition-colors"
      >
        {theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
      </button>
      <button
        onClick={() => onDensityChange(density === 'squish' ? 'airy' : 'squish')}
        title="Toggle density"
        className="px-3 py-1.5 text-xs rounded-full font-medium border border-slate-300 dark:border-slate-600 bg-white/50 dark:bg-slate-700 hover:bg-white dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 transition-colors"
      >
        {density === 'squish' ? 'Squish' : 'Airy'}
      </button>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'));
  const [density, setDensity] = useState<'airy' | 'squish'>(() => (localStorage.getItem('density') === 'squish' ? 'squish' : 'airy'));

  const [geneName, setGeneName] = useState('');
  const [species, setSpecies] = useState('homo_sapiens');
  const [apiSource, setApiSource] = useState<'ensembl' | 'ncbi'>('ensembl');
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [sequenceData, setSequenceData] = useState<SequenceData | null>(null);
  const [truncateIntrons, setTruncateIntrons] = useState(false);
  const [selections, setSelections] = useState<Selections>(EMPTY_SELECTIONS);
  const [primerMode, setPrimerMode] = useState<'flanking' | 'junction' | 'general' | 'arms'>('flanking');
  const [ampTarget, setAmpTarget] = useState(150);
  const [ampDev, setAmpDev] = useState(50);
  const [probeSearchRequest, setProbeSearchRequest] = useState<ProbeSearchRequest | null>(null);
  const [probeSearchNonce, setProbeSearchNonce] = useState(0);

  // IDT OligoAnalyzer credentials — five discrete `localStorage` keys,
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

  function applyDensity(d: 'airy' | 'squish') {
    setDensity(d);
    localStorage.setItem('density', d);
    document.documentElement.setAttribute('data-density', d);
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

  function handleSelect(key: keyof Selections, value: Selection) {
    setSelections((prev) => ({ ...prev, [key]: value }));
  }

  const isCustomSequence = sequenceData?.transcript_id === 'custom';

  function handleFindProbesInAmplicon() {
    const { geneForward, geneReverse } = selections;
    if (!geneForward || !geneReverse || !sequenceData) return;
    const start = geneForward.end;
    const end = geneReverse.start;
    if (end - start < 20) {
      window.alert('Amplicon region between primers is too short to design a probe.');
      return;
    }
    const nonce = probeSearchNonce + 1;
    setProbeSearchNonce(nonce);
    setProbeSearchRequest({ probeRegion: sequenceData.gene_seq.substring(start, end), offset: start, nonce });
  }

  return (
    <div className="min-h-screen py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">Primerool</h1>
            <p className="mt-1 text-slate-500 dark:text-slate-400">Cloud-based Primer Design Tool</p>
          </div>
          <ThemeDensityToggle theme={theme} onThemeChange={applyTheme} density={density} onDensityChange={applyDensity} />
        </header>

        <div className="mb-6">
          <IdtSettingsPanel credentials={idtCredentials} onChange={handleIdtCredentialsChange} />
        </div>

        <Card title="1. Input Sequence">
          <InputPanel onGeneFound={handleGeneFound} onCustomSequence={handleCustomSequence} />
        </Card>

        {transcripts.length > 0 && (
          <Card title="2. Select Transcript & Configure">
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
          </Card>
        )}

        {sequenceData && (
          <Card title="3. Sequence & Features">
            <SequenceFeaturesPanel
              data={sequenceData}
              selections={selections}
              truncateIntrons={truncateIntrons}
              primerMode={primerMode}
              onPrimerModeChange={setPrimerMode}
              onClearSelections={() => setSelections(EMPTY_SELECTIONS)}
              ampTarget={ampTarget}
              ampDev={ampDev}
              onFindProbesInAmplicon={handleFindProbesInAmplicon}
              idtCredentials={hasIdtCredentials ? idtCredentials : undefined}
              onSelect={handleSelect}
            />
          </Card>
        )}

        {sequenceData && !isCustomSequence && (
          <Card title="4. Primer Design (Automatic)">
            <AutoDesignPanel data={sequenceData} species={species} primerMode={primerMode} onPrimerModeChange={setPrimerMode} onSelect={handleSelect} />
          </Card>
        )}

        {sequenceData && (
          <Card title="5. Primer Design (Manual)">
            <ManualDesignPanel
              data={sequenceData}
              onSelect={handleSelect}
              ampTarget={ampTarget}
              ampDev={ampDev}
              onAmpTargetChange={setAmpTarget}
              onAmpDevChange={setAmpDev}
              probeSearchRequest={probeSearchRequest}
            />
          </Card>
        )}

        <Card title="6. Multi-Sequence Alignment (Conserved-Region Primers)" defaultCollapsed>
          <AlignmentPanel />
        </Card>
      </div>
    </div>
  );
}

export default App;
