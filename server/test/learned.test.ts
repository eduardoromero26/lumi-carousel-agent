import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kindName, library } from '../src/learned.js';
import { failureKinds, type HistoryRow, type RunMetrics } from '../src/metrics.js';
import { calibration, tasteStats, type Judged, type Vote } from '../src/taste.js';

const votes = (value: 1 | -1, n: number, features: Record<string, string>): Vote[] => Array.from({ length: n }, () => ({ value, features }));

test('names failure kinds for people', () => {
  assert.equal(kindName('check:whole_subject'), 'Whole subject (critic)');
  assert.equal(kindName('lint:subject cut by the edge'), 'Subject cut by the edge (measured)');
  assert.equal(kindName('error'), 'Runs that failed');
});

test('puts each thing learned on its shelf with its evidence', () => {
  const judged: Judged[] = [
    { value: -1, target: 'slide:2', runId: 'r1', note: 'el texto no se lee', critic: { approved: true, score: 9 }, business: 'Marion Bikes' },
    { value: 1, target: 'carousel', note: null, critic: { approved: true, score: 8 } },
  ];
  const row = { url: 'a.com', status: 'done', runId: 'r1', note: null, batch: 'v1', finishedAt: '2026-11-01', metrics: { checks: { whole_subject: 2 }, lint: {}, examples: [] } as unknown as RunMetrics } as HistoryRow;
  const shelves = library({
    stats: tasteStats([...votes(1, 3, { composition: 'window' }), ...votes(-1, 2, { personality: 'bold' }), ...votes(1, 1, { device: 'pill' })]),
    votes: judged,
    calibration: calibration(judged),
    batches: [{ batch: 'v1', voted: 10, liked: 3, stars: 2.75, rated: 4 }],
    failures: failureKinds([row]),
    lessons: new Map([['check:whole_subject', 'The lint measures the subject box.'], ['check:brand', 'Templates place the logo.']]),
    learned: new Map([['taste:personality=bold', { value: -1, note: 'bold was fine, the photos were bad' }]]),
  });
  const shelf = (id: string) => shelves.find((s) => s.id === id)!;

  assert.deepEqual(shelf('design').cards.map((c) => [c.title, c.tone]), [['Works: composition window', 'good'], ['Avoid: personality bold', 'bad']]);
  assert.equal(shelf('critic').cards[0].title, 'The critic agrees with you on 50 %');
  const bold = shelf('design').cards[1];
  assert.equal(bold.id, 'taste:personality=bold');
  assert.equal(bold.vote, -1);
  assert.equal(bold.feedback, 'bold was fine, the photos were bad');
  assert.equal(shelf('design').cards[0].vote, undefined);
  assert.deepEqual(shelf('critic').cards[1], { id: 'note:r1:slide:2', title: 'Marion Bikes · slide 2', text: 'el texto no se lee', evidence: 'the critic had approved it (9/10)', tone: 'bad', at: undefined });
  assert.deepEqual(shelf('fixes').cards.map((c) => [c.title, c.evidence]), [
    ['Whole subject (critic)', 'seen 2 times · 2.00 per carousel in v1'],
    ['Brand (critic)', 'not seen in the queue'],
  ]);
  assert.equal(shelf('quality').cards[0].title, 'v1: 30 % · 2.8 ★');
  assert.deepEqual(shelf('references').cards, []);
});
