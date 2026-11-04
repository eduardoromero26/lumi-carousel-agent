import { describeLayout, type RefLayout } from './layout.js';
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
  // The owner's reference plan (layout.ts), with the serif and sans it needs by weight.
  layout?: RefLayout;
  layoutFonts?: { serif: Record<number, string>; sans: Record<number, string> };
  // The reference the slides imitate in HTML (html_slide.ts): its file.
  htmlRef?: string;
  // The master slide's HTML: the other slides keep its system (fonts, colors, objects).
  htmlMaster?: string;
  // The reference's ground in bands (a light field over a deep one), in the brand's colors.
  zones?: { y1: number; y2: number; color: string }[];
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
  // A generated image behind the slides without a photo (a scene of the business's
  // world, in the ground's tones), instead of a word repeated in rows.
  backdrop?: string;
  backdropFile?: string;
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
    backdrop: prompt(d.backdrop),
    idea: typeof d.idea === 'string' ? d.idea.slice(0, 300) : undefined,
  };
  const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{4,80}$/.test(v.trim()) ? v.trim() : undefined);
  if (id(d.reuseTexture) || id(d.reuseElement)) decor.reuse = { texture: id(d.reuseTexture), element: id(d.reuseElement) };
  return decor.texture || decor.element || decor.glow || decor.backdrop || decor.reuse ? decor : undefined;
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

// The family of a ground, what makes a feed of carousels look alike at a glance: 18 of
// 18 in a row came out on cream. Chroma, not HSL saturation: cream is "saturated" in HSL.
export const GROUND_TONES = ['light', 'dark', 'deep', 'pastel'] as const;
export type GroundTone = (typeof GROUND_TONES)[number];

function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

export function toneOf(hex: string): GroundTone {
  if (!HEX.test(hex)) return 'light';
  return luminance(hex) > 0.35 ? (chroma(hex) >= 0.11 ? 'pastel' : 'light') : chroma(hex) >= 0.12 ? 'deep' : 'dark';
}

// The brand's hue for a ground: its accent, or the most colorful of its colors; none
// when the brand is all neutrals (then only light and dark are possible).
function brandHue(colors: string[]): [number, number] | undefined {
  const hues = colors.filter((c) => HEX.test(c) && chroma(c) >= 0.12).map((c) => toHsl(c));
  return hues.length ? [hues[0][0], hues[0][1]] : undefined;
}

export function groundTones(colors: string[]): GroundTone[] {
  return brandHue(colors) ? [...GROUND_TONES] : ['light', 'dark'];
}

// A ground of that family in the brand's hue: a warm white, a near-black with a hint
// of the brand, a deep tone (forest, wine, navy, olive) or a pastel.
export function groundOf(tone: GroundTone, colors: string[]): string {
  const [h, s] = brandHue(colors) ?? [0, 0];
  if (tone === 'light') return fromHsl(h, Math.min(s, 0.3), 0.975);
  if (tone === 'dark') return fromHsl(h, Math.min(s, 0.14), 0.09);
  if (tone === 'deep') return fromHsl(h, Math.min(Math.max(s, 0.35), 0.55), 0.22);
  // Visibly tinted: at this lightness a low saturation reads as cream again.
  return fromHsl(h, Math.min(Math.max(s, 0.6), 0.75), 0.88);
}

// A reference's ground color in the brand's own: a brand color of the same family and
// near its lightness when there is one (Delgado's cream for a beige field), else the
// reference's lightness in the brand's hue (a brown band becomes navy).
export function inBrandTone(hex: string, colors: string[]): string {
  const [, rs, rl] = toHsl(hex);
  const own = colors.find((c) => HEX.test(c) && toneOf(c) === toneOf(hex) && Math.abs(toHsl(c)[2] - rl) < 0.15);
  if (own) return own.toLowerCase();
  const hue = brandHue(colors);
  if (!hue) return fromHsl(0, 0, rl);
  const s = rl > 0.6 ? Math.min(rs, 0.35) : Math.min(Math.max(rs, 0.35), 0.6);
  return fromHsl(hue[0], s, rl);
}

// A new ground for a system: the text keeps the old ground's color when it reads
// (cream text on deep green), the accent is the first brand color that stands out on
// it, else a tint of the brand's hue that does.
export function setGround(system: DesignSystem, base: string, colors: string[]): void {
  const old = system.base;
  system.base = base;
  system.ink = contrast(base, old) >= 7 ? old : readableOn(base, system.ink);
  const [h, s] = brandHue([system.accent, ...colors]) ?? [0, 0];
  const dark = luminance(base) < 0.2;
  const options = [system.accent, ...colors.filter((c) => HEX.test(c) && chroma(c) >= 0.12), fromHsl(h, Math.min(s, 0.7), dark ? 0.75 : 0.32), old, dark ? '#ffffff' : '#111111'];
  system.accent = options.find((c) => contrast(c, base) >= 3 && c.toLowerCase() !== system.ink.toLowerCase())?.toLowerCase() ?? system.accent;
  system.accentInk = readableOn(system.accent, system.accentInk);
  system.ground = 'flat';
  system.ground2 = undefined;
}

// A soft gradient of the same ground (lighter on dark grounds, a shade deeper on light
// ones), only when the text still reads on both ends.
export function softGradient(system: DesignSystem): boolean {
  const [h, s, l] = toHsl(system.base);
  const second = fromHsl(h, s, luminance(system.base) < 0.2 ? Math.min(l + 0.09, 0.4) : Math.max(l - 0.06, 0.6));
  if (contrast(second, system.ink) < 4.5 || second === system.base) return false;
  system.ground = 'gradient';
  system.ground2 = second;
  return true;
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
  overlay: 'Photo slides: the photo full-bleed with the text at its quietest edge: over a short dark gradient on a dark ground, on a frosted rounded panel of the ground (the photo blurred behind it) on a light one; never a colored veil over the whole photo.',
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
    `Products cut out and loose on the ground with a soft shadow, no white or grey card (on purpose; a card only where the cutout failed); corners ${s.radius ? `${s.radius} px` : 'square'}; ${s.ground === 'gradient' ? `gradient ground ${s.base} → ${s.ground2}` : 'flat ground'}${s.grain ? ' with grain' : ''}; ${s.button} buttons.`,
    s.siteNotes ? `From the website: ${s.siteNotes}` : '',
    s.layout ? `Photo slides follow the owner's reference layout, on purpose (its own margins, not 80 px): ${describeLayout(s.layout)}` : '',
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
    d.backdropFile ? `a generated ${d.backdrop} scene behind the slides without a photo and behind every cut-out product, which stands in it, softened so the text reads (on purpose: it is the carousel's set, not a business photo; the same scene on several slides is the family, not a clash with the flat ground)` : '',
  ].filter(Boolean);
  return parts.length ? `Decor kit (made with Muse Image): ${parts.join('; ')}.` : '';
}
