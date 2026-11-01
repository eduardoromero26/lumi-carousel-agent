import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hashtagList, Run } from './run.js';
import { featuresOf, tasteStats, type Stat, type Vote } from './taste.js';
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
  const rows = db.prepare(`SELECT post FROM carousels WHERE slides > 0 AND id != ? ORDER BY created_at DESC LIMIT 60`).all(exceptRun) as { post: string }[];
  const looks: Look[] = [];
  for (const row of rows) {
    const look = (JSON.parse(row.post) as { look?: Look }).look;
    if (look?.headingFont && !looks.some((l) => l.host === look.host)) looks.push(look);
    if (looks.length === limit) break;
  }
  return looks;
}

// Finished carousels, newest first, with the owner's votes.
export function listCarousels(): unknown[] {
  const rows = db.prepare(`SELECT id, post FROM carousels WHERE status = 'done' AND slides > 0 ORDER BY created_at DESC`).all() as { id: string; post: string }[];
  return rows.map((r) => ({ ...JSON.parse(r.post), ...(config.reels ? {} : { reel: null, reelCover: null }), votes: votesOf(r.id) }));
}

// 1 likes, -1 dislikes, 0 takes the vote back.
export function saveVote(run: Run, target: string, value: number): void {
  if (value === 0) {
    db.prepare(`DELETE FROM votes WHERE run_id = ? AND target = ?`).run(run.id, target);
    return;
  }
  db.prepare(
    `INSERT INTO votes (run_id, target, value, features, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, target) DO UPDATE SET value = excluded.value, features = excluded.features, at = excluded.at`,
  ).run(run.id, target, value > 0 ? 1 : -1, JSON.stringify(featuresOf(run, target)), new Date().toISOString());
}

export function votesOf(runId: string): Record<string, number> {
  const rows = db.prepare(`SELECT target, value FROM votes WHERE run_id = ?`).all(runId) as { target: string; value: number }[];
  return Object.fromEntries(rows.map((r) => [r.target, r.value]));
}

// Every vote, as the stats of each design choice.
export function taste(): Stat[] {
  const rows = db.prepare(`SELECT value, features FROM votes`).all() as { value: number; features: string }[];
  return tasteStats(rows.map((r) => ({ value: r.value > 0 ? 1 : -1, features: JSON.parse(r.features) }) as Vote));
}

// Fills the table from the runs already on disk, the first time and after a crash.
export async function backfill(): Promise<void> {
  if (!existsSync(config.runsDir)) return;
  for (const id of readdirSync(config.runsDir)) {
    if (!existsSync(path.join(config.runsDir, id, 'run.json'))) continue;
    const run = await Run.load(id).catch(() => undefined);
    if (run) saveCarousel(run);
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
