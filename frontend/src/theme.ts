/** Accent-color presets and wallpapers, ported from Oligool's `theme.ts`.
 *
 * Unlike Oligool (themed on Tailwind's `zinc`/`accent` 11-shade ramps), Primerool
 * is themed on a handful of semantic tokens (`--accent*` in `index.css`), so a
 * preset maps a few shades of its palette onto those tokens per light/dark mode.
 * Overrides are inline styles on `:root`, which win equally over the `:root` and
 * `.dark` blocks in the stylesheet — so they must be re-applied whenever the
 * dark class flips (App.tsx's theme effect does that). */
export type Palette = Record<string, string>;

export const ACCENT_PRESETS: Record<string, Palette> = {
  teal: {
    '50': '#f0fdfa', '100': '#ccfbf1', '200': '#99f6e4', '300': '#5eead4',
    '400': '#2dd4bf', '500': '#14b8a6', '600': '#0d9488', '700': '#0f766e',
    '800': '#115e59', '900': '#134e4a', '950': '#042f2e',
  },
  blue: {
    '50': '#eff6ff', '100': '#dbeafe', '200': '#bfdbfe', '300': '#93c5fd',
    '400': '#60a5fa', '500': '#3b82f6', '600': '#2563eb', '700': '#1d4ed8',
    '800': '#1e40af', '900': '#1e3a8a', '950': '#172554',
  },
  emerald: {
    '50': '#ecfdf5', '100': '#d1fae5', '200': '#a7f3d0', '300': '#6ee7b7',
    '400': '#34d399', '500': '#10b981', '600': '#059669', '700': '#047857',
    '800': '#065f46', '900': '#064e3b', '950': '#022c22',
  },
  violet: {
    '50': '#f5f3ff', '100': '#ede9fe', '200': '#ddd6fe', '300': '#c4b5fd',
    '400': '#a78bfa', '500': '#8b5cf6', '600': '#7c3aed', '700': '#6d28d9',
    '800': '#5b21b6', '900': '#4c1d95', '950': '#2e1065',
  },
  rose: {
    '50': '#fff1f2', '100': '#ffe4e6', '200': '#fecdd3', '300': '#fda4af',
    '400': '#fb7185', '500': '#f43f5e', '600': '#e11d48', '700': '#be123c',
    '800': '#9f1239', '900': '#881337', '950': '#4c0519',
  },
  amber: {
    '50': '#fffbeb', '100': '#fef3c7', '200': '#fde68a', '300': '#fcd34d',
    '400': '#fbbf24', '500': '#f59e0b', '600': '#d97706', '700': '#b45309',
    '800': '#92400e', '900': '#78350f', '950': '#451a03',
  },
};

/** Bundled wallpaper choices, served from `public_static/wallpapers/`. */
export const WALLPAPERS = [
  'wallhaven-0jepq4.jpg',
  'wallhaven-4vev8n.jpg',
  'wallhaven-e7jj6r.jpg',
  'wallhaven-j865jy.jpg',
  'wallhaven-n625q4.jpg',
  'wallhaven-ymmwkd.jpg',
];

export const DEFAULT_WALLPAPER_OPACITY = 20;

/** The six accent tokens a preset overrides. */
const ACCENT_TOKENS = [
  '--accent',
  '--accent-hover',
  '--accent-solid',
  '--accent-solid-hover',
  '--accent-subtle',
];

/** Map the preset's palette onto the semantic accent tokens. Shade picks
 * mirror the defaults' own contrast relationships (light mode uses dark
 * shades on light surfaces; dark mode needs brighter, higher-chroma shades
 * on dark surfaces, and its `subtle` is a translucent wash over the dark
 * surface rather than a light tint). */
export function applyAccentPreset(name: string, mode: 'light' | 'dark', customHex?: string) {
  const palette = name === 'custom' && customHex ? generatePalette(customHex) : ACCENT_PRESETS[name];
  if (!palette) return;
  const root = document.documentElement;
  const values =
    mode === 'dark'
      ? [palette['400'], palette['300'], palette['600'], palette['500'], withAlpha(palette['900'], 0.6)]
      : [palette['700'], palette['800'], palette['700'], palette['800'], palette['50']];
  ACCENT_TOKENS.forEach((token, i) => root.style.setProperty(token, values[i]));
}

export function clearAccentOverrides() {
  const root = document.documentElement;
  for (const token of ACCENT_TOKENS) root.style.removeProperty(token);
}

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const WHITE = '#ffffff';
const BLACK = '#000000';

function mix(hex1: string, hex2: string, weight: number): string {
  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16);
  const g2 = parseInt(hex2.slice(3, 5), 16);
  const b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.round(r1 * (1 - weight) + r2 * weight);
  const g = Math.round(g1 * (1 - weight) + g2 * weight);
  const b = Math.round(b1 * (1 - weight) + b2 * weight);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Build a 50→950 ramp from any base color by interpolation — lets accent
 * presets be generated from a single user-picked hex. */
export function generatePalette(baseHex: string): Palette {
  return {
    '50': mix(baseHex, WHITE, 0.95),
    '100': mix(baseHex, WHITE, 0.90),
    '200': mix(baseHex, WHITE, 0.75),
    '300': mix(baseHex, WHITE, 0.60),
    '400': mix(baseHex, WHITE, 0.30),
    '500': mix(baseHex, WHITE, 0.10),
    '600': baseHex,
    '700': mix(baseHex, BLACK, 0.15),
    '800': mix(baseHex, BLACK, 0.30),
    '900': mix(baseHex, BLACK, 0.45),
    '950': mix(baseHex, BLACK, 0.60),
  };
}
