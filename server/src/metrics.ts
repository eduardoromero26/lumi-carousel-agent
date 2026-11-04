import type { Run } from './run.js';

// What one run says about the agents: how far the slides got without help, which
// critic checks failed, what the lint measured and what it cost. A batch of runs on
// many websites, before and after a change to a prompt or a template, shows if it helped.
export type RunMetrics = {
  status: 'done' | 'failed' | 'stopped';
  minutes: number;
  cost: number;
  slides: number;
  approved: number;
  // Approved in the first round, with no fix.
  firstPass: number;
  rounds: number;
  setScore: number | null;
  // Measured, not judged: how each slide came out in order, whether the middle ones share
  // that skeleton, and the slides that reuse another slide's photo.
  skeletons?: string[];
  oneSkeleton?: boolean;
  repeatedPhotos?: number;
  // Times each critic check answered "no", and each kind of lint problem, over every round.
  checks: Record<string, number>;
  lint: Record<string, number>;
  templateIssues: number;
  photos: number;
  format?: string;
  error?: string;
  // What failed, in the agents' own words: the evidence to fix it from.
  examples?: FailureExample[];
};

// kind: "check:padding", "lint:elements overlap" or "error".
export type FailureExample = { kind: string; slide?: number; note: string };

// The lint's messages name the element and its coordinates: grouped by kind.
const LINT_KINDS: [RegExp, string][] = [
  [/overlaps the photo card/, 'text overlaps the photo card'],
  [/covers a face/, 'covers a face'],
  [/cut by the edge/, 'subject cut by the edge'],
  [/^the text covers/, 'text covers the subject'],
  [/^the logo covers/, 'logo covers the subject'],
  [/ overlaps /, 'elements overlap'],
  [/too close to the slide's edge/, 'too close to the edge'],
  [/off-center/, 'off-center'],
  [/not on the left margin/, 'off the left margin'],
];

export function lintKind(message: string): string {
  return LINT_KINDS.find(([re]) => re.test(message))?.[1] ?? message.replace(/\(.*?\)/g, '').trim().slice(0, 60);
}

type ReviewData = { approved?: boolean; score?: number; issues?: string[]; checks?: Record<string, { answer?: string; note?: string }> };

// The cover and the call to action may stand apart; the slides between them may not.
export function consistencyOf(run: Run): Pick<RunMetrics, 'skeletons' | 'oneSkeleton' | 'repeatedPhotos'> {
  const last = new Map<number, string>();
  for (const e of run.events) {
    const shape = (e.data as { shape?: string } | undefined)?.shape;
    if (e.slide !== undefined && shape && e.text.startsWith('Built from the')) last.set(e.slide, shape);
  }
  const skeletons = run.slides.map((s) => last.get(s.n) ?? '?');
  const middle = skeletons.slice(1, -1).filter((s) => s !== '?');
  const photos = (run.plan?.slides ?? []).flatMap((s) => (s.photo ? [s.photo] : []));
  return {
    skeletons,
    oneSkeleton: middle.length < 2 || middle.every((s) => s === middle[0]),
    repeatedPhotos: photos.length - new Set(photos).size,
  };
}

export function metricsOf(run: Run): RunMetrics {
  const checks: Record<string, number> = {};
  const lint: Record<string, number> = {};
  const examples: FailureExample[] = [];
  const example = (kind: string, slide: number | undefined, note: string) => {
    if (!examples.some((x) => x.kind === kind && x.slide === slide)) examples.push({ kind, slide, note: note.slice(0, 240) });
  };
  let setScore: number | null = null;
  for (const e of run.events) {
    if (e.type !== 'review' || e.agent !== 'critic') continue;
    const data = e.data as ReviewData | undefined;
    if (e.text.startsWith('The set')) {
      if (typeof data?.score === 'number') setScore = data.score;
      continue;
    }
    if (!e.slide || !data) continue;
    for (const issue of data.issues ?? []) {
      if (issue.startsWith('measured: ')) {
        const kind = lintKind(issue.slice('measured: '.length));
        lint[kind] = (lint[kind] ?? 0) + 1;
        example(`lint:${kind}`, e.slide, issue.slice('measured: '.length));
      }
    }
    for (const [key, answer] of Object.entries(data.checks ?? {})) {
      if (answer?.answer !== 'no') continue;
      checks[key] = (checks[key] ?? 0) + 1;
      example(`check:${key}`, e.slide, answer.note ?? 'no');
    }
  }
  const error = run.events.findLast((e) => e.type === 'error')?.text;
  if (error && run.status !== 'done' && error !== 'Stopped by the owner.') example('error', undefined, error);
  const first = Date.parse(run.events[0]?.at ?? '');
  const last = Date.parse(run.events.at(-1)?.at ?? '');
  return {
    status: run.status === 'done' ? 'done' : error === 'Stopped by the owner.' ? 'stopped' : 'failed',
    minutes: Number.isFinite(first) && Number.isFinite(last) ? Math.round(((last - first) / 60000) * 10) / 10 : 0,
    cost: Math.round(run.cost * 1000) / 1000,
    slides: run.slides.length,
    approved: run.slides.filter((s) => s.approved).length,
    firstPass: run.slides.filter((s) => s.approved && s.rounds === 1).length,
    rounds: run.slides.reduce((sum, s) => sum + s.rounds, 0),
    setScore,
    ...consistencyOf(run),
    checks,
    lint,
    templateIssues: run.slides.reduce((sum, s) => sum + (s.templateIssues?.length ?? 0), 0),
    photos: run.photos.length,
    format: run.plan?.format,
    error: run.status === 'done' ? undefined : error,
    examples: examples.slice(0, 20),
  };
}

export type QueueRow = { url: string; status: string; runId: string | null; metrics: RunMetrics | null; note: string | null };

export type BatchSummary = {
  batch: string;
  total: number;
  waiting: number;
  running: number;
  done: number;
  failed: number;
  stopped: number;
  setScore: number | null;
  // Of the carousels measured: one skeleton in the middle, and the ones that repeat a photo.
  oneSkeletonPct: number | null;
  repeatedPhotoRuns: number;
  approvedPct: number | null;
  firstPassPct: number | null;
  roundsPerSlide: number | null;
  avgCost: number | null;
  totalCost: number;
  avgMinutes: number | null;
  checks: [string, number][];
  lint: [string, number][];
  errors: [string, number][];
};

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
const avg = (values: number[], digits = 1) => (values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, digits) : null);
const top = (counts: Record<string, number>, n = 6): [string, number][] =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

export function summarize(batch: string, rows: QueueRow[]): BatchSummary {
  const finished = rows.flatMap((r) => (r.metrics ? [r.metrics] : []));
  const done = finished.filter((m) => m.status === 'done');
  const slides = done.reduce((sum, m) => sum + m.slides, 0);
  // Runs recorded before the measure have no skeletons: they don't count either way.
  const measured = done.filter((m) => m.oneSkeleton !== undefined);
  const checks: Record<string, number> = {};
  const lint: Record<string, number> = {};
  const errors: Record<string, number> = {};
  for (const m of finished) {
    for (const [k, v] of Object.entries(m.checks)) checks[k] = (checks[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.lint)) lint[k] = (lint[k] ?? 0) + v;
    if (m.status === 'failed' && m.error) errors[m.error.slice(0, 80)] = (errors[m.error.slice(0, 80)] ?? 0) + 1;
  }
  for (const r of rows) if (r.status === 'failed' && !r.metrics && r.note) errors[r.note.slice(0, 80)] = (errors[r.note.slice(0, 80)] ?? 0) + 1;
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return {
    batch,
    total: rows.length,
    waiting: count('waiting'),
    running: count('running'),
    done: count('done'),
    failed: count('failed'),
    stopped: count('stopped'),
    setScore: avg(done.flatMap((m) => (m.setScore === null ? [] : [m.setScore]))),
    oneSkeletonPct: measured.length ? Math.round((100 * measured.filter((m) => m.oneSkeleton).length) / measured.length) : null,
    repeatedPhotoRuns: done.filter((m) => (m.repeatedPhotos ?? 0) > 0).length,
    approvedPct: slides ? Math.round((100 * done.reduce((sum, m) => sum + m.approved, 0)) / slides) : null,
    firstPassPct: slides ? Math.round((100 * done.reduce((sum, m) => sum + m.firstPass, 0)) / slides) : null,
    roundsPerSlide: slides ? round(done.reduce((sum, m) => sum + m.rounds, 0) / slides, 2) : null,
    avgCost: avg(
      done.map((m) => m.cost),
      3,
    ),
    totalCost: round(
      finished.reduce((sum, m) => sum + m.cost, 0),
      2,
    ),
    avgMinutes: avg(done.map((m) => m.minutes)),
    checks: top(checks),
    lint: top(lint),
    errors: top(errors, 5),
  };
}

// The batch as Markdown: what to read (or hand to an agent) before changing a prompt.
export function reportMarkdown(rows: QueueRow[], summary: BatchSummary): string {
  const s = summary;
  const list = (pairs: [string, number][]) => (pairs.length ? pairs.map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- none');
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '/').replace(/\n/g, ' '));
  const lines = [
    `# Batch: ${s.batch}`,
    '',
    `${s.total} websites · ${s.done} done · ${s.failed} failed · ${s.stopped} stopped · ${s.waiting + s.running} to go`,
    '',
    `- Set score (avg): ${s.setScore ?? '-'}/10`,
    `- One skeleton in the middle slides: ${s.oneSkeletonPct ?? '-'} % · carousels that repeat a photo: ${s.repeatedPhotoRuns}`,
    `- Slides approved: ${s.approvedPct ?? '-'} %, first pass: ${s.firstPassPct ?? '-'} %, rounds per slide: ${s.roundsPerSlide ?? '-'}`,
    `- Cost per carousel: US$${s.avgCost ?? '-'} (total US$${s.totalCost}), minutes per carousel: ${s.avgMinutes ?? '-'}`,
    '',
    '## Critic checks that failed most',
    list(s.checks),
    '',
    '## Lint problems',
    list(s.lint),
    '',
    '## Errors',
    list(s.errors),
    '',
    '## Runs',
    '',
    '| Website | Status | Set | Skeletons | Approved | First pass | Rounds | US$ | Min | Format | Notes | Run |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => {
      const m = r.metrics;
      const notes = m ? (m.error ?? top({ ...m.checks, ...m.lint }, 3).map(([k, v]) => `${k} ×${v}`).join(', ')) : r.note;
      const skeletons = m?.skeletons ? `${m.skeletons.join(' ')}${m.oneSkeleton ? '' : ' ✗'}${m.repeatedPhotos ? ` · ${m.repeatedPhotos} repeated photo(s)` : ''}` : '';
      return `| ${cell(r.url)} | ${r.status} | ${cell(m?.setScore)} | ${cell(skeletons)} | ${m ? `${m.approved}/${m.slides}` : ''} | ${cell(m?.firstPass)} | ${cell(m?.rounds)} | ${cell(m?.cost)} | ${cell(m?.minutes)} | ${cell(m?.format)} | ${cell(notes)} | ${cell(r.runId)} |`;
    }),
    '',
  ];
  return lines.join('\n');
}

// What fixed each kind of failure before, from docs/LESSONS.md: "## <kind>" and its text.
export function parseLessons(markdown: string): Map<string, string> {
  const lessons = new Map<string, string>();
  for (const section of markdown.split(/^## /m).slice(1)) {
    const [head, ...body] = section.split('\n');
    const text = body.join('\n').trim();
    if (head.trim() && text) lessons.set(head.trim(), text);
  }
  return lessons;
}

export type HistoryRow = QueueRow & { batch: string; finishedAt: string | null };

// Every failure seen in any batch, most frequent first: how often per carousel in
// each batch (did the last change help?), the latest examples and what fixed it before.
export function failureHistory(rows: HistoryRow[], lessons: Map<string, string>): string {
  const { finished, runsPerBatch, kinds } = failureKinds(rows);
  const lines = ['# Failure history', '', `${finished.length} finished runs in ${Object.keys(runsPerBatch).length} batches. Rates are per carousel. What fixed a failure goes in docs/LESSONS.md under "## <kind>".`, ''];
  for (const [kind, k] of [...kinds].sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`## ${kind} (${k.total})`, '');
    for (const [b, n] of Object.entries(k.perBatch)) lines.push(`- ${b}: ${round(n / runsPerBatch[b], 2)} per carousel (${n} in ${runsPerBatch[b]} runs)`);
    const lesson = lessons.get(kind);
    lines.push('', `**Fixed before:** ${lesson ?? 'nothing yet'}`, '', 'Latest examples:');
    for (const x of k.examples.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)) {
      lines.push(`- ${x.url}${x.slide ? ` slide ${x.slide}` : ''} (run ${x.runId}, ${x.batch}): ${x.note.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Each failure kind with how often it happened, in all and per batch, and its examples.
export function failureKinds(rows: HistoryRow[]) {
  const finished = rows.filter((r) => r.metrics);
  const runsPerBatch: Record<string, number> = {};
  for (const r of finished) runsPerBatch[r.batch] = (runsPerBatch[r.batch] ?? 0) + 1;
  type Example = FailureExample & { batch: string; url: string; runId: string | null; at: string };
  const kinds = new Map<string, { total: number; perBatch: Record<string, number>; examples: Example[] }>();
  for (const r of finished) {
    const m = r.metrics!;
    const counts: [string, number][] = [
      ...Object.entries(m.checks).map(([k, v]): [string, number] => [`check:${k}`, v]),
      ...Object.entries(m.lint).map(([k, v]): [string, number] => [`lint:${k}`, v]),
      ...(m.status === 'failed' ? [['error', 1] as [string, number]] : []),
    ];
    for (const [kind, n] of counts) {
      const k = kinds.get(kind) ?? { total: 0, perBatch: {}, examples: [] };
      k.total += n;
      k.perBatch[r.batch] = (k.perBatch[r.batch] ?? 0) + n;
      for (const x of m.examples ?? []) if (x.kind === kind) k.examples.push({ ...x, batch: r.batch, url: r.url, runId: r.runId, at: r.finishedAt ?? '' });
      kinds.set(kind, k);
    }
  }
  return { finished, runsPerBatch, kinds };
}
