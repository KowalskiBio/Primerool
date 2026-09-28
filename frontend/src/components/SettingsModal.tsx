import { useState } from 'react';
import { ACCENT_PRESETS, DEFAULT_WALLPAPER_OPACITY, WALLPAPERS } from '../theme';
import Button from './ui/Button';
import Field from './ui/Field';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import TextInput from './ui/TextInput';

export interface ThemePrefs {
  wallpaperUrl: string;
  wallpaperOpacity: number;
  accentPreset: string;
  customAccentColor: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  theme: ThemePrefs;
  onThemeChange: (next: ThemePrefs) => void;
  /** Clears wallpaper + accent back to the built-in look. */
  onResetTheme: () => void;
}

type Tab = 'account' | 'theme';

/** Machine-local settings (per-browser, deliberately outside session files):
 * NCBI API key + theme/wallpaper prefs. A plain controlled form over state
 * owned by App.tsx - no localStorage access here, same contract as
 * `IdtSettingsPanel`. */
export default function SettingsModal({ open, onClose, apiKey, onApiKeyChange, theme, onThemeChange, onResetTheme }: Props) {
  const [tab, setTab] = useState<Tab>('account');
  const set = (patch: Partial<ThemePrefs>) => onThemeChange({ ...theme, ...patch });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <div className="flex items-center gap-4">
          <span>Settings</span>
          <SegmentedControl
            size="sm"
            ariaLabel="Settings category"
            options={[
              { value: 'account' as const, label: 'Account' },
              { value: 'theme' as const, label: 'Theme' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      }
    >
      {tab === 'account' ? (
        <div className="max-w-md space-y-4">
          <Field label="NCBI API key" htmlFor="ncbi-api-key">
            <TextInput
              id="ncbi-api-key"
              type="password"
              autoComplete="off"
              className="font-mono"
              value={apiKey}
              placeholder="Optional - raises NCBI rate limits"
              onChange={(e) => onApiKeyChange(e.target.value)}
            />
          </Field>
          <p className="text-xs text-ink-faint">
            Stored only in this browser and sent along with BLAST searches and accession lookups. Without a key NCBI
            rate-limits requests; with one (free, from your{' '}
            <a
              href="https://www.ncbi.nlm.nih.gov/account/settings/"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:text-accent-hover"
            >
              NCBI account settings
            </a>
            ) they're noticeably more lenient.
          </p>
        </div>
      ) : (
        <div className="max-w-2xl space-y-6">
          <div>
            <span className="mb-1.5 block text-xs font-medium text-ink-muted">Background</span>
            <WallpaperPicker
              wallpaperUrl={theme.wallpaperUrl}
              onSelect={(url) => set({ wallpaperUrl: url })}
            />
            {theme.wallpaperUrl && (
              <div className="mt-3 flex max-w-xs items-center gap-3">
                <label htmlFor="wallpaper-opacity" className="shrink-0 text-xs text-ink-muted">
                  Opacity
                </label>
                <input
                  id="wallpaper-opacity"
                  type="range"
                  min={5}
                  max={100}
                  step={5}
                  value={theme.wallpaperOpacity}
                  onChange={(e) => set({ wallpaperOpacity: Number(e.target.value) })}
                  className="w-full accent-accent-solid"
                />
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-muted">{theme.wallpaperOpacity}%</span>
              </div>
            )}
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-ink-muted">Accent color</span>
            <div className="flex flex-wrap items-center gap-2.5">
              {Object.entries(ACCENT_PRESETS).map(([name, palette]) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={`Accent color: ${name}`}
                  onClick={() => set({ accentPreset: name })}
                  style={{ backgroundColor: palette['500'] }}
                  className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-surface hover:scale-110 focus-visible:outline-2 focus-visible:outline-accent ${
                    theme.accentPreset === name ? 'ring-2 ring-accent-solid' : ''
                  }`}
                />
              ))}
              <input
                type="color"
                title="Custom accent color"
                aria-label="Custom accent color"
                value={theme.customAccentColor}
                onChange={(e) => set({ customAccentColor: e.target.value, accentPreset: 'custom' })}
                className={`h-7 w-7 cursor-pointer appearance-none rounded-full border border-line bg-transparent p-0.5 ${
                  theme.accentPreset === 'custom' ? 'ring-2 ring-accent-solid ring-offset-2 ring-offset-surface' : ''
                }`}
              />
            </div>
          </div>

          <Button size="sm" onClick={onResetTheme}>
            Reset to defaults
          </Button>
        </div>
      )}
    </Modal>
  );
}

function WallpaperPicker({ wallpaperUrl, onSelect }: { wallpaperUrl: string; onSelect: (url: string) => void }) {
  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onSelect(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // allow re-uploading the same file
  }

  const tileBase =
    'relative h-14 overflow-hidden rounded-md border focus-visible:outline-2 focus-visible:outline-accent';
  const tileState = (selected: boolean) => (selected ? 'border-accent-solid ring-2 ring-accent-solid' : 'border-line hover:border-line-strong');

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      <button
        type="button"
        onClick={() => onSelect('')}
        className={`${tileBase} ${tileState(!wallpaperUrl)} grid place-items-center bg-surface-2 text-xs text-ink-muted`}
      >
        None
      </button>
      {WALLPAPERS.map((file) => {
        const url = `/wallpapers/${file}`;
        return (
          <button key={file} type="button" onClick={() => onSelect(url)} className={`${tileBase} ${tileState(wallpaperUrl === url)}`}>
            <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
          </button>
        );
      })}
      <label
        title="Upload your own image"
        className={`${tileBase} ${tileState(Boolean(wallpaperUrl) && !wallpaperUrl.startsWith('/wallpapers/'))} grid cursor-pointer place-items-center bg-surface-2 text-xs text-ink-muted hover:text-ink`}
      >
        Upload…
        <input type="file" accept="image/*" className="hidden" onChange={onUpload} />
      </label>
    </div>
  );
}

/** The default theme prefs - wallpaper off, no accent override (the built-in
 * blue defined by the CSS tokens). */
export const DEFAULT_THEME_PREFS: ThemePrefs = {
  wallpaperUrl: '',
  wallpaperOpacity: DEFAULT_WALLPAPER_OPACITY,
  accentPreset: '',
  customAccentColor: '#1d4ed8',
};
