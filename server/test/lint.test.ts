import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Gimp } from '../src/gimp.js';
import { lintSlide } from '../src/lint.js';
import type { SlidePlan } from '../src/run.js';
import type { Built } from '../src/templates.js';

type LayerRow = [string, number, number, number, number, boolean];

// The lint only asks GIMP for the layer boxes; this stands in for it.
const gimpWith = (layers: LayerRow[]) => ({ python: async () => layers }) as unknown as Gimp;

const slide: SlidePlan = { n: 2, role: 'value', photo: null, headline: 'Fresh every day', body: 'Made this morning', visual: '' };

const built = (extra: Partial<Built> = {}): Built => ({
  layout: 'photo_band',
  ground: '#ffffff',
  ink: '#111111',
  textBand: 'top',
  split: false,
  text: { x1: 140, y1: 120, x2: 940, y2: 460 },
  textScale: 1,
  photoCropped: false,
  align: 'center',
  ...extra,
});

const clean: LayerRow[] = [
  ['Headline', 140, 120, 800, 200, true],
  ['Body', 190, 360, 700, 100, true],
  ['Logo', 480, 1200, 120, 80, true],
];

const replace = (name: string, row: LayerRow): LayerRow[] => clean.map((l) => (l[0] === name ? row : l));

test('a clean slide has no issues', async () => {
  assert.deepEqual(await lintSlide(gimpWith(clean), built(), slide), []);
});

test('finds text blocks that overlap', async () => {
  const issues = await lintSlide(gimpWith(replace('Body', ['Body', 190, 250, 700, 100, true])), built(), slide);
  assert.ok(issues.includes('the headline overlaps the body'));
});

test('hidden layers are not measured', async () => {
  const issues = await lintSlide(gimpWith(replace('Body', ['Body', 190, 250, 700, 100, false])), built(), slide);
  assert.deepEqual(issues, []);
});

test('finds text off-center on a centered slide', async () => {
  const issues = await lintSlide(gimpWith(replace('Headline', ['Headline', 100, 120, 800, 200, true])), built(), slide);
  assert.ok(issues.includes('the headline is off-center'));
});

test('finds text off the left margin on a left-aligned slide', async () => {
  const issues = await lintSlide(gimpWith(replace('Body', ['Body', 120, 360, 700, 100, true])), built({ align: 'left' }), slide);
  assert.ok(issues.includes('the body is not on the left margin'));
});

test('finds a logo too close to the edge', async () => {
  const issues = await lintSlide(gimpWith(replace('Logo', ['Logo', 480, 1280, 120, 60, true])), built(), slide);
  assert.ok(issues.some((i) => i.startsWith('the logo is too close')));
});

test('finds text over a face', async () => {
  const issues = await lintSlide(gimpWith(clean), built(), { ...slide, faces: [{ x1: 400, y1: 150, x2: 600, y2: 250 }] });
  assert.ok(issues.includes('the headline covers a face'));
});

test('finds a product touching its card and off its center', async () => {
  const card = { x1: 140, y1: 500, x2: 940, y2: 1150 };
  const issues = await lintSlide(gimpWith(clean), built({ card, product: { x1: 145, y1: 600, x2: 600, y2: 1000 } }), slide);
  assert.ok(issues.includes('the product touches or crosses the edge of its card: make it smaller'));
  assert.ok(issues.includes('the product is not centered in its card'));
});

test('finds a subject cut by the photo area, unless the photo itself ends there', async () => {
  const photoFrame = { x: 0, y: 300, w: 1080, h: 1050 };
  const subject = { x1: 300, y1: 400, x2: 800, y2: 1100 };
  const cut = await lintSlide(gimpWith(clean), built({ photoFrame, subject, visible: { x1: 0, y1: 500, x2: 1080, y2: 1350 } }), { ...slide, subject: 'bike' });
  assert.ok(cut.includes('the bike is cut by the edge of the photo area: show it whole'));
  const whole = await lintSlide(gimpWith(clean), built({ photoFrame, subject, visible: { x1: 0, y1: 300, x2: 1080, y2: 1350 } }), { ...slide, subject: 'bike' });
  assert.ok(!whole.some((i) => i.includes('cut by the edge')));
});

test('reports each issue once', async () => {
  const issues = await lintSlide(gimpWith(clean), built(), { ...slide, faces: [{ x1: 400, y1: 150, x2: 600, y2: 250 }, { x1: 410, y1: 160, x2: 590, y2: 240 }] });
  assert.equal(issues.filter((i) => i === 'the headline covers a face').length, 1);
});
