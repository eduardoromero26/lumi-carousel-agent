import { PERSONALITIES, type Personality } from './variety.js';

// The carousel's visual system: decided once by the art director, applied by the
// templates to every slide. This is what keeps the slides one family.
export const COMPOSITIONS = ['stacked', 'photo_top', 'window', 'overlay'] as const;
export type Composition = (typeof COMPOSITIONS)[number];

export type DesignSystem = {
  headingFont: string;
  headingWeight: number;
  bodyFont: string;
  bodyWeight: number;
  // Names GIMP knows the installed fonts by ("Montserrat ExtraBold").
  gimpHeading?: string;
  gimpBody?: string;
  gimpBodyBold?: string;
  // Ground of normal slides, text on it, the brand accent and text on the accent.
  base: string;
  ink: string;
  accent: string;
  accentInk: string;
  // The one recurring brand device.
  device: 'underline' | 'pill_label' | 'frame';
  logoPosition: 'top_center' | 'bottom_center';
  headlineCase: 'as_is' | 'upper';
  // "Swipe »" in the language of the slides, on the cover.
  swipeLabel: string;
  notes: string;
  // The brand's own way of designing, read from its website: where text aligns,
  // how round things are, products on cards or loose on the ground, a flat or a
  // gradient ground (with its second color and grain), headline tracking, buttons.
  align: 'center' | 'left';
  radius: number;
  products: 'card' | 'loose';
  ground: 'flat' | 'gradient';
  ground2?: string;
  grain: boolean;
  tracking: number;
  button: 'filled' | 'outline';
  // What the art director took from the website, in one or two sentences.
  siteNotes?: string;
  // The brand's character, which picks the fallback fonts (variety.ts).
  personality?: Personality;
  // Where the photo and the text go on every photo slide (templates.ts).
  composition: Composition;
  decor?: Decor;
};

// The carousel's decor kit: the art director writes the Muse Image prompts once, the
// images are generated once, and the templates place them where code says.
export type Decor = {
  // A full-slide surface (concrete, paper, fabric, light leaks…) blended into the ground.
  texture?: string;
  blend: 'overlay' | 'soft-light' | 'screen' | 'multiply';
  // How much the texture shows: 0.08 barely, 0.4 strong.
  strength: number;
  // One recurring graphic (strokes, shapes, an ornament) that bleeds off a corner.
  element?: string;
  // A soft accent light behind the text on slides without a photo.
  glow: boolean;
  idea?: string;
  textureFile?: string;
  elementFile?: string;
};

// What the fixer can change on a template slide without breaking it: sizes, where
// the text goes over a full-bleed photo, how big the photo or the logo is, and
// whether the decor element shows.
export type Tweaks = {
  headScale?: number;
  bodyScale?: number;
  band?: 'auto' | 'top' | 'bottom' | 'split';
  photoScale?: number;
  logoScale?: number;
  decor?: boolean;
};

const clampTo = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

export function normalizeTweaks(raw: Partial<Record<keyof Tweaks, unknown>> | undefined): Tweaks {
  const band = raw?.band;
  return {
    headScale: clampTo(raw?.headScale, 0.6, 1.15),
    bodyScale: clampTo(raw?.bodyScale, 0.7, 1.1),
    band: band === 'top' || band === 'bottom' || band === 'split' ? band : 'auto',
    photoScale: clampTo(raw?.photoScale, 0.55, 1),
    logoScale: clampTo(raw?.logoScale, 0.7, 1.4),
    decor: raw?.decor === false ? false : undefined,
  };
}

const BLENDS = ['overlay', 'soft-light', 'screen', 'multiply'] as const;

export function normalizeDecor(raw: unknown): Decor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const prompt = (v: unknown) => (typeof v === 'string' && v.trim().length > 8 ? v.trim().slice(0, 400) : undefined);
  const decor: Decor = {
    texture: prompt(d.texture),
    blend: BLENDS.includes(d.blend as Decor['blend']) ? (d.blend as Decor['blend']) : 'soft-light',
    strength: clampTo(d.strength, 0.08, 0.4) ?? 0.2,
    element: prompt(d.element),
    glow: d.glow === true,
    idea: typeof d.idea === 'string' ? d.idea.slice(0, 300) : undefined,
  };
  return decor.texture || decor.element || decor.glow ? decor : undefined;
}

export const LAYOUTS = ['cover', 'product', 'hero', 'photo_band', 'poster', 'cta'] as const;
export type Layout = (typeof LAYOUTS)[number];

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Readable text for a ground: the given ink when it passes 4.5:1, else white or near-black.
export function readableOn(ground: string, ink: string): string {
  if (contrast(ground, ink) >= 4.5) return ink;
  return contrast(ground, '#ffffff') >= contrast(ground, '#111111') ? '#ffffff' : '#111111';
}

const HEX = /^#[0-9a-f]{6}$/i;

// The art director's answer, made safe: real colors, readable pairs, sane limits.
export function normalizeSystem(raw: Partial<DesignSystem>, fallbackColors: string[]): DesignSystem {
  const color = (v: unknown, fallback: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
  const weight = (v: unknown, fallback: number) => {
    const n = Math.round(Number(v) / 100) * 100;
    return n >= 100 && n <= 900 ? n : fallback;
  };
  const base = color(raw.base, '#111111');
  const accent = color(raw.accent, fallbackColors.find((c) => HEX.test(c) && contrast(c, base) > 1.6) ?? '#ffffff');
  const ink = readableOn(base, color(raw.ink, '#ffffff'));
  // The gradient's second color must keep the text readable too, or the ground stays flat.
  const ground2 = raw.ground === 'gradient' && typeof raw.ground2 === 'string' && HEX.test(raw.ground2) && contrast(raw.ground2, ink) >= 4.5 ? raw.ground2.toLowerCase() : undefined;
  const radius = Math.round(Number(raw.radius));
  const tracking = Number(raw.tracking);
  return {
    headingFont: typeof raw.headingFont === 'string' && raw.headingFont.trim() ? raw.headingFont.trim() : 'Montserrat',
    headingWeight: weight(raw.headingWeight, 800),
    bodyFont: typeof raw.bodyFont === 'string' && raw.bodyFont.trim() ? raw.bodyFont.trim() : 'Montserrat',
    bodyWeight: weight(raw.bodyWeight, 400),
    base,
    ink,
    accent,
    accentInk: readableOn(accent, color(raw.accentInk, '#111111')),
    device: raw.device === 'pill_label' || raw.device === 'frame' ? raw.device : 'underline',
    logoPosition: raw.logoPosition === 'bottom_center' ? 'bottom_center' : 'top_center',
    headlineCase: raw.headlineCase === 'upper' ? 'upper' : 'as_is',
    swipeLabel: typeof raw.swipeLabel === 'string' && raw.swipeLabel.trim() ? raw.swipeLabel.trim().slice(0, 24) : 'Swipe »',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    align: raw.align === 'left' ? 'left' : 'center',
    radius: Number.isFinite(radius) ? Math.min(48, Math.max(0, radius)) : 36,
    products: raw.products === 'loose' ? 'loose' : 'card',
    ground: ground2 ? 'gradient' : 'flat',
    ground2,
    grain: raw.grain === true,
    tracking: Number.isFinite(tracking) ? Math.min(0.15, Math.max(-0.03, tracking)) : -0.01,
    button: raw.button === 'outline' ? 'outline' : 'filled',
    siteNotes: typeof raw.siteNotes === 'string' ? raw.siteNotes : undefined,
    personality: PERSONALITIES.includes(raw.personality as Personality) ? raw.personality : 'clean',
    composition: COMPOSITIONS.includes(raw.composition as Composition) ? (raw.composition as Composition) : 'stacked',
    decor: normalizeDecor(raw.decor),
  };
}

const COMPOSITION_NOTES: Record<Composition, string> = {
  stacked: 'Photo slides: the text on the ground at the top, the photo below it fading into the ground.',
  photo_top: 'Photo slides: the photo full-width at the top fading into the ground, the text below it, the logo at the foot.',
  window: 'Photo slides: the photo in a window inside the margins, on the ground, with the text beside it, never over it.',
  overlay: 'Photo slides: the photo full-bleed with the text over a soft gradient at its quietest edge.',
};

export function describeSystem(s: DesignSystem): string {
  return [
    `Headlines ${s.headingFont} ${s.headingWeight}${s.headlineCase === 'upper' ? ' in capitals' : ''}, text ${s.bodyFont} ${s.bodyWeight}.`,
    `Every slide on the same ground ${s.base} with ${s.ink} text; accent ${s.accent} (text on it ${s.accentInk}) only for the device, labels and the button.`,
    `Brand device: ${s.device.replace('_', ' ')}. ${s.align === 'left' ? `Logo at the ${s.logoPosition === 'top_center' ? 'top' : 'bottom'} on the left margin, text aligned left on x = 80` : `Logo ${s.logoPosition.replace('_', ' ')}, everything centered on x = 540`}, margins 80 px.`,
    COMPOSITION_NOTES[s.composition],
    `${s.products === 'loose' ? 'Products loose on the ground, no cards' : `Products on cards`}; corners ${s.radius ? `${s.radius} px` : 'square'}; ${s.ground === 'gradient' ? `gradient ground ${s.base} → ${s.ground2}` : 'flat ground'}${s.grain ? ' with grain' : ''}; ${s.button} buttons.`,
    s.siteNotes ? `From the website: ${s.siteNotes}` : '',
    s.notes,
    decorNotes(s.decor),
  ]
    .filter(Boolean)
    .join(' ');
}

// Only what was really generated: the critic must not ask for a decor that failed.
function decorNotes(d: DesignSystem['decor']): string {
  if (!d) return '';
  const parts = [
    d.textureFile ? `a ${d.texture} texture blended into the ground` : '',
    d.elementFile ? `a recurring ${d.element} bleeding off one corner of the slides without a full-bleed photo (on purpose: it may touch the edge, never the text or the logo)` : '',
    d.glow ? 'a soft accent light behind the text on slides without a photo' : '',
  ].filter(Boolean);
  return parts.length ? `Decor kit (made with Muse Image): ${parts.join('; ')}.` : '';
}
