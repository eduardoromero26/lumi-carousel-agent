import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productFirst } from '../src/orchestrator.js';
import type { Plan, Run } from '../src/run.js';

// Luuna (689f6bdd): a mattress store whose plan put its athlete ambassadors on the hook and
// the close, with no mattress in sight.
function luuna() {
  const assets = [
    { id: 'a1', kind: 'people', description: 'smiling man in black polo holding racing helmet on racetrack' },
    { id: 'a2', kind: 'people', description: 'female track athlete in starting blocks on blue track' },
    { id: 'a3', kind: 'product', description: 'orange upholstered bed frame in minimalist bedroom' },
    { id: 'a4', kind: 'product', description: 'mustard-orange sectional sofa in sunlit living room' },
    { id: 'a5', kind: 'people', description: 'young male athlete on outdoor track' },
    { id: 'a6', kind: 'product', description: 'Luuna Original mattress on a grey bed base' },
    { id: 'a7', kind: 'product', description: 'white pillows on a mattress, close-up' },
  ];
  const photos = assets.map((a, i) => ({ id: `p${i + 1}`, asset: a.id, path: `${a.id}.jpg` }));
  const run = { assets, photos, emit: () => undefined } as unknown as Run;
  const slide = (n: number, role: string, photo: string) => ({ n, role, photo, headline: '' });
  const plan = {
    business_type: 'Mattress and furniture store',
    slides: [slide(1, 'hook', 'p1'), slide(2, 'proof', 'p2'), slide(3, 'value', 'p3'), slide(4, 'value', 'p4'), slide(5, 'cta', 'p5')],
  } as unknown as Plan;
  return { run, plan };
}

test('a store shows what it sells: people without the product keep only one proof slide', () => {
  const { run, plan } = luuna();
  productFirst(run, plan);
  const photo = (n: number) => plan.slides.find((s) => s.n === n)!.photo;
  // The proof slide keeps its ambassador; the hook and the close take mattress photos first.
  assert.equal(photo(2), 'p2');
  assert.equal(photo(1), 'p6');
  assert.equal(photo(5), 'p7');
  assert.equal(photo(3), 'p3');
  assert.equal(new Set(plan.slides.map((s) => s.photo)).size, 5);
});

test('a business with few product photos keeps its plan', () => {
  const { run, plan } = luuna();
  (run as unknown as { assets: { kind: string }[] }).assets.forEach((a) => {
    if (a.kind === 'product') a.kind = 'place';
  });
  productFirst(run, plan);
  assert.deepEqual(plan.slides.map((s) => s.photo), ['p1', 'p2', 'p3', 'p4', 'p5']);
});
