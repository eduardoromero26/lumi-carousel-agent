import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureHistory, lintKind, metricsOf, parseLessons, reportMarkdown, summarize, type QueueRow } from '../src/metrics.js';
import { Run, type RunEvent } from '../src/run.js';

function runWith(events: Omit<RunEvent, 'seq'>[], slides: Run['slides'], status: Run['status'] = 'done'): Run {
  const run = new Run({ url: 'https://example.com' }, 'test');
  run.events = events.map((e, seq) => ({ ...e, seq }));
  run.slides = slides;
  run.status = status;
  run.cost = 0.1234;
  return run;
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute)).toISOString();

test('groups the lint messages by kind', () => {
  assert.equal(lintKind('the headline is too close to the slide\'s edge (40,60 to 900,200)'), 'too close to the edge');
  assert.equal(lintKind('the headline overlaps the logo'), 'elements overlap');
  assert.equal(lintKind('the body overlaps the photo card'), 'text overlaps the photo card');
  assert.equal(lintKind('the bike is cut by the edge of the photo area: show it whole'), 'subject cut by the edge');
});

test('counts first passes, failed checks, lint and the set score of a run', () => {
  const run = runWith(
    [
      { at: at(0), type: 'status', agent: 'system', text: 'start' },
      { at: at(1), type: 'review', agent: 'critic', slide: 1, text: 'Rejected by measurement', data: { issues: ['measured: the headline overlaps the logo'] } },
      { at: at(2), type: 'review', agent: 'critic', slide: 1, text: 'Rejected (6/10)', data: { issues: ['padding: tight'], checks: { padding: { answer: 'no' }, brand: { answer: 'yes' } } } },
      { at: at(3), type: 'review', agent: 'critic', slide: 2, text: 'All checks passed (9/10)', data: { issues: [], checks: { padding: { answer: 'yes' } } } },
      { at: at(4), type: 'review', agent: 'critic', text: 'The set works as one family (8/10)', data: { score: 8 } },
      { at: at(6), type: 'done', agent: 'system', text: 'Carousel ready' },
    ],
    [
      { n: 1, file: 's1.png', approved: true, rounds: 3 },
      { n: 2, file: 's2.png', approved: true, rounds: 1 },
    ],
  );
  const m = metricsOf(run);
  assert.equal(m.status, 'done');
  assert.equal(m.minutes, 6);
  assert.equal(m.approved, 2);
  assert.equal(m.firstPass, 1);
  assert.equal(m.rounds, 4);
  assert.equal(m.setScore, 8);
  assert.deepEqual(m.checks, { padding: 1 });
  assert.deepEqual(m.lint, { 'elements overlap': 1 });
  assert.equal(m.error, undefined);
});

test('measures whether the middle slides share one skeleton and repeat no photo', () => {
  const built = (slide: number, shape: string) => ({ at: at(slide), type: 'status' as const, agent: 'designer' as const, slide, text: 'Built from the "product" template.', data: { shape } });
  const slides = [1, 2, 3, 4, 5].map((n) => ({ n, file: `s${n}.png`, approved: true, rounds: 1 }));
  // Cielo Hamacas, 906725e5: frosted panels on 1 and 3, photo above on 2 and 4.
  const split = runWith([built(1, 'overlay'), built(2, 'photo_top'), built(3, 'overlay'), built(4, 'photo_top'), built(5, 'card')], slides);
  split.plan = { slides: [{ photo: 'p1' }, { photo: 'p2' }, { photo: 'p2' }, { photo: 'p3' }, { photo: null }] } as unknown as Run['plan'];
  assert.deepEqual(metricsOf(split).skeletons, ['overlay', 'photo_top', 'overlay', 'photo_top', 'card']);
  assert.equal(metricsOf(split).oneSkeleton, false);
  assert.equal(metricsOf(split).repeatedPhotos, 1);
  // A rebuild for the set counts, not the first build; the cover and the CTA may differ.
  const fixed = runWith([built(1, 'overlay'), built(2, 'photo_top'), built(3, 'overlay'), built(3, 'photo_top'), built(4, 'photo_top'), built(5, 'card')], slides);
  assert.equal(metricsOf(fixed).oneSkeleton, true);
  assert.equal(metricsOf(fixed).repeatedPhotos, 0);
});

test('tells a stopped run from a failed one', () => {
  const stopped = runWith([{ at: at(0), type: 'error', agent: 'system', text: 'Stopped by the owner.' }], [], 'failed');
  const failed = runWith([{ at: at(0), type: 'error', agent: 'system', text: 'No photos and no website to work with.' }], [], 'failed');
  assert.equal(metricsOf(stopped).status, 'stopped');
  assert.equal(metricsOf(failed).status, 'failed');
  assert.equal(metricsOf(failed).error, 'No photos and no website to work with.');
});

test('summarizes a batch and writes its report', () => {
  const base = { minutes: 6, cost: 0.1, slides: 5, approved: 4, firstPass: 2, rounds: 8, checks: { padding: 2 }, lint: {}, templateIssues: 0, photos: 6 };
  const rows: QueueRow[] = [
    { url: 'https://a.mx/', status: 'done', runId: 'a', note: null, metrics: { ...base, status: 'done', setScore: 8 } },
    { url: 'https://b.mx/', status: 'done', runId: 'b', note: null, metrics: { ...base, status: 'done', setScore: 6, checks: { brand: 1 } } },
    { url: 'https://c.mx/', status: 'failed', runId: 'c', note: 'boom', metrics: { ...base, status: 'failed', setScore: null, slides: 0, approved: 0, firstPass: 0, rounds: 0, error: 'boom' } },
    { url: 'https://d.mx/', status: 'waiting', runId: null, note: null, metrics: null },
  ];
  const s = summarize('v1', rows);
  assert.equal(s.done, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.waiting, 1);
  assert.equal(s.setScore, 7);
  assert.equal(s.approvedPct, 80);
  assert.equal(s.firstPassPct, 40);
  assert.equal(s.roundsPerSlide, 1.6);
  assert.deepEqual(s.checks[0], ['padding', 4]);
  assert.deepEqual(s.errors, [['boom', 1]]);
  const md = reportMarkdown(rows, s);
  assert.match(md, /# Batch: v1/);
  assert.match(md, /\| https:\/\/c\.mx\/ \| failed \|.*boom/);
});

test('reads the lessons by failure kind', () => {
  const lessons = parseLessons('# Lessons\n\nintro\n\n## check:padding\n\nThe fixer got `more_padding`.\n\n## lint:off-center\n');
  assert.equal(lessons.get('check:padding'), 'The fixer got `more_padding`.');
  assert.equal(lessons.has('lint:off-center'), false);
});

test('keeps every failure across batches with its rate, examples and past fix', () => {
  const metrics = (padding: number, note: string) => ({
    status: 'done' as const, minutes: 5, cost: 0.1, slides: 4, approved: 4, firstPass: 2, rounds: 6, setScore: 8,
    checks: { padding }, lint: {}, templateIssues: 0, photos: 4, examples: [{ kind: 'check:padding', slide: 2, note }],
  });
  const md = failureHistory(
    [
      { url: 'https://a.mx/', status: 'done', runId: 'a', note: null, batch: 'v1', finishedAt: '2026-11-01T10:00:00Z', metrics: metrics(2, 'headline touches the edge') },
      { url: 'https://b.mx/', status: 'done', runId: 'b', note: null, batch: 'v2', finishedAt: '2026-11-01T11:00:00Z', metrics: metrics(1, 'body too tight') },
    ],
    new Map([['check:padding', 'More margin in the template.']]),
  );
  assert.match(md, /## check:padding \(3\)/);
  assert.match(md, /- v1: 2 per carousel/);
  assert.match(md, /- v2: 1 per carousel/);
  assert.match(md, /\*\*Fixed before:\*\* More margin in the template\./);
  assert.ok(md.indexOf('body too tight') < md.indexOf('headline touches the edge'), 'newest example first');
});
