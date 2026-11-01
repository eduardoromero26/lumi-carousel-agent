import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db, learningVotes } from './db.js';
import type { Photo, Run } from './run.js';
import { hostOf } from './variety.js';

// Everything a run paid a model to make, kept apart from the run so it is never paid
// twice: the decor kits (Muse Image) and the subjects cut out (SAM). The owner votes the
// decor in Learned; a liked kit comes back for its brand, and other brands may take it
// by id; a photo a brand already had cut out is never sent to SAM again.
export type LibraryKind = 'texture' | 'element' | 'cutout';
export type LibraryItem = {
  id: string;
  kind: LibraryKind;
  // The Muse Image prompt, or what SAM cut out.
  prompt: string;
  file: string;
  host: string;
  business: string;
  type: string | null;
  personality: string | null;
  colors: string[];
  runId: string;
  // A cutout's source photo (a hash of its bytes, the same image on every run).
  source: string | null;
  grounded: boolean;
  at: string;
};

db.exec(`CREATE TABLE IF NOT EXISTS library (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  file TEXT NOT NULL,
  host TEXT NOT NULL,
  business TEXT NOT NULL,
  type TEXT,
  personality TEXT,
  colors TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source TEXT,
  grounded INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
)`);

export const libraryDir = path.join(config.runsDir, 'library');
export const libraryId = (item: Pick<LibraryItem, 'id'>) => `library:${item.id}`;
export const libraryUrl = (item: Pick<LibraryItem, 'file'>) => `/files/${path.relative(config.runsDir, item.file).split(path.sep).join('/')}`;

type Row = Omit<LibraryItem, 'colors' | 'grounded' | 'runId'> & { colors: string; grounded: number; run_id: string };
const toItem = (r: Row): LibraryItem => ({ ...r, colors: JSON.parse(r.colors) as string[], grounded: !!r.grounded, runId: r.run_id });

export function photoHash(file: string): string {
  return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 20);
}

// Copies a file the run made into the library, once.
export async function keep(
  run: Pick<Run, 'id' | 'brief' | 'site' | 'plan'>,
  kind: LibraryKind,
  prompt: string,
  file: string,
  extra: { type?: string; personality?: string; source?: string; grounded?: boolean } = {},
): Promise<LibraryItem> {
  const id = `${run.id}-${path.basename(file, path.extname(file))}`;
  const dest = path.join(libraryDir, kind, `${id}.png`);
  if (!existsSync(dest)) {
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(file, dest);
  }
  const item: LibraryItem = {
    id,
    kind,
    prompt,
    file: dest,
    host: hostOf(run.brief.url),
    business: run.site?.title || hostOf(run.brief.url) || 'a business',
    type: extra.type ?? run.plan?.business_type ?? null,
    personality: extra.personality ?? null,
    colors: run.brief.brandColors ?? [],
    runId: run.id,
    source: extra.source ?? null,
    grounded: !!extra.grounded,
    at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT OR IGNORE INTO library (id, kind, prompt, file, host, business, type, personality, colors, run_id, source, grounded, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(item.id, kind, prompt, dest, item.host, item.business, item.type, item.personality, JSON.stringify(item.colors), run.id, item.source, item.grounded ? 1 : 0, item.at);
  return item;
}

export function libraryItems(kind?: LibraryKind): LibraryItem[] {
  const rows = (kind ? db.prepare(`SELECT * FROM library WHERE kind = ? ORDER BY at DESC`).all(kind) : db.prepare(`SELECT * FROM library ORDER BY at DESC`).all()) as Row[];
  return rows.map(toItem).filter((i) => existsSync(i.file));
}

const voteOf = (item: LibraryItem) => learningVotes().get(libraryId(item))?.value;

// The brand's own liked piece of this kind, newest first.
export function brandKit(host: string, kind: 'texture' | 'element'): LibraryItem | undefined {
  return host ? libraryItems(kind).find((i) => i.host === host && voteOf(i) === 1) : undefined;
}

// A liked piece by id, for a brand that takes it from the library.
export function likedPiece(id: string, kind: 'texture' | 'element'): LibraryItem | undefined {
  const item = libraryItems(kind).find((i) => i.id === id);
  return item && voteOf(item) === 1 ? item : undefined;
}

// What the brand already had cut out of this very photo.
export function brandCutout(host: string, source: string, subject: string): LibraryItem | undefined {
  return libraryItems('cutout').find((i) => i.host === host && i.source === source && i.prompt === subject);
}

// For the art director: the decor the owner liked (to take by id or write alike) and
// disliked (with their words), other brands' first-hand.
export function describeDecorTaste(host: string, limit = 8): string {
  const votes = learningVotes();
  const voted = libraryItems()
    .filter((i) => i.kind !== 'cutout')
    .map((i) => ({ i, v: votes.get(libraryId(i)) }))
    .filter((x) => x.v);
  const liked = voted.filter((x) => x.v!.value === 1 && x.i.host !== host).slice(0, limit);
  const disliked = voted.filter((x) => x.v!.value === -1).slice(0, limit);
  return [
    liked.length
      ? `Decor the owner liked on other brands. Take one as it is ("reuseTexture" / "reuseElement": its id) only when its colors and world fit this brand; otherwise write yours in the same spirit:\n${liked
          .map(({ i }) => `- ${i.id} (${i.kind}, ${i.type ?? 'business'}, colors ${i.colors.join(' ') || 'unknown'}): ${i.prompt}`)
          .join('\n')}`
      : '',
    disliked.length
      ? `Decor the owner disliked (never write it like this):\n${disliked.map(({ i, v }) => `- ${i.kind}: ${i.prompt}${v!.note ? ` (their words: "${v!.note}")` : ''}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// What runs made before the library existed: their decor kits and SAM cutouts.
export async function backfillLibrary(): Promise<number> {
  if (!existsSync(config.runsDir)) return 0;
  const known = new Set((db.prepare(`SELECT run_id FROM library`).all() as { run_id: string }[]).map((r) => r.run_id));
  let added = 0;
  for (const id of readdirSync(config.runsDir)) {
    const json = path.join(config.runsDir, id, 'run.json');
    if (known.has(id) || !existsSync(json)) continue;
    const run = JSON.parse(readFileSync(json, 'utf8')) as Run;
    const decor = run.system?.decor;
    const extra = { personality: run.system?.personality, type: run.plan?.business_type };
    for (const [kind, prompt, file] of [
      ['texture', decor?.texture, decor?.textureFile],
      ['element', decor?.element, decor?.elementFile],
    ] as const) {
      // A piece taken from the library is already there.
      if (!prompt || !file || decor?.reuse?.[kind] || !existsSync(file)) continue;
      await keep(run, kind, prompt, file, extra);
      added++;
    }
    for (const cut of (run.photos ?? []) as Photo[]) {
      const from = run.photos.find((p) => `${p.id}c` === cut.id);
      const subject = cut.note?.match(/^(.*) cut out by SAM/)?.[1];
      if (!cut.cutout || !from || !subject || !existsSync(cut.path) || !existsSync(from.path)) continue;
      await keep(run, 'cutout', subject, cut.path, { ...extra, source: photoHash(from.path), grounded: cut.grounded });
      added++;
    }
  }
  return added;
}
