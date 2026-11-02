import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { cutoutFlaw } from '../src/cutout.js';
import { calmGround, contrast, normalizeSystem, paletteFor } from '../src/design.js';
import { ghostWord, markEmphasis } from '../src/templates.js';

test('a loud ground goes deep, or pastel when it is a light color', () => {
  // Hot pink, pure red: deep. Bright yellow, light pink: pastel.
  for (const loud of ['#e91e63', '#e53935']) assert.ok(contrast(calmGround(loud), '#ffffff') >= 7, loud);
  for (const light of ['#ffd400', '#ff69b4']) assert.ok(contrast(calmGround(light), '#111111') >= 12, light);
});

test('neutrals, darks and pastels stay as the brand chose them', () => {
  for (const calm of ['#ffffff', '#f4efe6', '#1a1a1a', '#0d2a4a', '#fde8ef', '#8a8070']) assert.equal(calmGround(calm), calm);
});

test('the system calms its base and its color block, and keeps the text readable', () => {
  const system = normalizeSystem({ base: '#e91e63', ink: '#ffffff', accent: '#ffd400', accentInk: '#111111', colorSlides: 'cover' }, []);
  assert.notEqual(system.base, '#e91e63');
  assert.ok(contrast(system.base, system.ink) >= 4.5);
  assert.equal(system.accent, '#ffd400');
  const cover = paletteFor(system, 'cover');
  assert.notEqual(cover.ground, '#ffd400');
  assert.ok(contrast(cover.ground, cover.ink) >= 4.5);
});

test('the thin frame around the slide is retired', () => {
  assert.equal(normalizeSystem({ device: 'frame' as never }, []).device, 'underline');
});

async function cutout(file: string, draw: string): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">${draw}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

test('a whole subject passes; one in pieces, or too small to be the hero, does not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cutout-'));
  const whole = await cutout(path.join(dir, 'whole.png'), '<ellipse cx="400" cy="420" rx="260" ry="330" fill="#7a5"/>');
  assert.equal(await cutoutFlaw(whole), undefined);
  // A chair: thin legs and the floor showing between them are still one piece.
  const chair = await cutout(path.join(dir, 'chair.png'), '<rect x="200" y="120" width="400" height="360" fill="#654"/><rect x="210" y="480" width="16" height="280" fill="#222"/><rect x="574" y="480" width="16" height="280" fill="#222"/>');
  assert.equal(await cutoutFlaw(chair), undefined);
  const pieces = await cutout(path.join(dir, 'pieces.png'), '<rect x="40" y="200" width="300" height="400" fill="#456"/><rect x="460" y="200" width="300" height="400" fill="#456"/>');
  assert.match((await cutoutFlaw(pieces)) ?? '', /pieces/);
  const tiny = path.join(dir, 'tiny.png');
  await sharp(whole).resize(500, 500).toFile(tiny);
  assert.match((await cutoutFlaw(tiny)) ?? '', /small/);
});

test('the emphasis takes the accent wherever the headline breaks it, and is escaped for the markup', () => {
  assert.equal(markEmphasis('Crafted for Comfort.', 'comfort', '#c4561d'), 'Crafted for <span foreground="#c4561d">Comfort</span>.');
  assert.equal(markEmphasis('Compra hoy\nsin intereses', 'hoy sin', '#123456'), 'Compra <span foreground="#123456">hoy\nsin</span> intereses');
  assert.equal(markEmphasis('Pan & café <3', 'café', '#000000'), 'Pan &amp; <span foreground="#000000">café</span> &lt;3');
  assert.equal(markEmphasis('Muebles a medida', 'sofás', '#000000'), undefined);
  assert.equal(markEmphasis('Muebles a medida', undefined, '#000000'), undefined);
});

test('the word behind a cutout is the emphasis, else the longest word, and fits the slide', () => {
  assert.equal(ghostWord({ headline: 'Tu próxima bici está aquí', emphasis: 'bici' }), 'BICI');
  assert.equal(ghostWord({ headline: 'Tu próxima bici está aquí' }), 'PRÓXIMA');
  assert.equal(ghostWord({ headline: 'Electrodomésticos', emphasis: undefined }), undefined);
});
