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
  photo: { mode: 'full' | 'box' | 'none'; box: Box; subjectAt: number };
  // Where the photo is shaded so the text reads.
  scrim: 'none' | 'left' | 'right' | 'top' | 'bottom';
  textTone: 'light' | 'dark';
  blocks: LayoutBlock[];
  elements: LayoutElement[];
};

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const one = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

function box(raw: unknown): Box | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  const x1 = num(b.x1, 0, 1, NaN);
  const y1 = num(b.y1, 0, 1, NaN);
  const x2 = num(b.x2, 0, 1, NaN);
  const y2 = num(b.y2, 0, 1, NaN);
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
  if (!blocks.some((b) => b.role === 'headline' || b.role === 'title')) return undefined;
  const elements: LayoutElement[] = [];
  for (const e of Array.isArray(l.elements) ? l.elements : []) {
    const r = (e ?? {}) as Record<string, unknown>;
    const where = box(r.box) ?? (r.type === 'line' ? lineBox(r.box) : undefined);
    if (where && elements.length < 4) elements.push({ type: one(r.type, ELEMENT_TYPES, 'line'), box: where });
  }
  return {
    photo: { mode: one(photo.mode, ['full', 'box', 'none'] as const, 'full'), box: box(photo.box) ?? { x1: 0, y1: 0, x2: 1, y2: 1 }, subjectAt: num(photo.subjectAt, 0, 1, 0.5) },
    scrim: one(l.scrim, ['none', 'left', 'right', 'top', 'bottom'] as const, 'none'),
    textTone: l.textTone === 'dark' ? 'dark' : 'light',
    blocks,
    elements,
  };
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
  };
}

export function describeLayout(l: RefLayout): string {
  const where = (b: Box) => `x ${Math.round(b.x1 * 100)}-${Math.round(b.x2 * 100)} %, y ${Math.round(b.y1 * 100)}-${Math.round(b.y2 * 100)} %`;
  return [
    l.photo.mode === 'none' ? 'No photo.' : `Photo ${l.photo.mode === 'full' ? 'full-bleed' : `in a box at ${where(l.photo.box)}`}, its subject at ${Math.round(l.photo.subjectAt * 100)} % across.`,
    ...l.blocks.map((b) => `${b.role} at ${where(b.box)}: ${b.font} ${b.weight}${b.case === 'upper' ? ', capitals' : ''}${b.tracking > 0.08 ? ', widely spaced' : ''}, ${b.align}${b.behindSubject ? ', behind the subject' : ''}${b.emphasis !== 'none' ? `, key words ${b.emphasis === 'bold' ? 'bold' : 'in the accent'}` : ''}.`),
    ...l.elements.map((e) => `${e.type.replace('_', ' ')} at ${where(e.box)}.`),
  ].join(' ');
}
