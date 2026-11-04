import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyShotFixes, type ReelSpec } from '../src/reel.js';
import type { Run } from '../src/run.js';

const run = {
  photos: [
    { id: 'p1', path: 'p1.jpg' },
    { id: 'p2', path: 'p2.jpg' },
    { id: 'p3c', path: 'p3c.png', cutout: true },
    { id: 'b1', path: 'b1.jpg', backdrop: true },
  ],
} as unknown as Run;

const spec = (): ReelSpec => ({
  shots: [
    { slide: 1, layout: 'photo_wall', text: 'Tu oficina lista', text_in: 'words', highlight: 'none', camera: 'pan_left', transition: 'cut', beats: 8 },
    { slide: 2, layout: 'deck', text: 'Sillas', text_in: 'rise', highlight: 'none', camera: 'pan_right', transition: 'whip', beats: 10, photos: ['p1', 'p2'], items: ['a', 'b'] },
    { slide: 3, layout: 'photo_window', photo: 'p1', text: 'Libreros', text_in: 'slam', highlight: 'none', camera: 'push_in', transition: 'iris', beats: 12 },
    { slide: 4, layout: 'end_card', text: 'Cotiza hoy', text_in: 'words', highlight: 'none', camera: 'push_in', transition: 'band', beats: 30, button: 'Escríbenos' },
  ],
});

test("the critic's actions change only the shot's settings, never the shot list", () => {
  const s = spec();
  const done = applyShotFixes(s, run, [
    { n: 1, action: 'longer' },
    { n: 2, action: 'simpler_scene' },
    { n: 3, action: 'another_photo' },
    { n: 3, action: 'bigger_text' },
    { n: 2, action: 'other_camera' },
  ]);
  assert.equal(s.shots.length, 4);
  assert.equal(s.shots[0].beats, 10);
  assert.equal(s.shots[1].layout, 'photo_window');
  assert.equal(s.shots[1].photo, 'p1');
  assert.equal(s.shots[1].camera, 'push_in', 'a pan that hurts becomes a push');
  assert.notEqual(s.shots[2].photo, 'p1');
  assert.notEqual(s.shots[2].photo, 'b1', 'never a banner');
  assert.equal(s.shots[2].textScale, 1.15);
  assert.equal(done.length, 5);
});

test('text size stays between 70 % and 130 %, and the hook and the close keep their scene', () => {
  const s = spec();
  for (let i = 0; i < 5; i++) applyShotFixes(s, run, [{ n: 3, action: 'bigger_text' }, { n: 4, action: 'smaller_text' }]);
  assert.equal(s.shots[2].textScale, 1.3);
  assert.equal(s.shots[3].textScale, 0.7);
  applyShotFixes(s, run, [{ n: 1, action: 'simpler_scene' }, { n: 4, action: 'simpler_scene' }]);
  assert.equal(s.shots[0].layout, 'photo_wall');
  assert.equal(s.shots[3].layout, 'end_card');
});
