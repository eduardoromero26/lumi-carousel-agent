import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitBeats, REEL, type Shot } from '../src/reel.js';

const TARGET = REEL.seconds / REEL.beat;

const shot = (text: string, extra: Partial<Shot> = {}): Shot => ({
  slide: 1,
  layout: 'photo_full',
  text,
  text_in: 'words',
  highlight: 'none',
  camera: 'push_in',
  transition: 'cut',
  beats: 0,
  ...extra,
});

const total = (shots: Shot[]) => shots.reduce((t, s) => t + s.beats, 0);

test('fills a short reel to exactly 30 s, after the hook', () => {
  const shots = [shot('Fresh tacos'), shot('Every Tuesday night'), shot('Made by hand'), shot('Book your table', { layout: 'end_card', button: 'Book' })];
  assert.equal(fitBeats({ shots }), true);
  assert.equal(total(shots), TARGET);
  assert.ok(shots[0].beats < shots[1].beats, 'the hook stays short');
});

test('trims a long reel to 30 s from the shots with beats to spare', () => {
  const shots = [shot('Hook', { beats: 30 }), shot('Two words', { beats: 30 }), shot('Three short words', { beats: 30 })];
  assert.equal(fitBeats({ shots }), true);
  assert.equal(total(shots), TARGET);
  assert.ok(shots.every((s) => s.beats > 0));
});

test('never cuts a shot below the time its words need', () => {
  const long = 'one two three four five six seven eight nine ten eleven twelve';
  const shots = [shot('Hook', { beats: 50 }), shot(long, { beats: 1 }), shot('Bye', { beats: 50 })];
  assert.equal(fitBeats({ shots }), true);
  // Entrance 0.6 + 0.08/word, then 0.5 + 0.3/word still: 12 words need 5.06 s, 11 beats.
  assert.ok(shots[1].beats >= 11, `got ${shots[1].beats}`);
  assert.equal(total(shots), TARGET);
});

test('refuses words that cannot be read in 30 s', () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  assert.equal(fitBeats({ shots: Array.from({ length: 6 }, () => shot(words)) }), false);
  assert.equal(fitBeats({ shots: [] }), false);
});
