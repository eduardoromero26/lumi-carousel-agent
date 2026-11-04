import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { db } from './db.js';
import { COMPOSITIONS, groundOf, inBrandTone, luminance, readableOn, toneOf, type Composition, type DesignSystem } from './design.js';
import { chatJson, imagePart } from './llm.js';
import type { Plan, Run } from './run.js';
import { PERSONALITIES, placeLogo, type Personality } from './variety.js';
import { REFERENCE_READER } from './agents/prompts.js';
import { normalizeLayout, type RefLayout, type Zone } from './layout.js';

// The style gallery: designs the owner picks as the look of a carousel, uploaded (other
// studios' work: only its abstract parameters are used, never the image on a slide) or
// promoted from the agency's own carousels the owner loved. The templates stay the
// same; a reference decides which of their choices the art director takes.
export type RefStyle = {
  composition: Composition;
  // The ground: a light neutral, a dark one, or a deep or pastel tone of the brand.
  ground: 'light' | 'dark' | 'brand';
  colorSlides: DesignSystem['colorSlides'];
  typeScale: DesignSystem['typeScale'];
  headlineCase: DesignSystem['headlineCase'];
  align: DesignSystem['align'];
  products: DesignSystem['products'];
  device: DesignSystem['device'];
  personality: Personality;
  decor: boolean;
  emphasis: boolean;
  // What makes it look like this, in words a designer can reuse with another brand.
  notes: string;
  // Its plan, box by box (layout.ts): the renderer rebuilds it with the brand's photo and words.
  layout?: RefLayout;
};

export type Reference = { id: string; title: string; file: string; source: 'upload' | 'carousel'; runId: string | null; style: RefStyle; at: string };

db.exec(`CREATE TABLE IF NOT EXISTS refs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT,
  style TEXT NOT NULL,
  at TEXT NOT NULL
)`);

// Next to the library, so the backup that copies it keeps the gallery too.
const refsDir = path.join(config.runsDir, 'library', 'reference');
export const referenceUrl = (ref: Pick<Reference, 'file'>) => `/files/${path.relative(config.runsDir, ref.file).split(path.sep).join('/')}`;

type Row = { id: string; title: string; file: string; source: 'upload' | 'carousel'; run_id: string | null; style: string; at: string };
const toRef = (r: Row): Reference => ({ id: r.id, title: r.title, file: r.file, source: r.source, runId: r.run_id, style: JSON.parse(r.style) as RefStyle, at: r.at });

export function references(): Reference[] {
  return (db.prepare(`SELECT * FROM refs ORDER BY at DESC`).all() as Row[]).map(toRef).filter((r) => existsSync(r.file));
}

export function reference(id: string | undefined): Reference | undefined {
  if (!id) return undefined;
  const row = db.prepare(`SELECT * FROM refs WHERE id = ?`).get(id) as Row | undefined;
  return row && existsSync(row.file) ? toRef(row) : undefined;
}

function save(ref: Reference): Reference {
  db.prepare(`INSERT OR REPLACE INTO refs (id, title, file, source, run_id, style, at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ref.id, ref.title, ref.file, ref.source, ref.runId, JSON.stringify(ref.style), ref.at);
  return ref;
}

export async function deleteReference(id: string): Promise<boolean> {
  const ref = reference(id);
  if (!ref) return false;
  db.prepare(`DELETE FROM refs WHERE id = ?`).run(id);
  await rm(ref.file, { force: true });
  return true;
}

const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

// The reader's answer made safe: only choices the templates have.
export function normalizeStyle(raw: Partial<Record<keyof RefStyle, unknown>>): RefStyle {
  return {
    composition: pick(raw.composition, COMPOSITIONS, 'window'),
    ground: pick(raw.ground, ['light', 'dark', 'brand'] as const, 'light'),
    colorSlides: pick(raw.colorSlides, ['none', 'cover', 'cta', 'both'] as const, 'none'),
    typeScale: pick(raw.typeScale, ['calm', 'loud'] as const, 'loud'),
    headlineCase: pick(raw.headlineCase, ['as_is', 'upper'] as const, 'as_is'),
    align: pick(raw.align, ['center', 'left'] as const, 'center'),
    products: pick(raw.products, ['card', 'loose'] as const, 'loose'),
    // No device in the reference: the pill only shows on the cover's label.
    device: raw.device === 'underline' ? 'underline' : 'pill_label',
    personality: pick(raw.personality, PERSONALITIES, 'clean'),
    decor: raw.decor === true,
    emphasis: raw.emphasis !== false,
    notes: typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 600) : '',
    layout: normalizeLayout(raw.layout),
  };
}

async function readStyle(file: string): Promise<RefStyle> {
  const thumb = await sharp(file).resize(900, 900, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  const raw = await chatJson<Partial<Record<keyof RefStyle, unknown>>>([
    { role: 'system', content: REFERENCE_READER },
    { role: 'user', content: [{ type: 'text', text: 'The reference design:' }, imagePart(thumb.toString('base64'), 'image/jpeg')] },
  ]);
  const style = normalizeStyle(raw);
  // The ground's bands come from the pixels: the model said "brand" for a two-tone ground.
  const zones = await measureZones(file);
  if (style.layout && zones.length > 1) style.layout.zones = zones;
  return style;
}

const hexOf = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const average = (rows: number[][]) => [0, 1, 2].map((c) => rows.reduce((t, r) => t + r[c], 0) / Math.max(1, rows.length));
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

// The ground in horizontal bands, from the design's side strips (where text and products
// seldom reach), row by row: one clear jump between two steady colors is a two-tone
// ground; otherwise one band. Each strip is tried alone: a ghost letter can cross one.
export async function measureZones(file: string): Promise<Zone[]> {
  const { data, info } = await sharp(file).resize(40, 100, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const strip = (xs: number[]) =>
    Array.from({ length: info.height }, (_, y) => [0, 1, 2].map((c) => median(xs.map((x) => data[(y * info.width + x) * 3 + c]))));
  let best: { at: number; jump: number; top: number[]; bottom: number[] } | undefined;
  for (const rows of [strip([0, 1, 2]), strip([info.width - 3, info.width - 2, info.width - 1])]) {
    for (let at = 15; at <= 85; at++) {
      const above = rows.slice(3, at - 2);
      const below = rows.slice(at + 2, info.height - 3);
      const top = average(above);
      const bottom = average(below);
      // Steady: most rows of each side close to its own color.
      const steady = (side: number[][], c: number[]) => side.filter((r) => distance(r, c) < 28).length / side.length >= 0.85;
      const jump = distance(top, bottom);
      if (jump >= 55 && steady(above, top) && steady(below, bottom) && (!best || jump > best.jump)) best = { at, jump, top, bottom };
    }
  }
  if (!best) return [{ y1: 0, y2: 1, hex: hexOf(average(strip([0, 1, 2, info.width - 3, info.width - 2, info.width - 1]))) }];
  return [
    { y1: 0, y2: best.at / 100, hex: hexOf(best.top) },
    { y1: best.at / 100, y2: 1, hex: hexOf(best.bottom) },
  ];
}

// Reads an uploaded reference again (after the reader learned something new, like its layout).
export async function rereadReference(id: string): Promise<Reference | undefined> {
  const ref = reference(id);
  if (!ref || ref.source !== 'upload') return ref;
  return save({ ...ref, style: await readStyle(ref.file) });
}

// An uploaded design: kept as a JPEG and read once by a vision model.
export async function addReference(base64: string, title: string): Promise<Reference> {
  const id = randomUUID().slice(0, 8);
  const file = path.join(refsDir, `${id}.jpg`);
  await mkdir(refsDir, { recursive: true });
  const image = await sharp(Buffer.from(base64, 'base64')).rotate().flatten({ background: '#ffffff' }).resize(1400, 1400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  await writeFile(file, image);
  return save({ id, title: title.trim().slice(0, 80) || 'Reference', file, source: 'upload', runId: null, style: await readStyle(file), at: new Date().toISOString() });
}

// One of the agency's own carousels: its style is its visual system, exactly.
export async function referenceFromRun(run: Run): Promise<Reference> {
  const system = run.system;
  const first = [...run.slides].sort((a, b) => a.n - b.n)[0];
  if (!system || !first) throw new Error('The carousel has no visual system or slides yet');
  const cover = path.join(run.dir, first.file);
  const id = `run-${run.id}`;
  const file = path.join(refsDir, `${id}.png`);
  await mkdir(refsDir, { recursive: true });
  await copyFile(cover, file);
  const light = luminance(system.base);
  return save({
    id,
    title: run.site?.title?.split(/[|\-–]/)[0].trim().slice(0, 80) || run.brief.business || 'Our carousel',
    file,
    source: 'carousel',
    runId: run.id,
    style: {
      composition: system.composition,
      ground: light >= 0.6 ? 'light' : light <= 0.08 ? 'dark' : 'brand',
      colorSlides: system.colorSlides,
      typeScale: system.typeScale,
      headlineCase: system.headlineCase,
      align: system.align,
      products: system.products,
      device: system.device,
      personality: system.personality ?? 'clean',
      decor: !!(system.decor?.textureFile || system.decor?.elementFile),
      emphasis: !!run.plan?.slides.some((s) => s.emphasis),
      notes: system.notes,
    },
    at: new Date().toISOString(),
  });
}

export function describeReference(ref: Reference, by: 'owner' | 'agent' = 'owner'): string {
  const s = ref.style;
  return [
    by === 'agent'
      ? `You picked this reference from the agency's library for this carousel's style. Follow its style closely with this brand's own colors, logo and photos; never its words, brand or image.`
      : `The owner chose a reference for this carousel's style (${ref.source === 'carousel' ? 'one of our own carousels they loved' : "another studio's design they like"}). Follow its style closely with this brand's own colors, logo and photos; never its words, brand or image.`,
    `Its choices: composition "${s.composition}", ${s.ground === 'light' ? 'a light neutral ground' : s.ground === 'dark' ? 'a dark ground' : "a deep or pastel tone of the brand's color as the ground"}, color blocks "${s.colorSlides}", ${s.typeScale} type, headlines ${s.headlineCase === 'upper' ? 'in capitals' : 'as written'}, aligned ${s.align}, products ${s.products === 'loose' ? 'loose on the ground' : 'on cards'}, device "${s.device}", personality ${s.personality}, ${s.decor ? 'with a decor piece' : 'no decor'}${s.emphasis ? ', a key word of each headline in the accent' : ''}.`,
    s.notes ? `What makes it look like this: ${s.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const tint = (a: string, b: string, t: number) => {
  const c = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(c(a, i) * (1 - t) + c(b, i) * t).toString(16).padStart(2, '0')).join('');
};

// After the art director and the variety rules: the reference wins on every choice it
// makes, the brand keeps its colors. Returns what changed, for the run's log.
export function applyReference(system: DesignSystem, plan: Plan, ref: Reference, brandColors: string[] = [], { boxes = true } = {}): string[] {
  const s = ref.style;
  const changes: string[] = [];
  const set = <K extends keyof DesignSystem>(key: K, value: DesignSystem[K], label: string) => {
    if (system[key] === value) return;
    changes.push(`${label} ${String(system[key])} → ${String(value)}`);
    system[key] = value;
  };
  set('composition', s.composition, 'composition');
  if (s.layout && boxes) {
    system.layout = s.layout;
    changes.push('photo slides laid out after the reference, box by box');
  }
  set('colorSlides', s.colorSlides, 'color blocks');
  set('typeScale', s.typeScale, 'type');
  set('headlineCase', s.headlineCase, 'case');
  set('align', s.align, 'alignment');
  set('products', s.products, 'products');
  set('personality', s.personality, 'personality');
  set('device', s.device === 'pill_label' && !plan.slides[0]?.eyebrow ? 'underline' : s.device, 'device');
  const light = luminance(system.base);
  const colors = [...brandColors, system.accent];
  // "brand": the deep tone of the brand (navy for Delgado), never a pale tint of its accent.
  const brand = () => (toneOf(system.base) === 'deep' || toneOf(system.base) === 'pastel' ? system.base : groundOf('deep', colors));
  // Only where the ground shows: under a full-bleed photo the bands are the photo's own.
  const zones = boxes && s.layout?.zones && s.layout.zones.length > 1 && s.layout.photo.mode !== 'full' ? s.layout.zones : undefined;
  // Two tones: each band of the reference in the brand's colors; the text's ground is the
  // band where the headline sits.
  if (zones) {
    system.zones = zones.map((z) => ({ y1: z.y1, y2: z.y2, color: inBrandTone(z.hex, colors) }));
    const head = s.layout?.blocks.find((b) => b.role === 'headline') ?? s.layout?.blocks[0];
    const y = head ? (head.box.y1 + head.box.y2) / 2 : 0.25;
    changes.push(`ground in ${zones.length} bands: ${system.zones.map((z) => z.color).join(' over ')}`);
    const under = system.zones.find((z) => y >= z.y1 && y < z.y2) ?? system.zones[0];
    system.base = under.color;
    system.ink = readableOn(under.color, system.ink);
    system.ground = 'flat';
    system.ground2 = undefined;
  } else system.zones = undefined;
  const base = zones
    ? system.base
    : s.ground === 'light' && light < 0.75
      ? tint('#ffffff', system.accent, 0.05)
      : s.ground === 'dark' && light > 0.06
        ? tint('#111111', system.accent, 0.12)
        : s.ground === 'brand'
          ? brand()
          : system.base;
  if (base !== system.base) {
    changes.push(`ground ${system.base} → ${base}`);
    system.base = base;
    system.ink = readableOn(base, system.ink);
    system.ground = 'flat';
    system.ground2 = undefined;
  }
  if (!s.decor && system.decor) {
    changes.push('no decor');
    system.decor = undefined;
  }
  if (!s.emphasis) for (const slide of plan.slides) slide.emphasis = undefined;
  changes.push(...placeLogo(system));
  return changes;
}
