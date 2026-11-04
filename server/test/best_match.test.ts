import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestMatch } from '../src/agents/director.js';
import type { Photo, Run, SlidePlan } from '../src/run.js';

// Super Colchones (0c40bc32): slides 3 to 6 got the banners in list order, not the mattress they name.
test('an empty slide gets the photo of the product it names', () => {
  const assets = [
    { id: 'a14', kind: 'banner', description: 'America Diamond mattress with sheets and pillow and red promo tags' },
    { id: 'a19', kind: 'banner', description: 'navy Restonic Moon Cool mattress with white pillows in modern bedroom' },
    { id: 'a22', kind: 'people', description: 'woman lying with cat on white and navy Restonic Gel Foam mattress' },
  ];
  const photos = assets.map((a, i) => ({ id: `p${i + 3}`, asset: a.id, path: '', backdrop: true })) as unknown as Photo[];
  const run = { assets } as unknown as Run;
  const slide = (headline: string, body: string) => ({ n: 3, headline, body }) as SlidePlan;
  assert.equal(bestMatch(run, slide('Moon Cool fresco toda la noche', 'Desde $2,999 con almohadas de regalo'), photos)?.asset, 'a19');
  assert.equal(bestMatch(run, slide('Diamond con sábanas de regalo', 'Desde $4,399 con almohada incluida'), photos)?.asset, 'a14');
  assert.equal(bestMatch(run, slide('Estrena hoy con envío gratis', 'Compra a meses'), photos), undefined);
});
