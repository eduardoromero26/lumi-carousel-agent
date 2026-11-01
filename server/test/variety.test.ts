import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSystem } from '../src/design.js';
import type { Run } from '../src/run.js';
import { freshen, shapeOf, type Look } from '../src/variety.js';

const built = (slide: number, text: string, shape?: string) => ({ slide, text: `Built from the "photo_band" template${text}.`, data: shape ? { shape } : undefined });

test('a run looks like what its photo slides came out as, not what was asked', () => {
  const run = {
    system: { composition: 'overlay' },
    events: [built(1, ' (photo above, text below)'), built(2, ' (photo above, text below)'), built(3, ''), built(4, '', 'card'), built(5, '', 'text')],
  } as unknown as Run;
  assert.equal(shapeOf(run), 'photo_top');
  const redone = { system: { composition: 'split' }, events: [built(1, '', 'split'), built(2, '', 'split'), built(2, ' (photo above, text below)', 'photo_top'), built(3, '', 'split')] } as unknown as Run;
  assert.equal(shapeOf(redone), 'split');
});

test('the composition changes when the last brand came out the same, or two of five did', () => {
  const look = (composition: Look['composition'], shape: string, colorSlides: Look['colorSlides'] = 'both'): Look => ({ host: 'x', composition, shape, colorSlides, logoPosition: 'top_center', device: 'underline' });
  const system = normalizeSystem({ composition: 'overlay', colorSlides: 'both', logoPosition: 'top_center', device: 'frame' }, []);
  const recent = [look('overlay', 'photo_top'), look('window', 'window'), look('overlay', 'photo_top'), look('stacked', 'stacked'), look('photo_top', 'photo_top')];
  const changes = freshen(system, [], recent, true);
  assert.ok(!['overlay', 'photo_top', 'window'].includes(system.composition), system.composition);
  assert.ok(changes.some((c) => c.startsWith('composition overlay →')));
  // Five of five with the same color blocks: this one changes too.
  assert.notEqual(system.colorSlides, 'both');
  // The cutout stands on the foot, the split's photo takes the top: the logo follows.
  if (system.composition === 'cutout') assert.equal(system.logoPosition, 'top_center');
  if (system.composition === 'split') assert.equal(system.logoPosition, 'bottom_center');
});
