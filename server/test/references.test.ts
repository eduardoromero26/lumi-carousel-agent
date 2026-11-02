import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contrast, luminance, normalizeSystem } from '../src/design.js';
import { applyReference, normalizeStyle, type Reference } from '../src/references.js';
import type { Plan } from '../src/run.js';

const ref = (style: Partial<Reference['style']>): Reference => ({
  id: 'r1',
  title: 'Aurora',
  file: 'x.jpg',
  source: 'upload',
  runId: null,
  style: normalizeStyle(style),
  at: '2026-11-02T00:00:00Z',
});

const plan = (): Plan =>
  ({
    concept: 'c',
    slides: [
      { n: 1, role: 'hook', headline: 'Crafted for comfort', body: '', visual: '', eyebrow: 'New', emphasis: 'comfort' },
      { n: 2, role: 'value', headline: 'Quality you can feel', body: '', visual: '', emphasis: 'feel' },
    ],
  }) as unknown as Plan;

test("a reader's answer keeps only choices the templates have", () => {
  const style = normalizeStyle({ composition: 'collage', ground: 'beige', device: 'none', personality: 'luxury', decor: 'yes', notes: 42 });
  assert.equal(style.composition, 'window');
  assert.equal(style.ground, 'light');
  assert.equal(style.device, 'pill_label');
  assert.equal(style.personality, 'clean');
  assert.equal(style.decor, false);
  assert.equal(style.notes, '');
});

test('the reference wins on its choices and the brand keeps its colors', () => {
  const system = normalizeSystem({ base: '#1b1b1b', ink: '#ffffff', accent: '#c4561d', composition: 'split', colorSlides: 'both', typeScale: 'loud', decor: { element: 'gold brush strokes in the corner' } }, []);
  const p = plan();
  const changes = applyReference(system, p, ref({ composition: 'window', ground: 'light', colorSlides: 'none', typeScale: 'calm', decor: false, emphasis: true }));
  assert.equal(system.composition, 'window');
  assert.equal(system.colorSlides, 'none');
  assert.equal(system.typeScale, 'calm');
  assert.ok(luminance(system.base) >= 0.75, system.base);
  assert.ok(contrast(system.base, system.ink) >= 4.5);
  assert.equal(system.accent, '#c4561d');
  assert.equal(system.decor, undefined);
  assert.equal(p.slides[1].emphasis, 'feel');
  assert.ok(changes.some((c) => c.startsWith('composition')));
});

test('a reference without an accent word clears it, and the logo follows the composition', () => {
  const system = normalizeSystem({ base: '#f4efe6', ink: '#222222', accent: '#c4561d', composition: 'window', logoPosition: 'top_center' }, []);
  const p = plan();
  applyReference(system, p, ref({ composition: 'split', ground: 'light', emphasis: false }));
  assert.equal(system.logoPosition, 'bottom_center');
  assert.ok(p.slides.every((s) => !s.emphasis));
});
