import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibration, describeLessons, describeTaste, sampleChoice, tasteStats, votesOn, type Judged, type Vote } from '../src/taste.js';

const votes = (value: 1 | -1, n: number, features: Record<string, string>): Vote[] => Array.from({ length: n }, () => ({ value, features }));

test('counts votes per feature value with a Beta(1,1) prior', () => {
  const stats = tasteStats([...votes(1, 3, { composition: 'window' }), ...votes(-1, 1, { composition: 'window' }), ...votes(-1, 2, { composition: 'overlay' })]);
  const window = stats.find((s) => s.value === 'window');
  const overlay = stats.find((s) => s.value === 'overlay');
  assert.deepEqual(window, { key: 'composition', value: 'window', up: 3, down: 1, mean: 4 / 6 });
  assert.deepEqual(overlay, { key: 'composition', value: 'overlay', up: 0, down: 2, mean: 1 / 4 });
  assert.equal(votesOn(stats, 'composition'), 6);
  assert.equal(votesOn(stats, 'font'), 0);
});

test('tells the agents only what the owner clearly liked or disliked', () => {
  const stats = tasteStats([...votes(1, 4, { personality: 'bold' }), ...votes(-1, 3, { personality: 'clean' }), ...votes(1, 1, { personality: 'heritage' })]);
  const text = describeTaste(stats, ['personality']);
  assert.match(text, /liked: personality bold \(4 up, 0 down\)/);
  assert.match(text, /disliked: personality clean \(0 up, 3 down\)/);
  assert.doesNotMatch(text, /heritage/);
  assert.equal(describeTaste(stats, ['composition']), '');
});

test('Thompson sampling favors what the owner liked', () => {
  const stats = tasteStats([...votes(1, 30, { hook: 'marquee' }), ...votes(-1, 30, { hook: 'photo_wall' })]);
  let marquee = 0;
  for (let i = 0; i < 200; i++) if (sampleChoice(stats, 'hook', ['photo_wall', 'marquee'] as const) === 'marquee') marquee++;
  assert.ok(marquee > 190, `marquee won ${marquee} of 200`);
});

test('Thompson sampling still explores options without votes', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(sampleChoice([], 'hook', ['photo_wall', 'marquee', 'photo_full'] as const)!);
  assert.equal(seen.size, 3);
  assert.equal(sampleChoice([], 'hook', []), undefined);
});

const judged = (value: 1 | -1, approved: boolean | null, note: string | null = null, target = 'carousel'): Judged => ({
  value,
  target,
  note,
  critic: approved === null ? null : { approved, score: approved ? 9 : 5 },
});

test('measures how often the critic agrees with the owner', () => {
  const report = calibration([judged(1, true), judged(-1, true, 'too small'), judged(-1, false), judged(1, false), judged(-1, null)]);
  assert.equal(report.votes, 5);
  assert.equal(report.liked, 2);
  assert.equal(report.judged, 4);
  assert.equal(report.agree, 2);
  assert.equal(report.rate, 0.5);
  assert.deepEqual(report.tooEasy.map((v) => v.note), ['too small']);
  assert.equal(report.tooHard.length, 1);
  assert.equal(calibration([]).rate, null);
});

test('gives the critic the owner\'s words, what it had approved first', () => {
  const text = describeLessons([
    judged(-1, false, 'colors are off', 'slide:3'),
    judged(-1, true, 'el texto no se lee'),
    judged(-1, true, '   '),
    judged(1, true, 'love it'),
  ]);
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '- a whole carousel that you had approved with 9/10: "el texto no se lee"');
  assert.equal(lines[1], '- slide 3: "colors are off"');
  assert.equal(describeLessons([judged(1, true, 'great')]), '');
});