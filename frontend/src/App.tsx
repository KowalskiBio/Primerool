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
import AlignmentPanel from './components/AlignmentPanel';
import SessionRestoreDialog from './components/SessionRestoreDialog';
import SettingsModal, { DEFAULT_THEME_PREFS, type ThemePrefs } from './components/SettingsModal';
import Button from './components/ui/Button';
import { useSession, useSessionState } from './session/sessionContext';
import { EMPTY_IDT_CREDENTIALS, hasIdtCredentials, loadIdtCredentials, saveIdtCredentials, type IdtCredentials } from './utils/idtCredentials';
import { applyAccentPreset, clearAccentOverrides, DEFAULT_WALLPAPER_OPACITY } from './theme';

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

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
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

  // IDT OligoAnalyzer credentials - machine-local like the NCBI key, but
  // encrypted at rest, so they load asynchronously after first render.
  const [idtCredentials, setIdtCredentials] = useState<IdtCredentials>(EMPTY_IDT_CREDENTIALS);
  useEffect(() => {
    let cancelled = false;
    loadIdtCredentials().then((c) => {
      if (!cancelled) setIdtCredentials(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const idtReady = hasIdtCredentials(idtCredentials);

  function handleIdtCredentialsChange(next: IdtCredentials) {
    setIdtCredentials(next);
    void saveIdtCredentials(next);
  }

  function applyTheme(t: 'light' | 'dark') {
    setTheme(t);
    localStorage.setItem('theme', t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }

  // Machine-local settings shared with Oligool's storage keys (see
  // `session.ts`: prefs like these intentionally stay out of session files).
  const [ncbiApiKey, setNcbiApiKey] = useState(() => localStorage.getItem('ncbi_api_key') || '');
  const [wallpaperUrl, setWallpaperUrl] = useState(() => localStorage.getItem('wallpaper_url') || '');
  const [wallpaperOpacity, setWallpaperOpacity] = useState(() => {
    const v = localStorage.getItem('wallpaper_opacity');
    return v ? parseInt(v, 10) : DEFAULT_WALLPAPER_OPACITY;
  });
  const [accentPreset, setAccentPreset] = useState(() => localStorage.getItem('accent_preset') || '');
  const [customAccentColor, setCustomAccentColor] = useState(() => localStorage.getItem('custom_accent_color') || '#1d4ed8');
  const [settingsOpen, setSettingsOpen] = useState(false);

  function handleApiKeyChange(key: string) {
    setNcbiApiKey(key);
    const trimmed = key.trim();
    if (trimmed) localStorage.setItem('ncbi_api_key', trimmed);
    else localStorage.removeItem('ncbi_api_key');
  }

  function handleWallpaperChange(url: string) {
    setWallpaperUrl(url);
    if (!url) {
      localStorage.removeItem('wallpaper_url');
      return;
    }
    try {
      localStorage.setItem('wallpaper_url', url);
    } catch {
      // Uploaded images are data URLs; a big one blows the ~5MB quota, in
      // which case it works for this session but isn't persisted.
      localStorage.removeItem('wallpaper_url');
    }
  }

  function handleWallpaperOpacityChange(opacity: number) {
    setWallpaperOpacity(opacity);
    localStorage.setItem('wallpaper_opacity', String(opacity));
  }

  function handleAccentPresetChange(name: string) {
    setAccentPreset(name);
    if (name) localStorage.setItem('accent_preset', name);
    else localStorage.removeItem('accent_preset');
  }

  function handleCustomAccentColorChange(hex: string) {
    setCustomAccentColor(hex);
    localStorage.setItem('custom_accent_color', hex);
  }

  const themePrefs: ThemePrefs = { wallpaperUrl, wallpaperOpacity, accentPreset, customAccentColor };

  function handleThemePrefsChange(next: ThemePrefs) {
    if (next.wallpaperUrl !== wallpaperUrl) handleWallpaperChange(next.wallpaperUrl);
    if (next.wallpaperOpacity !== wallpaperOpacity) handleWallpaperOpacityChange(next.wallpaperOpacity);
    if (next.accentPreset !== accentPreset) handleAccentPresetChange(next.accentPreset);
    if (next.customAccentColor !== customAccentColor) handleCustomAccentColorChange(next.customAccentColor);
  }

  function handleResetTheme() {
    handleWallpaperChange('');
    handleWallpaperOpacityChange(DEFAULT_WALLPAPER_OPACITY);
    handleAccentPresetChange('');
    handleCustomAccentColorChange(DEFAULT_THEME_PREFS.customAccentColor);
  }

  // Applies the `.dark` class and (re)applies accent overrides on mount and
  // whenever theme/preset change. Overrides are inline root styles, which
  // win equally over the `:root` and `.dark` blocks in index.css, so they
  // must be re-applied when the mode flips to pick that mode's shade set.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    if (accentPreset) applyAccentPreset(accentPreset, theme, customAccentColor);
    else clearAccentOverrides();
  }, [theme, accentPreset, customAccentColor]);

  // `,` toggles the settings modal (same shortcut as Oligool), unless the
  // user is typing in a form field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== ',' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      setSettingsOpen((open) => !open);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
      {/* Wallpaper: fixed full-viewport layer behind the app. The root div
       * paints no background (index.css is transparent), so this shows
       * through everywhere; surfaces (`bg-surface`) sit opaquely above it. */}
      {wallpaperUrl && (
        <div
          className="pointer-events-none fixed inset-0 z-0"
          style={{ backgroundImage: `url(${wallpaperUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', opacity: wallpaperOpacity / 100 }}
        />
      )}
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
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings (,)"
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <SettingsIcon />
            </button>
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
              idtCredentials={idtReady ? idtCredentials : undefined}
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
              idtCredentials={idtReady ? idtCredentials : undefined}
            />
          </Section>
        )}

        <Section step={5} title="Multi-Sequence Alignment (Conserved-Region Primers)" defaultCollapsed persistKey="section.align">
          <AlignmentPanel loadedSequence={sequenceData} />
        </Section>
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiKey={ncbiApiKey}
        onApiKeyChange={handleApiKeyChange}
        idtCredentials={idtCredentials}
        onIdtCredentialsChange={handleIdtCredentialsChange}
        theme={themePrefs}
        onThemeChange={handleThemePrefsChange}
        onResetTheme={handleResetTheme}
      />

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
