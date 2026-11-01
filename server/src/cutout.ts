import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { brandCutout, keep as keepInLibrary, photoHash } from './library.js';
import { hostOf } from './variety.js';
import { addCost } from './llm.js';
import type { Photo, Run } from './run.js';
import { samPrompts } from './sam.js';
import { decodeOneBitMask } from './sam_mask.js';

// A box in the pixels of the image sent, and its mask, which can be smaller than the box.
type Segment = { x1: number; y1: number; x2: number; y2: number; confidence: number; width: number; height: number; mask: Uint8Array };

// SAM 3.1 with masks: each instance comes as a box and a one_bit mask that covers
// that box (downscaled when the box is large). It only answers JPEG input.
async function segment(input: Buffer, prompt: string): Promise<Segment[]> {
  const res = await fetch(`${config.modelBaseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.modelApiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: config.samModelId,
      stream: true,
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${input.toString('base64')}` },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`SAM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  addCost(0.0025);
  let output = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5)) as { type: string; delta?: string };
      if (event.type === 'response.output_text.delta') output += event.delta ?? '';
    } catch {
      // Keep-alive or partial line.
    }
  }
  const segments: Segment[] = [];
  // Every box is followed by its mask.
  for (const m of output.matchAll(/<\|box;([^|]*)\|><\|mask;([^|]*)\|>/g)) {
    const box = Object.fromEntries(m[1].split(';').map((kv) => kv.split('=') as [string, string]));
    const data = m[2].slice(m[2].indexOf('data=') + 5);
    const [height, width] = data.split(',', 2).map(Number);
    const payload = data.slice(data.indexOf(',', data.indexOf(',') + 1) + 1);
    if (!payload.startsWith('!')) continue;
    segments.push({ x1: Number(box.x1), y1: Number(box.y1), x2: Number(box.x2) + 1, y2: Number(box.y2) + 1, confidence: box.c ? Number(box.c) : 1, width, height, mask: decodeOneBitMask(payload, width, height) });
  }
  return segments.sort((a, b) => b.confidence - a.confidence);
}

// Cuts the subject out of a photo with SAM and adds it to the run as a cutout
// photo (a PNG with the original pixels and a transparent background).
export async function cutOut(run: Run, photo: Photo, subject: string): Promise<Photo | undefined> {
  const id = `${photo.id}c`;
  const file = path.join(run.dir, 'photos', `${id}.png`);
  const hash = photoHash(photo.path);
  // The same photo of the same brand was already cut out: SAM is not paid twice.
  const kept = brandCutout(hostOf(run.brief.url), hash, subject);
  if (kept) {
    await copyFile(kept.file, file);
    const cut: Photo = { id, path: file, cutout: true, grounded: kept.grounded, note: `${subject} cut out by SAM 3.1 from photo ${photo.id}${photo.note ? ` (${photo.note})` : ''}` };
    run.photos = [...run.photos.filter((p) => p.id !== id), cut];
    return cut;
  }
  const source = sharp(photo.path).rotate();
  const { width = 1, height = 1 } = await source.metadata();
  const sent = await source.clone().flatten({ background: '#ffffff' }).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  let segments: Segment[] = [];
  for (const prompt of [...samPrompts(subject), 'product']) {
    segments = (await segment(sent.data, prompt)).filter((s) => s.confidence >= 0.5);
    if (segments.length) break;
  }
  if (!segments.length) return undefined;
  // The most confident instance and every other one that overlaps it (a product
  // found in pieces); separate products elsewhere in the photo stay out.
  const main = segments[0];
  const keep = segments.filter((s) => s === main || (s.x1 < main.x2 && s.x2 > main.x1 && s.y1 < main.y2 && s.y2 > main.y1));
  const w = sent.info.width;
  const h = sent.info.height;
  const alpha = Buffer.alloc(w * h);
  for (const s of keep) {
    // Each pixel of the box reads the mask pixel it falls on.
    const bw = s.x2 - s.x1;
    const bh = s.y2 - s.y1;
    for (let y = 0; y < bh && s.y1 + y < h; y++) {
      const my = Math.min(s.height - 1, Math.floor((y * s.height) / bh));
      for (let x = 0; x < bw && s.x1 + x < w; x++) {
        const mx = Math.min(s.width - 1, Math.floor((x * s.width) / bw));
        if (s.mask[my * s.width + mx]) alpha[(s.y1 + y) * w + s.x1 + x] = 255;
      }
    }
  }
  // The mask is as big as the image sent to SAM: it is scaled to the original and
  // softened by a pixel so the edge doesn't look cut with scissors.
  const matte = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).resize(width, height, { kernel: 'cubic' }).blur(0.8).extractChannel(0).raw().toBuffer();
  const rgb = await source.clone().removeAlpha().raw().toBuffer();
  // Trimmed to the product, so "whole and centered" means the product itself.
  await sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(matte, { raw: { width, height, channels: 1 } }).png().toFile(file);
  await sharp(file).trim({ threshold: 1 }).toFile(`${file}.tmp.png`).then(async () => {
    const { rename } = await import('node:fs/promises');
    await rename(`${file}.tmp.png`, file);
  });
  const foot = Math.max(1, Math.round(h * 0.01));
  const grounded = alpha.subarray((h - foot) * w).some((v) => v > 0);
  const cut: Photo = { id, path: file, cutout: true, grounded, note: `${subject} cut out by SAM 3.1 from photo ${photo.id}${photo.note ? ` (${photo.note})` : ''}` };
  run.photos = [...run.photos.filter((p) => p.id !== id), cut];
  await keepInLibrary(run, 'cutout', subject, file, { source: hash, grounded, personality: run.system?.personality }).catch(() => undefined);
  return cut;
}

// A studio shot on a plain background loses that background without SAM: a flood
// fill from the borders through the pixels close to the matte color, so the
// product's own light parts (not connected to the border) stay. Undefined when it
// doesn't look like a clean cut (almost nothing or almost everything removed).
export async function keyOut(run: Run, photo: Photo): Promise<Photo | undefined> {
  if (!photo.matte) return undefined;
  const source = sharp(photo.path).rotate();
  const { width = 1, height = 1 } = await source.metadata();
  // Transparent parts count as background: flattened on the matte color, not on black.
  const work = await source.clone().flatten({ background: photo.matte }).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = work.info;
  const m = [1, 3, 5].map((i) => parseInt(photo.matte!.slice(i, i + 2), 16));
  const near = (i: number) => Math.max(Math.abs(work.data[i * channels] - m[0]), Math.abs(work.data[i * channels + 1] - m[1]), Math.abs(work.data[i * channels + 2] - m[2])) <= 18;
  const background = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!background[i] && near(i)) {
      background[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const removed = tail / (w * h);
  if (removed < 0.1 || removed > 0.97) return undefined;
  const alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = background[i] ? 0 : 255;
  const matte = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).resize(width, height, { kernel: 'cubic' }).blur(0.8).extractChannel(0).raw().toBuffer();
  const rgb = await source.clone().flatten({ background: photo.matte }).raw().toBuffer();
  const id = `${photo.id}k`;
  const file = path.join(run.dir, 'photos', `${id}.png`);
  const out = await sharp(await sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(matte, { raw: { width, height, channels: 1 } }).png().toBuffer())
    .trim({ threshold: 1 })
    .toFile(file);
  const keyed: Photo = { id, path: file, cutout: true, content: { x1: 0, y1: 0, x2: 1, y2: 1 }, note: `${photo.note ?? ''} (its plain background removed)`.trim() };
  run.photos = [...run.photos.filter((p) => p.id !== id), keyed];
  return out.width > 16 ? keyed : undefined;
}
