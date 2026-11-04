import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { contrast } from './design.js';
import type { Asset, Run } from './run.js';

// The logo as it goes on a slide: never on a plate or a chip (owners read it as pasted).
// A logo with its own solid background loses it; one that still doesn't read on the
// ground goes in one color, the slide's text color, as agencies do with a mono logo.
// aspect: the shape of the place it goes (a reference's wide logo box takes the wordmark,
// not a tall mascot), before readability: a version that doesn't read goes in one color.
export async function slideLogo(run: Run, ground: string, ink: string, aspect?: number): Promise<{ asset: Asset } | undefined> {
  const options = [run.logo, run.logoLight].filter(Boolean) as Asset[];
  if (!options.length) return undefined;
  const scored = await Promise.all(options.map(async (a) => ({ a, file: await keyed(run, a), weak: 0 })));
  for (const s of scored) s.weak = await weakShare(s.file, ground);
  const off = (a: Asset) => (aspect && Math.abs(Math.log(a.width / a.height / aspect)) > Math.log(2.5) ? 1 : 0);
  // The most readable version; between equals, the wider one (a wordmark reads better in a header).
  const best = scored.sort((x, y) => off(x.a) - off(y.a) || x.weak - y.weak || y.a.width / y.a.height - x.a.width / x.a.height)[0];
  // A badge or a photo-like crop carries its own shape.
  if (best.a.badge || (!best.a.transparent && !best.a.matte)) return { asset: best.a };
  const asset = { ...best.a, path: best.file };
  if (best.weak <= 0.12) return { asset };
  return { asset: { ...asset, path: await mono(run, best.file, ink) } };
}

const cacheName = (run: Run, file: string, tag: string) => path.join(run.dir, 'logos', `${path.basename(file).replace(/\.\w+$/, '')}-${tag}.png`);

// The logo's own solid background keyed out, its edge colors unmixed from it so no dark
// or light fringe stays around the letters.
async function keyed(run: Run, logo: Asset): Promise<string> {
  if (!logo.matte || logo.transparent) return logo.path;
  const out = cacheName(run, logo.path, 'keyed');
  if (existsSync(out)) return out;
  const m = [1, 3, 5].map((i) => parseInt(logo.matte!.slice(i, i + 2), 16));
  const { data, info } = await sharp(logo.path).flatten({ background: logo.matte }).raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let p = 0, q = 0; p < data.length; p += info.channels, q += 4) {
    const d = Math.max(...[0, 1, 2].map((c) => Math.abs(data[p + c] - m[c])));
    const a = Math.min(1, Math.max(0, (d - 16) / 70));
    for (let c = 0; c < 3; c++) rgba[q + c] = a ? Math.min(255, Math.max(0, Math.round((data[p + c] - (1 - a) * m[c]) / a))) : 0;
    rgba[q + 3] = Math.round(a * 255);
  }
  await mkdir(path.dirname(out), { recursive: true });
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).trim({ threshold: 1 }).png().toFile(out);
  return out;
}

// The share of the logo's visible pixels that don't stand out on the ground.
async function weakShare(file: string, ground: string): Promise<number> {
  const { data, info } = await sharp(file).ensureAlpha().resize(200, 200, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  let seen = 0;
  let weak = 0;
  for (let p = 0; p < data.length; p += info.channels) {
    if (data[p + 3] < 128) continue;
    seen++;
    const hex = '#' + [0, 1, 2].map((c) => data[p + c].toString(16).padStart(2, '0')).join('');
    // 3:1, what a graphic needs to be seen (a brown logo on terracotta was 1.5).
    if (contrast(hex, ground) < 3) weak++;
  }
  return seen ? weak / seen : 1;
}

// Every visible pixel in one color, the edges kept soft.
async function mono(run: Run, file: string, ink: string): Promise<string> {
  const out = cacheName(run, file, `mono-${ink.slice(1)}`);
  if (existsSync(out)) return out;
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const c = [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16));
  for (let p = 0; p < data.length; p += 4) [data[p], data[p + 1], data[p + 2]] = c;
  await mkdir(path.dirname(out), { recursive: true });
  await sharp(data, { raw: info }).png().toFile(out);
  return out;
}
