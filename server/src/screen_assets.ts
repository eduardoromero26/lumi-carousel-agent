import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chatJson, imagePart } from './llm.js';
import type { Run } from './run.js';
import { PAGE_READER } from './agents/prompts.js';

type Box = { x1: number; y1: number; x2: number; y2: number; kind: string; what: string };

// When a website doesn't give its images (rendered by JavaScript, or blocked to
// non-browsers), they are taken from the page as a visitor sees it: Muse Spark
// boxes every image on the screenshot and each box is cropped, at the
// screenshot's double resolution, as a new asset for the analyst.
export async function assetsFromScreens(run: Run): Promise<number> {
  const shot = run.site?.screens?.find((s) => s.includes('desktop')) ?? run.site?.screens?.[0];
  if (!shot) return 0;
  const { width = 1, height = 1 } = await sharp(shot).metadata();
  const small = await sharp(shot).resize(1024).jpeg({ quality: 80 }).toBuffer();
  const found = await chatJson<{ images?: Box[] }>([
    { role: 'system', content: PAGE_READER },
    { role: 'user', content: [{ type: 'text', text: `Screenshot of ${run.brief.url ?? 'the website'} (${width}x${height}):` }, imagePart(small.toString('base64'), 'image/jpeg')] },
  ]);
  const dir = path.join(run.dir, 'assets');
  await mkdir(dir, { recursive: true });
  let added = 0;
  for (const b of (found.images ?? []).slice(0, 12)) {
    const n = (v: unknown) => Math.min(1, Math.max(0, Number(v)));
    const [x1, y1, x2, y2] = [n(b.x1), n(b.y1), n(b.x2), n(b.y2)];
    const left = Math.round(x1 * width);
    const top = Math.round(y1 * height);
    const w = Math.round((x2 - x1) * width);
    const h = Math.round((y2 - y1) * height);
    const logo = b.kind === 'logo';
    // Too small to use on a 1080 px slide (a logo can be small).
    if (w < (logo ? 60 : 300) || h < (logo ? 24 : 200)) continue;
    const id = `a${run.assets.length + 1}`;
    const file = path.join(dir, `${id}.${logo ? 'png' : 'jpg'}`);
    // A loose box carries a strip of the page around the image: flat borders are trimmed.
    const crop = sharp(shot).extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) });
    const buffer = await crop.toBuffer();
    const trimmed = await sharp(buffer).trim({ threshold: 12 }).toBuffer({ resolveWithObject: true }).catch(() => ({ data: buffer, info: { width: w, height: h } }));
    const image = sharp(trimmed.data);
    const out = await (logo ? image.png() : image.jpeg({ quality: 92 })).toFile(file);
    run.assets.push({
      id,
      path: file,
      source: `${run.brief.url ?? ''}#screenshot`,
      alt: String(b.what ?? '').slice(0, 120),
      hint: `cropped from a screenshot of the page (${b.kind})`,
      context: String(b.what ?? '').slice(0, 120),
      width: out.width,
      height: out.height,
      transparent: false,
    });
    added++;
  }
  return added;
}
