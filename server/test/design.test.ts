import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contrast, normalizeDecor, normalizeTweaks, readableOn } from '../src/design.js';
import { balance } from '../src/templates.js';

test('contrast follows WCAG', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#6d4aff', '#6d4aff'), 1);
  assert.equal(contrast('#ffffff', '#000000'), contrast('#000000', '#ffffff'));
});

test('keeps the brand ink when it reads, else picks white or near-black', () => {
  assert.equal(readableOn('#ffffff', '#1d4ed8'), '#1d4ed8');
  assert.equal(readableOn('#ffffff', '#eeeeee'), '#111111');
  assert.equal(readableOn('#0b1020', '#1d2440'), '#ffffff');
});

test('clamps the fixer settings to what the templates can take', () => {
  assert.deepEqual(normalizeTweaks({ headScale: 3, bodyScale: 0.1, band: 'left', photoScale: Number.NaN, logoScale: '1.2', decor: true }), {
    headScale: 1.15,
    bodyScale: 0.7,
    band: 'auto',
    photoScale: undefined,
    logoScale: undefined,
    decor: undefined,
  });
  assert.equal(normalizeTweaks({ decor: false }).decor, false);
  assert.equal(normalizeTweaks(undefined).band, 'auto');
});

test('drops a decor kit with nothing usable in it', () => {
  assert.equal(normalizeDecor({ texture: 'grain', element: '', glow: false }), undefined);
  assert.equal(normalizeDecor('texture'), undefined);
});

test('keeps a decor kit within safe limits', () => {
  const decor = normalizeDecor({ texture: 'fine paper grain with soft fibers', blend: 'difference', strength: 0.9, glow: true });
  assert.equal(decor?.blend, 'soft-light');
  assert.equal(decor?.strength, 0.4);
  assert.equal(decor?.glow, true);
});

test('balances a headline into even lines', () => {
  assert.equal(balance('Fresh tacos every Tuesday night', 18), 'Fresh tacos every\nTuesday night');
  assert.equal(balance('Tacos', 4), 'Tacos');
  assert.ok(balance('one two three four five six seven eight nine ten', 5, 3).split('\n').length <= 3);
});
