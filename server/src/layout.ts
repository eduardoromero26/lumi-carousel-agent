// A reference's layout as a plan the renderer can follow on any brand's photos: where the
// photo goes and which side its subject stands on, every text block's box and type
// treatment, and the small graphic elements. Boxes are 0..1 of the slide.
export type Box = { x1: number; y1: number; x2: number; y2: number };

export const BLOCK_ROLES = ['title', 'headline', 'body', 'label', 'cta', 'signature'] as const;
export type BlockRole = (typeof BLOCK_ROLES)[number];

export type LayoutBlock = {
  role: BlockRole;
  box: Box;
  align: 'left' | 'center' | 'right';
  case: 'upper' | 'as_is';
  weight: 'light' | 'regular' | 'bold';
  font: 'serif' | 'sans';
  // Letter spacing in em: 0 normal, 0.2 widely spaced capitals.
  tracking: number;
  // Drawn behind the photo's subject (a giant word the person stands in front of).
  behindSubject: boolean;
  // How the key words stand out: heavier, or in the accent color.
  emphasis: 'bold' | 'color' | 'none';
};

export const ELEMENT_TYPES = ['line', 'arrow_circle', 'circle', 'pill', 'frame', 'panel'] as const;
export type LayoutElement = { type: (typeof ELEMENT_TYPES)[number]; box: Box };

export type RefLayout = {
  // "box": a product poster, the product standing in its box on the line standOn (0..1 of
  // the design), with a soft shadow under it.
  photo: { mode: 'full' | 'box' | 'none'; box: Box; subjectAt: number; standOn?: number; shadow?: boolean };
  // Where the photo is shaded so the text reads.
  scrim: 'none' | 'left' | 'right' | 'top' | 'bottom';
  textTone: 'light' | 'dark';
  blocks: LayoutBlock[];
  elements: LayoutElement[];
  // Where the reference has its own logo or wordmark: ours goes there.
  logo?: Box;
  // An oversized faded letter or word in the background; its box may run off the design.
  ghost?: { kind: 'letter' | 'word'; box: Box };
  // The ground in bands, measured on the reference's pixels (references.ts), not read by the model.
  zones?: Zone[];
};

export type Zone = { y1: number; y2: number; hex: string };

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const one = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

function box(raw: unknown, lo = 0, hi = 1): Box | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  const x1 = num(b.x1, lo, hi, NaN);
  const y1 = num(b.y1, lo, hi, NaN);
  const x2 = num(b.x2, lo, hi, NaN);
  const y2 = num(b.y2, lo, hi, NaN);
  if ([x1, y1, x2, y2].some(Number.isNaN) || x2 - x1 < 0.02 || y2 - y1 < 0.008) return undefined;
  return { x1, y1, x2, y2 };
}

// The reader's answer made safe; undefined when there is nothing a renderer can follow.
export function normalizeLayout(raw: unknown): RefLayout | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const l = raw as Record<string, unknown>;
  const photo = (l.photo ?? {}) as Record<string, unknown>;
  const blocks: LayoutBlock[] = [];
  for (const b of Array.isArray(l.blocks) ? l.blocks : []) {
    const r = (b ?? {}) as Record<string, unknown>;
    const where = box(r.box);
    const role = one(r.role, BLOCK_ROLES, 'body');
    if (!where || blocks.some((x) => x.role === role)) continue;
    blocks.push({
      role,
      box: where,
      align: one(r.align, ['left', 'center', 'right'] as const, 'left'),
      case: r.case === 'upper' ? 'upper' : 'as_is',
      weight: one(r.weight, ['light', 'regular', 'bold'] as const, 'regular'),
      font: r.font === 'serif' ? 'serif' : 'sans',
      tracking: num(r.tracking, -0.03, 0.4, 0),
      behindSubject: r.behindSubject === true && role === 'title',
      emphasis: one(r.emphasis, ['bold', 'color', 'none'] as const, 'none'),
    });
  }
  const logo = box(l.logo);
  // A wordmark read as a giant title too: the logo wins, the title goes.
  if (logo) for (const [i, b] of [...blocks.entries()].reverse()) if (b.role === 'title' && overlapShare(b.box, logo) > 0.5) blocks.splice(i, 1);
  // A product poster that is only its logo and the product (a brand ad) still needs our
  // headline: under the logo, in its alignment, above the product.
  const poster = photo.mode === 'box';
  if (poster && !blocks.some((b) => b.role === 'headline' || b.role === 'title')) {
    const top = logo ? Math.min(0.5, logo.y2 + 0.035) : 0.08;
    const product = box(photo.box);
    const center = !logo || Math.abs((logo.x1 + logo.x2) / 2 - 0.5) < 0.1;
    blocks.push({
      role: 'headline',
      box: { x1: center ? 0.1 : (logo?.x1 ?? 0.08), y1: top, x2: center ? 0.9 : 0.86, y2: Math.min(top + 0.12, product ? Math.max(top + 0.06, product.y1 - 0.01) : top + 0.12) },
      align: center ? 'center' : 'left',
      case: 'as_is',
      weight: 'bold',
      font: 'sans',
      tracking: 0,
      behindSubject: false,
      emphasis: 'none',
    });
  }
  if (!blocks.some((b) => b.role === 'headline' || b.role === 'title')) return undefined;
  const elements: LayoutElement[] = [];
  for (const e of Array.isArray(l.elements) ? l.elements : []) {
    const r = (e ?? {}) as Record<string, unknown>;
    const where = box(r.box) ?? (r.type === 'line' ? lineBox(r.box) : undefined);
    if (where && elements.length < 4) elements.push({ type: one(r.type, ELEMENT_TYPES, 'line'), box: where });
  }
  const ghost = (l.ghost ?? null) as Record<string, unknown> | null;
  const ghostBox = ghost ? box(ghost.box, -0.6, 1.6) : undefined;
  const zones = Array.isArray(l.zones)
    ? (l.zones as Record<string, unknown>[])
        .map((z) => ({ y1: num(z?.y1, 0, 1, NaN), y2: num(z?.y2, 0, 1, NaN), hex: typeof z?.hex === 'string' && /^#[0-9a-f]{6}$/i.test(z.hex) ? z.hex : '' }))
        .filter((z) => z.hex && z.y2 > z.y1)
    : [];
  return {
    photo: {
      mode: one(photo.mode, ['full', 'box', 'none'] as const, 'full'),
      box: box(photo.box) ?? { x1: 0, y1: 0, x2: 1, y2: 1 },
      subjectAt: num(photo.subjectAt, 0, 1, 0.5),
      ...(typeof photo.standOn === 'number' ? { standOn: num(photo.standOn, 0.2, 1, 1) } : {}),
      ...(typeof photo.shadow === 'boolean' ? { shadow: photo.shadow } : {}),
    },
    scrim: one(l.scrim, ['none', 'left', 'right', 'top', 'bottom'] as const, 'none'),
    textTone: l.textTone === 'dark' ? 'dark' : 'light',
    blocks,
    elements,
    ...(logo ? { logo } : {}),
    ...(ghostBox ? { ghost: { kind: ghost!.kind === 'word' ? 'word' : 'letter', box: ghostBox } } : {}),
    ...(zones.length ? { zones } : {}),
  };
}

// How much of a lies inside b.
function overlapShare(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  return (w * h) / Math.max(1e-6, (a.x2 - a.x1) * (a.y2 - a.y1));
}

// A hairline can come back with no height at all.
function lineBox(raw: unknown): Box | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  const x1 = num(b.x1, 0, 1, NaN);
  const x2 = num(b.x2, 0, 1, NaN);
  const y = num(b.y1, 0, 1, NaN);
  return [x1, x2, y].some(Number.isNaN) || x2 - x1 < 0.02 ? undefined : { x1, y1: y, x2, y2: Math.min(1, y + 0.004) };
}

// The plan seen in a mirror: for a photo whose subject stands on the other side.
export function mirrorLayout(l: RefLayout): RefLayout {
  const flip = (b: Box): Box => ({ x1: 1 - b.x2, y1: b.y1, x2: 1 - b.x1, y2: b.y2 });
  const side = { left: 'right', right: 'left', top: 'top', bottom: 'bottom', none: 'none' } as const;
  return {
    photo: { ...l.photo, box: flip(l.photo.box), subjectAt: 1 - l.photo.subjectAt },
    scrim: side[l.scrim],
    textTone: l.textTone,
    blocks: l.blocks.map((b) => ({ ...b, box: flip(b.box), align: b.align === 'left' ? 'right' : b.align === 'right' ? 'left' : 'center' })),
    elements: l.elements.map((e) => ({ ...e, box: flip(e.box) })),
    ...(l.logo ? { logo: flip(l.logo) } : {}),
    ...(l.ghost ? { ghost: { ...l.ghost, box: flip(l.ghost.box) } } : {}),
    ...(l.zones ? { zones: l.zones } : {}),
  };
}

export function describeLayout(l: RefLayout): string {
  const where = (b: Box) => `x ${Math.round(b.x1 * 100)}-${Math.round(b.x2 * 100)} %, y ${Math.round(b.y1 * 100)}-${Math.round(b.y2 * 100)} %`;
  return [
    l.photo.mode === 'none' ? 'No photo.' : `Photo ${l.photo.mode === 'full' ? 'full-bleed' : `in a box at ${where(l.photo.box)}`}, its subject at ${Math.round(l.photo.subjectAt * 100)} % across.`,
    ...l.blocks.map((b) => `${b.role} at ${where(b.box)}: ${b.font} ${b.weight}${b.case === 'upper' ? ', capitals' : ''}${b.tracking > 0.08 ? ', widely spaced' : ''}, ${b.align}${b.behindSubject ? ', behind the subject' : ''}${b.emphasis !== 'none' ? `, key words ${b.emphasis === 'bold' ? 'bold' : 'in the accent'}` : ''}.`),
    ...l.elements.map((e) => `${e.type.replace('_', ' ')} at ${where(e.box)}.`),
    l.logo ? `Logo at ${where(l.logo)}.` : '',
    l.ghost ? `An oversized faded ${l.ghost.kind} in the background at ${where(l.ghost.box)}.` : '',
    l.zones && l.zones.length > 1 ? `The ground in ${l.zones.length} bands: ${l.zones.map((z) => `${z.hex} from ${Math.round(z.y1 * 100)} to ${Math.round(z.y2 * 100)} %`).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
