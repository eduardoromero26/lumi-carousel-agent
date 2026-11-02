import { PERSONALITIES, type Personality } from './variety.js';

// The carousel's visual system: decided once by the art director, applied by the
// templates to every slide. This is what keeps the slides one family.
export const COMPOSITIONS = ['stacked', 'photo_top', 'window', 'overlay', 'cutout', 'split'] as const;
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
  // The one recurring brand device (the thin frame around the slide was retired: the template look).
  device: 'underline' | 'pill_label';
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
  // "loud": poster-sized headlines (an ad that stops the scroll); "calm": quieter, for premium brands.
  typeScale: 'calm' | 'loud';
  // Slides whose ground is the accent instead of the base: a color block that opens or closes the set.
  colorSlides: 'none' | 'cover' | 'cta' | 'both';
  // A big "01", "02"… above the text of the middle slides: reasons, steps or products in order.
  numbers: boolean;
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
  // Library pieces (ids) taken instead of generating: asked by the art director, kept only when used.
  reuse?: { texture?: string; element?: string };
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
  const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{4,80}$/.test(v.trim()) ? v.trim() : undefined);
  if (id(d.reuseTexture) || id(d.reuseElement)) decor.reuse = { texture: id(d.reuseTexture), element: id(d.reuseElement) };
  return decor.texture || decor.element || decor.glow || decor.reuse ? decor : undefined;
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

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${ch(h + 1 / 3)}${ch(h)}${ch(h - 1 / 3)}`;
}

// A ground the photos can stand on: a saturated mid tone (hot pink, pure red, bright
// yellow, the "loud" grounds owners called Canva 2015) goes deep, or pastel when it is a
// light color; neutrals, darks and pastels stay as they are.
export function calmGround(hex: string): string {
  const [h, s, l] = toHsl(hex);
  if (s <= 0.35 || l >= 0.86 || l <= 0.22) return hex;
  // Oranges and yellows turn muddy brown when deepened: they go pastel (peach, butter).
  const warm = h >= 20 / 360 && h <= 70 / 360;
  return warm || luminance(hex) > 0.4 || l >= 0.62 ? fromHsl(h, Math.min(s, 0.75), 0.9) : fromHsl(h, Math.min(s, 0.62), Math.min(l, 0.34));
}

// The art director's answer, made safe: real colors, readable pairs, sane limits.
export function normalizeSystem(raw: Partial<DesignSystem>, fallbackColors: string[]): DesignSystem {
  const color = (v: unknown, fallback: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
  const weight = (v: unknown, fallback: number) => {
    const n = Math.round(Number(v) / 100) * 100;
    return n >= 100 && n <= 900 ? n : fallback;
  };
  const base = calmGround(color(raw.base, '#111111'));
  const accent = color(raw.accent, fallbackColors.find((c) => HEX.test(c) && contrast(c, base) > 1.6) ?? '#ffffff');
  const ink = readableOn(base, color(raw.ink, '#ffffff'));
  // The gradient's second color must keep the text readable too, or the ground stays flat.
  const second = typeof raw.ground2 === 'string' && HEX.test(raw.ground2) ? calmGround(raw.ground2.toLowerCase()) : undefined;
  const ground2 = raw.ground === 'gradient' && second && contrast(second, ink) >= 4.5 ? second : undefined;
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
    device: raw.device === 'pill_label' ? 'pill_label' : 'underline',
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
    typeScale: raw.typeScale === 'calm' ? 'calm' : 'loud',
    colorSlides: raw.colorSlides === 'cover' || raw.colorSlides === 'cta' || raw.colorSlides === 'both' ? raw.colorSlides : 'none',
    numbers: raw.numbers === true,
    decor: normalizeDecor(raw.decor),
  };
}

// The colors of one slide: a color slide swaps them, the accent (calmed down as a
// ground) becomes the ground and the base the accent (labels, the button), so the set
// keeps the same two colors.
export function paletteFor(s: DesignSystem, layout: string): { ground: string; ink: string; accent: string; accentInk: string; colored: boolean } {
  const colored = (layout === 'cover' && (s.colorSlides === 'cover' || s.colorSlides === 'both')) || (layout === 'cta' && (s.colorSlides === 'cta' || s.colorSlides === 'both'));
  if (!colored) return { ground: s.base, ink: s.ink, accent: s.accent, accentInk: s.accentInk, colored };
  const ground = calmGround(s.accent);
  return { ground, ink: readableOn(ground, s.accentInk), accent: s.base, accentInk: s.ink, colored };
}

// The cutout composition cuts the photo slides' subject out; product cards and the hero keep their own template.
export function cutsOut(s: DesignSystem, layout: string | undefined): boolean {
  return s.composition === 'cutout' && (!layout || layout === 'cover' || layout === 'photo_band' || layout === 'cta');
}

const COMPOSITION_NOTES: Record<Composition, string> = {
  stacked: 'Photo slides: the text on the ground at the top, the photo below it fading into the ground.',
  photo_top: 'Photo slides: the photo full-width at the top fading into the ground, the text below it, the logo at the foot.',
  window: 'Photo slides: the photo in a window inside the margins, on the ground, with the text beside it, never over it.',
  overlay: 'Photo slides: the photo full-bleed with the text over a short dark gradient at its quietest edge (a shadow under the text, never a colored veil over the photo).',
  cutout: 'Photo slides: the person or product cut out of its photo, big, standing at the foot of the slide on a solid color block with a big accent circle behind it; the text on the ground above it (on purpose: no photo rectangle, no fade).',
  split: 'Photo slides: the photo full-width at the top with a hard edge (slanted for lively brands) and a thin accent stripe along it, the text on the solid ground below; the photo may crop a body, never a face (on purpose: no fade).',
};

export function describeSystem(s: DesignSystem): string {
  return [
    `Headlines ${s.headingFont} ${s.headingWeight}${s.headlineCase === 'upper' ? ' in capitals' : ''}, text ${s.bodyFont} ${s.bodyWeight}.`,
    s.colorSlides === 'none'
      ? `Every slide on the same ground ${s.base} with ${s.ink} text; accent ${s.accent} (text on it ${s.accentInk}) for the device, labels and the button.`
      : `Slides on the ground ${s.base} with ${s.ink} text, accent ${s.accent} for the device, labels and the button; ${s.colorSlides === 'both' ? 'the cover and the call to action are' : `the ${s.colorSlides === 'cover' ? 'cover' : 'call to action'} is`} a color block on ${s.accent} (text ${s.accentInk}, labels and button in ${s.base}), on purpose.`,
    `${s.typeScale === 'loud' ? 'Poster-sized headlines' : 'Quiet, smaller headlines'}${s.numbers ? '; the middle slides carry a big number (01, 02…) above their text' : ''}.`,
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
