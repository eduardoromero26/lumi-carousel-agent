import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hashtagList, Run } from './run.js';
import { directionId, noteId, tasteId, type Batch, type BatchFeedback, type LearningVote } from './learned.js';
import { calibration, featuresOf, tasteStats, type Judged, type Stat, type Verdict, type Vote } from './taste.js';
import { toneOf } from './design.js';
import { lookOf, type Look } from './variety.js';

// The index of every carousel for the feed: one row per run, with the post as the
// feed shows it (business, logo, slides, caption, reel) and the research behind it.
// run.json stays the source of truth; this table is what the feed reads in one query.
export const db = new DatabaseSync(path.join(config.runsDir, 'carousels.db'));
db.exec(`CREATE TABLE IF NOT EXISTS carousels (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  business TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  slides INTEGER NOT NULL,
  has_reel INTEGER NOT NULL,
  cost REAL NOT NULL,
  post TEXT NOT NULL
)`);

// The owner's votes: one per carousel, slide ("slide:2") or reel, with the design
// choices of what was voted, so the stats never depend on reloading old runs.
db.exec(`CREATE TABLE IF NOT EXISTS votes (
  run_id TEXT NOT NULL,
  target TEXT NOT NULL,
  value INTEGER NOT NULL,
  features TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (run_id, target)
)`);
// Added later: the owner's words on a vote and the critic's verdict when they voted.
const voteColumns = (db.prepare(`PRAGMA table_info(votes)`).all() as { name: string }[]).map((c) => c.name);
if (!voteColumns.includes('note')) db.exec(`ALTER TABLE votes ADD COLUMN note TEXT`);
if (!voteColumns.includes('critic')) db.exec(`ALTER TABLE votes ADD COLUMN critic TEXT`);
// 1 to 5 on a whole carousel. 4-5 count as a like, 1-2 as a dislike, 3 is kept with value 0
// and stays out of the taste and the critic's calibration.
if (!voteColumns.includes('stars')) db.exec(`ALTER TABLE votes ADD COLUMN stars INTEGER`);

export const starsValue = (stars: number) => (stars >= 4 ? 1 : stars <= 2 ? -1 : 0);

const upsert = db.prepare(`INSERT INTO carousels (id, status, business, url, created_at, updated_at, slides, has_reel, cost, post)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = excluded.status, business = excluded.business, url = excluded.url,
    updated_at = excluded.updated_at, slides = excluded.slides, has_reel = excluded.has_reel, cost = excluded.cost, post = excluded.post`);

export function saveCarousel(run: Run): void {
  const post = postOf(run);
  upsert.run(run.id, run.status, post.business, run.brief.url ?? null, post.createdAt, post.updatedAt, post.slides.length, post.reel ? 1 : 0, run.cost, JSON.stringify(post));
}

// The looks of the latest carousels, one per business, newest first. The same
// business counts too: making its carousel again tries something else, and the
// votes decide what stays.
export function recentLooks(exceptRun: string, limit = 6): Look[] {
  const rows = db.prepare(`SELECT id, post FROM carousels WHERE slides > 0 AND id != ? ORDER BY created_at DESC LIMIT 60`).all(exceptRun) as { id: string; post: string }[];
  const looks: Look[] = [];
  for (const row of rows) {
    const look = (JSON.parse(row.post) as { look?: Look }).look;
    if (look?.headingFont && !looks.some((l) => l.host === look.host)) looks.push(look.tone ? look : { ...look, ...groundOfRun(row.id) });
    if (looks.length === limit) break;
  }
  return looks;
}

export function recentReels(exceptRun: string, limit = 4): Look[] {
  const rows = db.prepare(`SELECT id, post FROM carousels WHERE slides > 0 AND id != ? ORDER BY created_at DESC LIMIT 300`).all(exceptRun) as { id: string; post: string }[];
  const reels: Look[] = [];
  for (const row of rows) {
    const look = (JSON.parse(row.post) as { look?: Look }).look;
    if (look?.hook) reels.push(look);
    if (reels.length === limit) break;
  }
  return reels;
}

// Looks saved before the ground was kept read it from the run.
function groundOfRun(id: string): Pick<Look, 'tone' | 'ground'> {
  try {
    const system = (JSON.parse(readFileSync(path.join(config.runsDir, id, 'run.json'), 'utf8')) as { system?: { base?: string; ground?: Look['ground'] } }).system;
    return system?.base ? { tone: toneOf(system.base), ground: system.ground ?? 'flat' } : {};
  } catch {
    return {};
  }
}

// Finished carousels, newest first, with the owner's votes.
export function listCarousels(): unknown[] {
  const rows = db.prepare(`SELECT id, post FROM carousels WHERE status = 'done' AND slides > 0 ORDER BY created_at DESC`).all() as { id: string; post: string }[];
  // A reel the owner asked for shows in the feed even with automatic reels off.
  return rows.map((r) => ({ ...JSON.parse(r.post), votes: votesOf(r.id), stars: starsOf(r.id) }));
}

// 1 likes, -1 dislikes, 0 takes the vote back; stars (on the carousel) set the value
// themselves. The note is what the owner says is wrong.
export function saveVote(run: Run, target: string, value: number, note?: string, stars?: number): void {
  if (stars !== undefined) value = starsValue(stars);
  else if (value === 0) {
    db.prepare(`DELETE FROM votes WHERE run_id = ? AND target = ?`).run(run.id, target);
    return;
  }
  const verdict = criticVerdict(run, target);
  db.prepare(
    `INSERT INTO votes (run_id, target, value, features, at, note, critic, stars) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, target) DO UPDATE SET value = excluded.value, features = excluded.features, at = excluded.at,
       note = excluded.note, critic = excluded.critic, stars = excluded.stars`,
  ).run(
    run.id,
    target,
    Math.sign(value),
    JSON.stringify(featuresOf(run, target)),
    new Date().toISOString(),
    note?.trim().slice(0, 600) || null,
    verdict ? JSON.stringify(verdict) : null,
    stars ?? null,
  );
}

export function starsOf(runId: string): number | null {
  const row = db.prepare(`SELECT stars FROM votes WHERE run_id = ? AND target = 'carousel'`).get(runId) as { stars: number | null } | undefined;
  return row?.stars ?? null;
}

// What the critic said when the owner voted: on a slide, whether the kept version was
// approved and its best score; on the carousel, every slide approved and the set's score.
function criticVerdict(run: Run, target: string): Verdict | undefined {
  if (target === 'carousel') {
    if (!run.slides.length) return undefined;
    const set = run.events.filter((e) => e.type === 'review' && e.agent === 'critic' && e.text.startsWith('The set')).at(-1);
    return { approved: run.slides.every((s) => s.approved), score: setScore(set?.data, set?.text) };
  }
  const n = target.startsWith('slide:') ? Number(target.slice(6)) : NaN;
  const slide = run.slides.find((s) => s.n === n);
  if (!slide) return undefined;
  const scores = run.events
    .filter((e) => e.type === 'review' && e.agent === 'critic' && e.slide === n)
    .map((e) => (e.data as { score?: unknown } | undefined)?.score)
    .filter((s): s is number => typeof s === 'number');
  return { approved: slide.approved, score: scores.length ? Math.max(...scores) : null };
}

// Every vote with what the critic said and the owner's words, newest first.
export function judgedVotes(): Judged[] {
  const rows = db
    .prepare(
      `SELECT v.run_id, v.target, v.value, v.note, v.critic, v.at, c.business FROM votes v
       LEFT JOIN carousels c ON c.id = v.run_id WHERE v.value != 0 ORDER BY v.at DESC`,
    )
    .all() as { run_id: string; target: string; value: number; note: string | null; critic: string | null; at: string; business: string | null }[];
  return rows.map((r) => ({
    runId: r.run_id,
    target: r.target,
    value: r.value > 0 ? 1 : -1,
    note: r.note,
    critic: r.critic ? (JSON.parse(r.critic) as Verdict) : null,
    at: r.at,
    business: r.business ?? undefined,
  }));
}

// The critic against the owner, and per queue batch the share of carousels the owner
// liked (4-5 stars or 👍) and the average stars: the quality a batch reached.
export function calibrationReport() {
  const votes = judgedVotes();
  const batches = db
    .prepare(
      `SELECT COALESCE(q.batch, 'made by hand') AS batch, COUNT(*) AS voted, SUM(v.value > 0) AS liked,
         AVG(v.stars) AS stars, COUNT(v.stars) AS rated FROM votes v
       LEFT JOIN queue q ON q.run_id = v.run_id WHERE v.target = 'carousel' GROUP BY 1 ORDER BY MAX(v.at) DESC`,
    )
    .all() as Batch[];
  return { ...calibration(votes), batches };
}

export function votesOf(runId: string): Record<string, number> {
  const rows = db.prepare(`SELECT target, value FROM votes WHERE run_id = ? AND value != 0`).all(runId) as { target: string; value: number }[];
  return Object.fromEntries(rows.map((r) => [r.target, r.value]));
}

// The owner's votes on what the agents learned (a card of the library: "taste:<key>=<value>",
// "note:<run>:<target>", "lesson:<kind>"). A dislike turns that lesson off, its note says why.
db.exec(`CREATE TABLE IF NOT EXISTS learning_votes (
  id TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  note TEXT,
  at TEXT NOT NULL
)`);

export function learningVotes(): Map<string, LearningVote> {
  const rows = db.prepare(`SELECT id, value, note FROM learning_votes`).all() as { id: string; value: number; note: string | null }[];
  return new Map(rows.map((r) => [r.id, { value: r.value > 0 ? 1 : -1, note: r.note }]));
}

export function saveLearningVote(id: string, value: number, note?: string): void {
  if (value === 0) {
    db.prepare(`DELETE FROM learning_votes WHERE id = ?`).run(id);
    return;
  }
  db.prepare(
    `INSERT INTO learning_votes (id, value, note, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, note = excluded.note, at = excluded.at`,
  ).run(id, value > 0 ? 1 : -1, note?.trim().slice(0, 600) || null, new Date().toISOString());
}

// The owner's verdict on a whole batch: its stars and, in their words, what every carousel
// should do from now on. Every agent reads the notes still on (Learned › Direction).
db.exec(`CREATE TABLE IF NOT EXISTS batch_feedback (
  batch TEXT PRIMARY KEY,
  stars INTEGER,
  note TEXT,
  at TEXT NOT NULL
)`);

export function batchFeedback(): BatchFeedback[] {
  return db.prepare(`SELECT batch, stars, note, at FROM batch_feedback ORDER BY at DESC`).all() as BatchFeedback[];
}

export function saveBatchFeedback(batch: string, stars: number | null, note: string | null): void {
  if (!stars && !note?.trim()) {
    db.prepare(`DELETE FROM batch_feedback WHERE batch = ?`).run(batch);
    return;
  }
  db.prepare(
    `INSERT INTO batch_feedback (batch, stars, note, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(batch) DO UPDATE SET stars = excluded.stars, note = excluded.note, at = excluded.at`,
  ).run(batch, stars && stars >= 1 && stars <= 5 ? Math.round(stars) : null, note?.trim().slice(0, 2000) || null, new Date().toISOString());
}

// For every agent's prompt: the owner's general direction still on, newest first.
export function describeDirections(limit = 6): string {
  const off = learningVotes();
  const notes = batchFeedback()
    .filter((f) => f.note && off.get(directionId(f.batch))?.value !== -1)
    .slice(0, limit);
  return notes.length
    ? `The business owner's direction for every carousel, from their verdict on whole batches (newest first; where two disagree, the newest wins). It comes before your own taste:\n${notes
        .map((f) => `- after batch "${f.batch}"${f.stars ? ` (${f.stars}/5 stars)` : ''}: "${f.note}"`)
        .join('\n')}`
    : '';
}

// Every vote, as the stats of each design choice.
export function rawTaste(): Stat[] {
  const rows = db.prepare(`SELECT value, features FROM votes WHERE value != 0`).all() as { value: number; features: string }[];
  return tasteStats(rows.map((r) => ({ value: r.value > 0 ? 1 : -1, features: JSON.parse(r.features) }) as Vote));
}

// What the agents use: without the conclusions the owner said are wrong.
export function taste(): Stat[] {
  const off = learningVotes();
  return rawTaste().filter((s) => off.get(tasteId(s))?.value !== -1);
}

// The owner's dislikes with their words, minus the ones the owner said were learned wrong.
export function criticLessons(): Judged[] {
  const off = learningVotes();
  return judgedVotes().filter((v) => off.get(noteId(v))?.value !== -1);
}

// What the owner said is wrong in the design conclusions, for the art director.
export function tasteCorrections(): string {
  return [...learningVotes()]
    .filter(([id, v]) => id.startsWith('taste:') && v.value < 0 && v.note)
    .map(([id, v]) => `- "${id.slice(6).replace('=', ' ')}": ${v.note}`)
    .join('\n');
}

// Fills the table from the runs already on disk, the first time and after a crash,
// and the critic's verdict on votes cast before it was kept.
export async function backfill(): Promise<void> {
  if (!existsSync(config.runsDir)) return;
  const unjudged = db.prepare(`SELECT target FROM votes WHERE run_id = ? AND critic IS NULL`);
  const judge = db.prepare(`UPDATE votes SET critic = ? WHERE run_id = ? AND target = ?`);
  for (const id of readdirSync(config.runsDir)) {
    if (!existsSync(path.join(config.runsDir, id, 'run.json'))) continue;
    const run = await Run.load(id).catch(() => undefined);
    if (!run) continue;
    saveCarousel(run);
    for (const { target } of unjudged.all(id) as { target: string }[]) {
      const verdict = criticVerdict(run, target);
      if (verdict) judge.run(JSON.stringify(verdict), id, target);
    }
  }
}

function postOf(run: Run) {
  const plan = run.plan;
  const at = (seq: number) => run.events.at(seq)?.at ?? new Date().toISOString();
  const updatedAt = at(-1);
  // Edited slides keep their file name: the version busts the browser's cache.
  const v = `?v=${Date.parse(updatedAt) || 0}`;
  const file = (name: string) => path.join(run.dir, name);
  const renders = path.join(run.dir, 'motion', 'renders');
  const set = run.events.filter((e) => e.type === 'review' && e.agent === 'critic' && e.text.startsWith('The set')).at(-1);
  const kinds: Record<string, number> = {};
  for (const a of run.assets) if (a.source !== 'upload') kinds[a.kind ?? 'other'] = (kinds[a.kind ?? 'other'] ?? 0) + 1;
  return {
    id: run.id,
    business: businessName(run),
    url: run.brief.url ?? null,
    logo: run.logo ? run.fileUrl(run.logo.path) : null,
    logoGround: run.logo?.matte ?? (run.logo && (run.logo.tone ?? 0) > 0.7 ? '#111111' : '#ffffff'),
    createdAt: at(0),
    updatedAt,
    cost: run.cost,
    language: run.brief.language ?? null,
    caption: plan?.caption ?? '',
    hashtags: hashtagList(plan?.hashtags),
    slides: run.slides.map((s) => ({
      n: s.n,
      url: run.fileUrl(file(s.file)) + v,
      approved: s.approved,
      headline: plan?.slides.find((p) => p.n === s.n)?.headline ?? '',
    })),
    look: lookOf(run),
    reel: existsSync(path.join(renders, 'reel.mp4')) ? run.fileUrl(path.join(renders, 'reel.mp4')) + v : null,
    reelCover: existsSync(path.join(renders, 'reel-cover.png')) ? run.fileUrl(path.join(renders, 'reel-cover.png')) + v : null,
    research: {
      siteTitle: run.site?.title ?? null,
      screens: (run.site?.screens ?? []).filter((s) => existsSync(s)).map((s) => run.fileUrl(s)),
      businessType: plan?.business_type ?? null,
      format: plan?.format ?? null,
      concept: plan?.concept ?? null,
      why: plan?.why ?? null,
      colors: run.system ? [run.system.base, run.system.ink, run.system.accent] : (run.brief.brandColors ?? []),
      fonts: run.system ? [run.system.headingFont, run.system.bodyFont] : [],
      siteFonts: run.site?.fonts ?? [],
      design: run.system?.siteNotes ?? run.system?.notes ?? null,
      assets: kinds,
      photos: run.photos.filter((p) => !p.backdrop).length,
      ownerPhotos: run.photos.filter((p) => p.note?.startsWith("the owner's photo")).length,
      setScore: setScore(set?.data, set?.text),
      approved: run.slides.filter((s) => s.approved).length,
    },
  };
}

function setScore(data: unknown, text?: string): number | null {
  const score = (data as { score?: unknown } | undefined)?.score;
  if (typeof score === 'number') return score;
  const m = text?.match(/\((\d+(?:\.\d+)?)\/10\)/);
  return m ? Number(m[1]) : null;
}

// The owner's name for the business, else the part of the site's title that
// matches its domain ("Home | Shiver Vertical" on shiververtical.com), else the
// longest run of words from the title or the logo that spells the domain
// ("Marion Bikes wordmark" on marionbikes.com).
function businessName(run: Run): string {
  if (run.brief.business?.trim()) return run.brief.business.trim();
  let host = '';
  try {
    host = new URL(run.brief.url ?? '').hostname.replace(/^www\./, '');
  } catch {}
  const flat = (s: string) => s.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const domain = flat(host.split('.')[0] ?? '');
  const title = run.site?.title ?? '';
  const parts = title.split(/\s[|·–—:-]\s|:\s/).map((s) => s.trim()).filter(Boolean);
  let best = '';
  let bestScore = 0;
  for (const part of parts) {
    const words = part.split(/\s+/).map(flat).filter((w) => w.length >= 3);
    if (!words.length) continue;
    const score = words.filter((w) => domain.includes(w)).length / words.length;
    if (score > bestScore) [best, bestScore] = [part, score];
  }
  if (bestScore >= 0.6) return best;
  let spelled = '';
  for (const text of [title, run.logo?.description ?? '', run.logo?.alt ?? '']) {
    let words: string[] = [];
    for (const word of [...text.split(/\s+/), '']) {
      if (word && flat(word).length >= 2 && domain.includes(flat(word))) words.push(word);
      else {
        if (words.join(' ').length > spelled.length) spelled = words.join(' ');
        words = [];
      }
    }
  }
  return spelled || best || parts[0] || host || 'Your business';
}
