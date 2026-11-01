import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enforceActions, parseFixRequests } from '../src/fixes.js';

test('keeps known actions once each', () => {
  const { fixes, templateIssues } = parseFixRequests([
    { action: 'Smaller_Headline', why: 'it wraps to four lines' },
    { action: 'smaller_headline', why: 'again' },
    { action: 'hide_decor', why: 'the element touches the logo' },
  ]);
  assert.deepEqual(fixes, [
    { action: 'smaller_headline', why: 'it wraps to four lines' },
    { action: 'hide_decor', why: 'the element touches the logo' },
  ]);
  assert.deepEqual(templateIssues, []);
});

test('turns "none" and unknown actions into template issues', () => {
  const { fixes, templateIssues } = parseFixRequests([
    { action: 'none', why: 'the cover needs a second photo' },
    { action: 'rotate_photo', why: 'the bike is tilted' },
    'the font is too thin',
    { action: 'none' },
  ]);
  assert.deepEqual(fixes, []);
  assert.deepEqual(templateIssues, [
    'the cover needs a second photo',
    'the bike is tilted (asked for "rotate_photo", which the template has no action for)',
    'the font is too thin',
  ]);
});

test('ignores answers that are not a list', () => {
  assert.deepEqual(parseFixRequests({ action: 'bigger_logo' }), { fixes: [], templateIssues: [] });
});

test('applies in code an action the fixer left out', () => {
  const { tweaks, applied, byCode } = enforceActions({ headScale: 1 }, {}, [{ action: 'bigger_headline', why: '' }]);
  assert.equal(tweaks.headScale, 1.1);
  assert.deepEqual(applied, ['bigger_headline']);
  assert.deepEqual(byCode, ['bigger_headline']);
});

test('keeps what the fixer did when it moved the right way', () => {
  const { tweaks, byCode } = enforceActions({ bodyScale: 1 }, { bodyScale: 0.85 }, [{ action: 'smaller_body', why: '' }]);
  assert.equal(tweaks.bodyScale, 0.85);
  assert.deepEqual(byCode, []);
});

test('overrides a move the wrong way', () => {
  const { tweaks, byCode } = enforceActions({ logoScale: 1 }, { logoScale: 1.2 }, [{ action: 'smaller_logo', why: '' }]);
  assert.equal(tweaks.logoScale, 0.85);
  assert.deepEqual(byCode, ['smaller_logo']);
});

test('sets value actions and clamps steps to the template limits', () => {
  const { tweaks } = enforceActions({ headScale: 1.1 }, {}, [
    { action: 'bigger_headline', why: '' },
    { action: 'text_above_photo', why: '' },
    { action: 'hide_decor', why: '' },
  ]);
  assert.equal(tweaks.headScale, 1.15);
  assert.equal(tweaks.band, 'split');
  assert.equal(tweaks.decor, false);
});

test('leaves "another photo" to the orchestrator', () => {
  const { tweaks, applied, byCode } = enforceActions(undefined, {}, [{ action: 'another_photo', why: 'blurry' }]);
  assert.deepEqual(applied, []);
  assert.deepEqual(byCode, []);
  assert.equal(tweaks.band, 'auto');
});
