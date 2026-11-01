import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { chatJson, imagePart, type ContentPart } from '../llm.js';
import type { Asset, Photo, Run } from '../run.js';
import { ANALYST } from './prompts.js';

const BATCH = 8;
// Kinds that can be the background of a slide.
const PHOTO_KINDS = new Set(['product', 'food', 'place', 'people', 'work']);
const BACKDROP_KINDS = new Set([...PHOTO_KINDS, 'banner']);
const MAX_PHOTOS = 8;

type Verdict = { id: string; kind: Asset['kind']; description: string; has_text: boolean; quality: number; ai_generated?: boolean };

// Image AIs name their files ("ChatGPT_Image_23_jun…", "DALL·E 2024…", "Gemini_Generated_Image…").
const AI_FILE = /chatgpt[_ -]?image|dall[·.\-_ ]?e|gemini[_ -]generated|midjourney|firefly|leonardo[_ -]?ai|stable[_ -]?diffusion|ideogram|ai[_ -]generated/i;

export function aiMadeFile(source: string): boolean {
  let name = source;
  try {
    name = decodeURIComponent(new URL(source).pathname);
  } catch {}
  return AI_FILE.test(name);
}

// Looks at every asset from the website, labels it and decides what the other
// agents get: the logo for the designer, good photos for the director and the
// brand colors when the owner didn't give them.
export async function analyzeAssets(run: Run): Promise<void> {
  const site = run.assets.filter((a) => a.source !== 'upload');
  if (!site.length) return;
  const colors = new Set<string>();
  const batches: Asset[][] = [];
  for (let i = 0; i < site.length; i += BATCH) batches.push(site.slice(i, i + BATCH));
  // The batches are independent: all at once, in the time of one.
  const results = await Promise.all(
    batches.map(async (batch) => {
      const parts: ContentPart[] = [{ type: 'text', text: `Website: ${run.brief.url}\nClassify these ${batch.length} assets.` }];
      for (const asset of batch) {
        parts.push({
          type: 'text',
          text: `Asset ${asset.id} (${asset.width}x${asset.height}${asset.transparent ? ', transparent' : ''}${asset.hint ? `, ${asset.hint}` : ''}${asset.alt ? `, alt "${asset.alt}"` : ''}${asset.context ? `, shown on the site as "${asset.context}"` : ''}):`,
        });
        parts.push(imagePart(await thumbnail(asset), 'image/png'));
      }
      return chatJson<{ assets: Verdict[]; brand_colors?: string[] }>([
        { role: 'system', content: ANALYST },
        { role: 'user', content: parts },
      ]);
    }),
  );
  for (const result of results) {
    for (const verdict of result.assets ?? []) {
      const asset = run.assets.find((a) => a.id === verdict.id);
      if (!asset) continue;
      asset.kind = verdict.kind;
      asset.description = verdict.description;
      asset.hasText = verdict.has_text;
      asset.quality = verdict.quality;
      asset.aiMade = !!verdict.ai_generated || aiMadeFile(asset.source);
    }
    result.brand_colors?.forEach((c) => /^#[0-9a-f]{6}$/i.test(c) && colors.add(c.toLowerCase()));
  }

  // Prefer transparent, large logos, and keep a dark and a light version so the
  // designer can use the one that reads on each background.
  const logos = site
    .filter((a) => a.kind === 'logo')
    .sort((a, b) => Number(b.transparent) - Number(a.transparent) || b.width / b.height - a.width / a.height || b.width * b.height - a.width * a.height);
  const light: Asset[] = [];
  const dark: Asset[] = [];
  for (const logo of logos) {
    logo.matte = logo.transparent ? undefined : await plainEdge(logo.path);
    await trimLogo(logo);
    logo.tone = await luminance(logo);
    logo.badge = await isBadge(logo);
    (logo.tone > 0.75 ? light : dark).push(logo);
  }
  // The logo the owner uploaded is the logo.
  const uploaded = run.assets.find((a) => a.source === 'upload' && a.kind === 'logo');
  run.logo = uploaded ?? dark[0] ?? light[0];
  run.logoLight = uploaded ? undefined : light[0] !== run.logo ? light[0] : undefined;

  // Only the business's real photos: what an image AI made never reaches a slide.
  const real = site.filter((a) => !a.aiMade);
  if (real.length < site.length) run.emit('status', 'analyst', `Left out ${site.length - real.length} image(s) made with AI: only real photos go on the slides.`);
  const candidates = real.filter((a) => a.kind && PHOTO_KINDS.has(a.kind) && (a.quality ?? 0) >= 3 && !a.hasText && Math.min(a.width, a.height) >= 500);
  const shots = new Map<Asset, Studio>();
  await Promise.all(candidates.map(async (asset) => shots.set(asset, asset.transparent ? { cropped: false, content: await alphaBox(asset.path) } : await studioShot(asset.path))));
  // A product cut by its own photo's edge can't be shown whole: those go last.
  const clean = candidates
    .sort((a, b) => Number(shots.get(a)!.cropped) - Number(shots.get(b)!.cropped) || (b.quality ?? 0) - (a.quality ?? 0))
    .slice(0, MAX_PHOTOS);
  for (const asset of clean) run.photos.push(await photoFromAsset(run, asset, shots.get(asset)));
  // Many sites (agencies, services) only have screenshots and banners with text.
  // They still beat a flat color as backgrounds, softened and under a shade.
  const backdrops = real
    .filter((a) => !clean.includes(a) && a.kind && BACKDROP_KINDS.has(a.kind) && (a.quality ?? 0) >= 2 && Math.min(a.width, a.height) >= 400)
    .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || b.width * b.height - a.width * a.height)
    .slice(0, Math.max(0, MAX_PHOTOS - run.photos.length));
  for (const asset of backdrops) run.photos.push(await photoFromAsset(run, asset, undefined, true));

  if (!run.brief.brandColors?.length && colors.size) run.brief.brandColors = [...colors].slice(0, 3);
}

// One website image as a photo the director can use: a backdrop when it has text
// baked in (softened, behind the slide's own text), else a photo read as a studio
// shot (product whole on a card), a transparent cutout or a plain photo.
export async function photoFromAsset(run: Run, asset: Asset, shot?: Studio, backdrop = !!asset.hasText || asset.kind === 'banner'): Promise<Photo> {
  const id = `p${run.photos.length + 1}`;
  if (backdrop) {
    const file = path.join(run.dir, 'photos', `${id}-backdrop.jpg`);
    // A light blur hides the baked-in text and the softness of the upscale.
    await sharp(asset.path).rotate().flatten({ background: '#000000' }).blur(2.5).jpeg({ quality: 90 }).toFile(file);
    return { id, path: file, backdrop: true, asset: asset.id, note: `from the website, has text baked in (backdrop only): ${asset.description ?? asset.kind}` };
  }
  // Catalog shots on a plain background are shown whole too, on that same color.
  const { matte, cropped, content } = shot ?? (asset.transparent ? { cropped: false, content: await alphaBox(asset.path) } : await studioShot(asset.path));
  const cutout = asset.transparent || (!!matte && !cropped);
  const how = asset.transparent
    ? ', cutout on a transparent background'
    : cropped
      ? `, product cut by the photo's own edge (never for a product slide or the cover)`
      : matte
        ? `, product on a plain ${matte} background`
        : '';
  const card = asset.context ? ` (on the site: "${asset.context}")` : '';
  return { id, path: asset.path, asset: asset.id, cutout, matte: cutout ? matte : undefined, content, cropped: cropped || undefined, note: `from the website${how}: ${asset.description ?? asset.kind}${card}` };
}

// A logo file often has margins of its own background (or transparency) around
// the mark: they are trimmed so sizes and plates fit the mark itself.
export async function trimLogo(logo: Asset): Promise<void> {
  const file = logo.path.replace(/\.(\w+)$/, '-trim.$1');
  const trimmed = await sharp(logo.path)
    .trim(logo.matte ? { background: logo.matte, threshold: 30 } : { threshold: 10 })
    .toFile(file)
    .catch(() => undefined);
  if (!trimmed || trimmed.width < 16 || trimmed.height < 8) return;
  logo.path = file;
  logo.width = trimmed.width;
  logo.height = trimmed.height;
}

// The color of the photo's border when it is one flat color (a studio shot), else undefined.
export async function plainEdge(file: string): Promise<string | undefined> {
  const size = 48;
  const { data, info } = await sharp(file).removeAlpha().resize(size, size, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const edge: number[][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x > 0 && y > 0 && x < size - 1 && y < size - 1) continue;
      const i = (y * size + x) * info.channels;
      edge.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  const mean = [0, 1, 2].map((c) => edge.reduce((s, p) => s + p[c], 0) / edge.length);
  const spread = edge.filter((p) => p.some((v, c) => Math.abs(v - mean[c]) > 14)).length / edge.length;
  if (spread > 0.04) return undefined;
  return `#${mean.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

type Box = { x1: number; y1: number; x2: number; y2: number };
type Studio = { matte?: string; cropped: boolean; content?: Box };

// A studio shot: three or four sides of the photo are one flat color. With three,
// the product pokes through the fourth side: it is cut by the photo's own edge.
// "content" is where the product sits once that color is trimmed (0..1).
export async function studioShot(file: string): Promise<Studio> {
  const size = 64;
  const { data, info } = await sharp(file).flatten({ background: '#ffffff' }).resize(size, size, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => {
    const i = (y * size + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const line = (f: (i: number) => number[]) => Array.from({ length: size }, (_, i) => f(i));
  const sides = [line((i) => px(i, 0)), line((i) => px(i, size - 1)), line((i) => px(0, i)), line((i) => px(size - 1, i))];
  const all = sides.flat();
  const median = [0, 1, 2].map((c) => all.map((p) => p[c]).sort((a, b) => a - b)[all.length >> 1]);
  const off = sides.map((side) => side.filter((p) => p.some((v, c) => Math.abs(v - median[c]) > 16)).length / side.length);
  const plain = off.filter((f) => f <= 0.05).length;
  if (plain < 3) return { cropped: false };
  // A fourth side all different is a floor or a table, not a cut product.
  const fourth = Math.max(...off);
  if (plain === 3 && fourth > 0.8) return { cropped: false };
  const matte = `#${median.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return { matte, cropped: plain === 3, content: await trimBox(sharp(file).flatten({ background: matte }), file, matte) };
}

// Where the visible pixels of a transparent cutout are (0..1).
export async function alphaBox(file: string): Promise<Box | undefined> {
  return trimBox(sharp(file).ensureAlpha().extractChannel(3), file, { r: 0, g: 0, b: 0, alpha: 0 });
}

async function trimBox(image: Sharp, file: string, background: string | { r: number; g: number; b: number; alpha: number }): Promise<Box | undefined> {
  const { width = 1, height = 1 } = await sharp(file).metadata();
  const out = await image
    .trim({ background, threshold: 30 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => undefined);
  if (!out) return undefined;
  const left = -(out.info.trimOffsetLeft ?? 0);
  const top = -(out.info.trimOffsetTop ?? 0);
  return { x1: left / width, y1: top / height, x2: (left + out.info.width) / width, y2: (top + out.info.height) / height };
}

// Mean brightness (0..1) of the visible pixels of a logo.
export async function luminance(asset: Asset): Promise<number> {
  const { data, info } = await sharp(asset.path).ensureAlpha().resize(128, 128, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3] / 255;
    sum += a * (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    weight += a;
  }
  return weight ? sum / weight / 255 : 0;
}

// Opaque over most of its trimmed box: the mark sits on its own shape (a rounded
// square, a circle), so it never needs a plate behind it.
export async function isBadge(asset: Asset): Promise<boolean> {
  if (!asset.transparent) return false;
  const { data, info } = await sharp(asset.path).ensureAlpha().resize(64, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let solid = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i] > 200) solid++;
  return solid / (info.width * info.height) > 0.75;
}

// Transparent assets are flattened on gray so a white logo is still visible.
async function thumbnail(asset: Asset): Promise<string> {
  const image = sharp(asset.path).resize(512, 512, { fit: 'inside' });
  const buffer = await (asset.transparent ? image.flatten({ background: '#9a9a9a' }) : image).png().toBuffer();
  return buffer.toString('base64');
}
