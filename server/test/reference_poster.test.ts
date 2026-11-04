import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { inBrandTone, luminance, normalizeSystem, toneOf } from '../src/design.js';
import { mirrorLayout, normalizeLayout } from '../src/layout.js';
import { brandName } from '../src/layout_render.js';
import { applyReference, measureZones, normalizeStyle, type Reference } from '../src/references.js';
import type { Plan, Run } from '../src/run.js';

// A product poster like the Kauri reference: wordmark on top, a faded initial, the product
// standing across a light field over a deep brown one.
const kauri = {
  photo: { mode: 'box', box: { x1: 0.11, y1: 0.405, x2: 0.89, y2: 0.85 }, subjectAt: 0.48, standOn: 0.85, shadow: true },
  scrim: 'none',
  textTone: 'dark',
  blocks: [{ role: 'title', box: { x1: 0.14, y1: 0.22, x2: 0.67, y2: 0.33 }, align: 'center', case: 'as_is', weight: 'bold', font: 'sans' }],
  elements: [],
  logo: { x1: 0.139, y1: 0.22, x2: 0.671, y2: 0.334 },
  ghost: { kind: 'letter', box: { x1: 0.22, y1: -0.2, x2: 1.3, y2: 0.48 } },
};

test('a wordmark read as a title is the logo, and a poster without a headline gets one under it', () => {
  const layout = normalizeLayout(kauri)!;
  assert.ok(layout, 'the poster keeps its plan');
  assert.deepEqual(layout.logo, kauri.logo);
  assert.equal(layout.blocks.some((b) => b.role === 'title'), false);
  const head = layout.blocks.find((b) => b.role === 'headline')!;
  assert.ok(head.box.y1 > layout.logo!.y2 && head.box.y2 <= layout.photo.box.y1 + 0.05, 'between the logo and the product');
  assert.equal(head.align, 'center');
  // The ghost may run off the design; the product stands on its line.
  assert.equal(layout.ghost?.box.y1, -0.2);
  assert.equal(layout.ghost?.box.x2, 1.3);
  assert.equal(layout.photo.standOn, 0.85);
  const mirrored = mirrorLayout(layout);
  assert.ok(Math.abs(mirrored.logo!.x1 - (1 - kauri.logo.x2)) < 1e-9);
});

test('the ground bands come from the pixels: a light field over a deep one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zones-'));
  try {
    const file = path.join(dir, 'two.png');
    const top = { r: 0xd4, g: 0xd1, b: 0xbe };
    await sharp({ create: { width: 400, height: 500, channels: 3, background: top } })
      .composite([
        { input: { create: { width: 400, height: 215, channels: 3, background: { r: 0x6b, g: 0x3d, b: 0x2d } } }, top: 285, left: 0 },
        // A product crossing the middle and a faded letter on the right edge don't break it.
        { input: { create: { width: 200, height: 260, channels: 3, background: { r: 250, g: 250, b: 250 } } }, top: 150, left: 100 },
        { input: { create: { width: 30, height: 120, channels: 3, background: { r: 0xe4, g: 0xe1, b: 0xd0 } } }, top: 20, left: 370 },
      ])
      .png()
      .toFile(file);
    const zones = await measureZones(file);
    assert.equal(zones.length, 2);
    assert.ok(Math.abs(zones[0].y2 - 0.57) <= 0.02, `split at ${zones[0].y2}`);
    assert.equal(toneOf(zones[1].hex), 'deep');
    const flat = path.join(dir, 'flat.png');
    await sharp({ create: { width: 400, height: 500, channels: 3, background: { r: 240, g: 238, b: 232 } } }).png().toFile(flat);
    assert.equal((await measureZones(flat)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each band goes in the brand's colors: its own cream when it has one, its hue for the deep band", () => {
  const delgado = ['#f5ede3', '#0a2b7d', '#7aa8ff'];
  assert.equal(inBrandTone('#d4d1be', delgado), '#f5ede3');
  const deep = inBrandTone('#6b3d2d', delgado);
  assert.equal(toneOf(deep), 'deep');
  assert.ok(Math.abs(luminance(deep) - luminance('#6b3d2d')) < 0.05, 'the reference lightness, in navy');
});

test('a reference with two bands sets the ground under the headline and keeps the bands; "brand" is the deep tone', () => {
  const plan = { concept: 'c', slides: [{ n: 1, role: 'hook', headline: 'Tu oficina lista', body: '', visual: '' }] } as unknown as Plan;
  const ref = (style: Record<string, unknown>): Reference => ({ id: 'k', title: 'Kauri', file: 'k.jpg', source: 'upload', runId: null, style: normalizeStyle(style), at: '' });
  const colors = ['#f5ede3', '#0a2b7d', '#7aa8ff'];
  const layout = { ...kauri, zones: [{ y1: 0, y2: 0.57, hex: '#d4d1be' }, { y1: 0.57, y2: 1, hex: '#6b3d2d' }] };
  const system = normalizeSystem({ base: '#14161a', ink: '#f5ede3', accent: '#7aa8ff' }, colors);
  applyReference(system, plan, ref({ composition: 'cutout', ground: 'brand', layout }), colors);
  assert.equal(system.zones?.length, 2);
  assert.equal(system.base, '#f5ede3');
  assert.equal(toneOf(system.zones![1].color), 'deep');
  // Without bands, "brand" on a near-black ground is the brand's deep tone, not a pale tint.
  const flat = normalizeSystem({ base: '#14161a', ink: '#f5ede3', accent: '#7aa8ff' }, colors);
  applyReference(flat, plan, ref({ composition: 'cutout', ground: 'brand' }), colors);
  assert.equal(toneOf(flat.base), 'deep');
});

test("the brand's name is the part of the site's title that is in its domain", () => {
  const run = (title: string, url: string) => ({ site: { title }, brief: { url } }) as unknown as Run;
  assert.equal(brandName(run('Muebles y Equipo para Oficina | Delgado', 'https://mueblesdelgado.com.mx/')), 'Delgado');
  assert.equal(brandName(run('Kikis Nails', 'https://www.facebook.com/nailskikis')), 'Kikis Nails');
});
