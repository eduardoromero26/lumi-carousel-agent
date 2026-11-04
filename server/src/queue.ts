import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, learningVotes } from './db.js';
import { failureHistory, metricsOf, parseLessons, reportMarkdown, summarize, type HistoryRow, type QueueRow, type RunMetrics } from './metrics.js';
import type { Run } from './run.js';

// Websites waiting for their carousel, one run at a time, grouped in batches: run a
// batch, change a prompt, run the same websites again under a new name and compare.
db.exec(`CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  language TEXT,
  batch TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  added_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  metrics TEXT,
  note TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
// A run cut by a restart goes back to the line: the server is usually restarted to load a change.
db.exec(`UPDATE queue SET status = 'waiting', run_id = NULL, started_at = NULL WHERE status = 'running'`);

export type QueueItem = {
  id: number;
  url: string;
  language: string | null;
  batch: string;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
  runId: string | null;
  addedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metrics: RunMetrics | null;
  note: string | null;
};

type Row = { id: number; url: string; language: string | null; batch: string; status: QueueItem['status']; run_id: string | null; added_at: string; started_at: string | null; finished_at: string | null; metrics: string | null; note: string | null };

const itemOf = (r: Row): QueueItem => ({
  id: r.id,
  url: r.url,
  language: r.language,
  batch: r.batch,
  status: r.status,
  runId: r.run_id,
  addedAt: r.added_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  metrics: r.metrics ? (JSON.parse(r.metrics) as RunMetrics) : null,
  note: r.note,
});

export function normalizeUrl(raw: string): string | null {
  const text = raw.trim().replace(/[,;]+$/, '');
  if (!text || text.startsWith('#')) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.includes('.') ? url.toString() : null;
  } catch {
    return null;
  }
}

// Adds the websites to the batch; one already waiting in it is not added twice.
export function enqueue(urls: string[], language: string | undefined, batch: string): { added: number; skipped: number } {
  const waiting = new Set((db.prepare(`SELECT url FROM queue WHERE batch = ? AND status IN ('waiting', 'running')`).all(batch) as { url: string }[]).map((r) => r.url));
  const insert = db.prepare(`INSERT INTO queue (url, language, batch, status, added_at) VALUES (?, ?, ?, 'waiting', ?)`);
  let added = 0;
  let skipped = 0;
  for (const raw of urls) {
    const url = normalizeUrl(raw);
    if (!url || waiting.has(url)) {
      skipped++;
      continue;
    }
    waiting.add(url);
    insert.run(url, language ?? null, batch, new Date().toISOString());
    added++;
  }
  return { added, skipped };
}

// Lists kept on disk (server/lists/<name>.txt, one website per line), queued in blocks.
export function savedLists(): { name: string; urls: string[] }[] {
  const dir = path.resolve('lists');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => ({
      name: f.slice(0, -4),
      urls: readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).map(normalizeUrl).filter((u): u is string => !!u),
    }));
}

export function queueItems(limit = 500): QueueItem[] {
  return (db.prepare(`SELECT * FROM queue ORDER BY id DESC LIMIT ?`).all(limit) as Row[]).map(itemOf);
}

// The community's line: websites added from Create while another carousel was being made.
export const COMMUNITY = 'Community';

export function nextWaiting(batch?: string): QueueItem | undefined {
  const row = (
    batch
      ? db.prepare(`SELECT * FROM queue WHERE status = 'waiting' AND batch = ? ORDER BY id LIMIT 1`).get(batch)
      : db.prepare(`SELECT * FROM queue WHERE status = 'waiting' ORDER BY id LIMIT 1`).get()
  ) as Row | undefined;
  return row && itemOf(row);
}

// Its place in the community's line (1 = next).
export function communityPlace(url: string): number {
  const rows = db.prepare(`SELECT url FROM queue WHERE status = 'waiting' AND batch = ? ORDER BY id`).all(COMMUNITY) as { url: string }[];
  const i = rows.findIndex((r) => r.url === url);
  return i < 0 ? rows.length : i + 1;
}

export function isPaused(): boolean {
  return (db.prepare(`SELECT value FROM settings WHERE key = 'queue_paused'`).get() as { value: string } | undefined)?.value === '1';
}

export function setPaused(paused: boolean): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('queue_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(paused ? '1' : '0');
}

export function markRunning(id: number, runId: string): void {
  db.prepare(`UPDATE queue SET status = 'running', run_id = ?, started_at = ? WHERE id = ?`).run(runId, new Date().toISOString(), id);
}

export function markFinished(id: number, run: Run): void {
  const metrics = metricsOf(run);
  db.prepare(`UPDATE queue SET status = ?, finished_at = ?, metrics = ?, note = ? WHERE id = ?`).run(metrics.status, new Date().toISOString(), JSON.stringify(metrics), metrics.error ?? null, id);
  writeReport(batchOf(id));
}

// The run could not even start (a bad URL, the disk).
export function markFailed(id: number, note: string): void {
  db.prepare(`UPDATE queue SET status = 'failed', finished_at = ?, note = ? WHERE id = ?`).run(new Date().toISOString(), note, id);
  writeReport(batchOf(id));
}

// Only what hasn't started: a running one is stopped through its run.
export function removeWaiting(id?: number, batch?: string): number {
  if (id !== undefined) return Number(db.prepare(`DELETE FROM queue WHERE id = ? AND status = 'waiting'`).run(id).changes);
  if (batch !== undefined) return Number(db.prepare(`DELETE FROM queue WHERE batch = ? AND status = 'waiting'`).run(batch).changes);
  return Number(db.prepare(`DELETE FROM queue WHERE status = 'waiting'`).run().changes);
}

function batchOf(id: number): string {
  return (db.prepare(`SELECT batch FROM queue WHERE id = ?`).get(id) as { batch: string }).batch;
}

function rowsOf(batch: string): QueueRow[] {
  return (db.prepare(`SELECT * FROM queue WHERE batch = ? ORDER BY id`).all(batch) as Row[]).map((r) => {
    const item = itemOf(r);
    return { url: item.url, status: item.status, runId: item.runId, metrics: item.metrics, note: item.note };
  });
}

// Newest batch first.
export function batchSummaries() {
  const batches = db.prepare(`SELECT batch FROM queue GROUP BY batch ORDER BY MAX(id) DESC`).all() as { batch: string }[];
  return batches.map(({ batch }) => summarize(batch, rowsOf(batch)));
}

export function batchReport(batch: string): string {
  const rows = rowsOf(batch);
  return reportMarkdown(rows, summarize(batch, rows));
}

// A lesson the owner voted down keeps its text, with their words under it.
export function failuresReport(): string {
  const votes = learningVotes();
  const marked = new Map(
    [...lessons()].map(([kind, text]) => {
      const vote = votes.get(`lesson:${kind}`);
      return [kind, vote?.value === -1 ? `${text}\n\n**The owner says this did not fix it${vote.note ? `:** ${vote.note}` : '.**'}` : text];
    }),
  );
  return failureHistory(historyRows(), marked);
}

export function historyRows(): HistoryRow[] {
  return (db.prepare(`SELECT * FROM queue WHERE metrics IS NOT NULL ORDER BY id`).all() as Row[]).map((r): HistoryRow => {
    const item = itemOf(r);
    return { url: item.url, status: item.status, runId: item.runId, metrics: item.metrics, note: item.note, batch: item.batch, finishedAt: item.finishedAt };
  });
}

// docs/LESSONS.md: what fixed each kind of failure.
export function lessons(): Map<string, string> {
  const file = path.resolve('../docs/LESSONS.md');
  return parseLessons(existsSync(file) ? readFileSync(file, 'utf8') : '');
}

// Also on disk (runs/batches/<batch>.md and FAILURES.md), where an agent improving the prompts can read them.
function writeReport(batch: string): void {
  try {
    const dir = path.join(config.runsDir, 'batches');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${batch.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'batch'}.md`), batchReport(batch));
    writeFileSync(path.join(dir, 'FAILURES.md'), failuresReport());
  } catch (error) {
    console.error('Batch report:', (error as Error).message);
  }
}
