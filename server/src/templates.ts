import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { SLIDE } from './config.js';
import { contrast, cutsOut, luminance, paletteFor, type DesignSystem, type Layout } from './design.js';
import type { Gimp } from './gimp.js';
import { buildFromLayout } from './layout_render.js';
import { designHtmlSlide } from './html_slide.js';
import { slideLogo } from './logo.js';
import type { Asset, Photo, Run, SlidePlan } from './run.js';

// The agency's carousel templates, built in GIMP with real, editable layers: the
// system decides fonts and colors, the template decides where things go, and the
// code measures it all (text first, then the photo in the space that is left).
// Everything is centered on x = 540 with 80 px margins; nothing is placed by eye.
const W = SLIDE.width;
const H = SLIDE.height;
const M = 80;
const TEXT_W = W - 2 * M;
// How much a photo may grow before it pixelates (owners saw it at 2x); a cutout on a
// clean ground, scaled with Lanczos and sharpened, holds a little more.
export const MAX_UP = 1.3;
const MAX_CUT = 1.5;

// Python helpers that run inside GIMP before every template.
export const LIB = String.raw`
def _color(_hex):
    return Gegl.Color.new(_hex)

def _get(_name):
    _f = [_l for _l in _img.get_layers() if _l.get_name() == _name]
    return _f[0] if _f else None

def _bgpos():
    return _img.get_item_position(_get('Background'))

def _layer(_name, _pos=0):
    _l = Gimp.Layer.new(_img, _name, ${W}, ${H}, Gimp.ImageType.RGBA_IMAGE, 100, Gimp.LayerMode.NORMAL)
    _img.insert_layer(_l, None, _pos)
    _l.fill(Gimp.FillType.TRANSPARENT)
    return _l

def _shape(_name, _x, _y, _w, _h, _hex, _radius=0, _pos=0, _opacity=100):
    _l = _layer(_name, _pos)
    if _radius > 0:
        _img.select_round_rectangle(Gimp.ChannelOps.REPLACE, _x, _y, _w, _h, _radius, _radius)
    else:
        _img.select_rectangle(Gimp.ChannelOps.REPLACE, _x, _y, _w, _h)
    Gimp.context_set_foreground(_color(_hex))
    _l.edit_fill(Gimp.FillType.FOREGROUND)
    Gimp.Selection.none(_img)
    _l.set_opacity(_opacity)
    return _l

def _image(_name, _file, _x, _y, _w, _h, _pos=0):
    _l = Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, _img, Gio.File.new_for_path(_file))
    _l.set_name(_name)
    _img.insert_layer(_l, None, _pos)
    Gimp.context_set_interpolation(Gimp.InterpolationType.CUBIC)
    _l.scale(_w, _h, False)
    _l.set_offsets(_x, _y)
    return _l

def _round_mask(_l, _x, _y, _w, _h, _radius):
    _img.select_round_rectangle(Gimp.ChannelOps.REPLACE, _x, _y, _w, _h, _radius, _radius)
    _l.add_mask(_l.create_mask(Gimp.AddMaskType.SELECTION))
    Gimp.Selection.none(_img)

_J = Gimp.TextJustification.CENTER

def _text(_name, _content, _font, _size, _hex, _maxw, _line=0.0, _spacing=0.0, _min=24, _markup=None):
    _f = Gimp.Font.get_by_name(_font)
    while True:
        _t = Gimp.TextLayer.new(_img, _content, _f, float(_size), Gimp.Unit.pixel())
        _img.insert_layer(_t, None, 0)
        _t.set_justification(_J)
        _t.set_line_spacing(_line * _size)
        _t.set_letter_spacing(_spacing * _size)
        _t.set_color(_color(_hex))
        if _markup:
            _t.set_markup(_markup)
        if _t.get_width() <= _maxw or _size <= _min:
            break
        _img.remove_layer(_t)
        _size = int(_size * 0.93)
    _t.set_name(_name)
    return _t

def _center(_l, _y):
    _l.set_offsets(int(${W / 2} - _l.get_width() / 2), int(_y))
    return _y + _l.get_height()

def _left(_l, _y):
    _l.set_offsets(${M}, int(_y))
    return _y + _l.get_height()

def _below(_l):
    return _img.get_item_position(_l) + 1
`;

// Balanced line breaks: at most `max` lines, each as close in length as possible.
export function balance(text: string, perLine: number, max = 3): string {
  const words = text.trim().split(/\s+/);
  const total = text.trim().length;
  const lines = Math.min(max, Math.max(1, Math.ceil(total / perLine)), words.length);
  if (lines === 1) return words.join(' ');
  let best: string[][] = [words];
  let bestScore = Infinity;
  const split = (rest: string[], k: number, acc: string[][]) => {
    if (k === 1) {
      const all = [...acc, rest];
      const lens = all.map((l) => l.join(' ').length);
      const score = Math.max(...lens) * 10 - Math.min(...lens) + (all.at(-1)!.length === 1 && words.length > 3 ? 40 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = all;
      }
      return;
    }
    for (let i = 1; i <= rest.length - k + 1; i++) split(rest.slice(i), k - 1, [...acc, rest.slice(0, i)]);
  };
  split(words, lines, []);
  return best.map((l) => l.join(' ')).join('\n');
}

const py = (v: unknown) => JSON.stringify(v);

const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The headline with its emphasis in another color, as Pango markup for the text layer:
// found whatever its case or line break; undefined when the headline doesn't hold it.
export function markEmphasis(text: string, emphasis: string | undefined, color: string): string | undefined {
  const words = emphasis?.trim().split(/\s+/).filter(Boolean);
  if (!words?.length) return undefined;
  const found = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'iu').exec(text);
  if (!found) return undefined;
  const at = found.index;
  return `${escapeMarkup(text.slice(0, at))}<span foreground="${color}">${escapeMarkup(found[0])}</span>${escapeMarkup(text.slice(at + found[0].length))}`;
}

// The giant word behind a cutout: the emphasis or the headline's longest word, letters only.
export function ghostWord(slide: Pick<SlidePlan, 'headline' | 'emphasis'>): string | undefined {
  const pick = (text: string) => text.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).sort((a, b) => b.length - a.length)[0] ?? '';
  const word = (slide.emphasis ? pick(slide.emphasis) : '') || pick(slide.headline);
  return word.length >= 3 && word.length <= 12 ? word.toUpperCase() : undefined;
}

// Where the ghost word reads: a subject crossing the word may hide only the foot of its
// letters, like a masthead behind a head; one across their full height eats whole letters
// even when it is narrow (Caruso "AB_AZA", "FL_YE"; Michelle "P_EL"). Behind the subject
// when it clears the letters, else above the head, else nowhere.
export function ghostPlace(word: string | undefined, subject: Rect, top: number): { word: string; size: number; cy: number } | undefined {
  if (!word) return undefined;
  const size = Math.round(Math.min(420, (W - 60) / (word.length * 0.62)));
  const w = Math.min(W - 40, size * 0.62 * word.length);
  const h = size * 0.75;
  const [x1, x2] = [W / 2 - w / 2, W / 2 + w / 2];
  // The share of the letters' height the subject covers where it crosses them.
  const hidden = (cy: number) => {
    if (Math.min(x2, subject.x2) <= Math.max(x1, subject.x1)) return 0;
    return Math.max(0, Math.min(cy + h / 2, Math.min(subject.y2, H)) - Math.max(cy - h / 2, subject.y1)) / h;
  };
  const behind = Math.round(subject.y1 + (Math.min(subject.y2, H) - subject.y1) * 0.3);
  if (hidden(behind) <= 0.35) return { word, size, cy: behind };
  const above = Math.round(subject.y1 - h / 4);
  if (above - h / 2 >= top && hidden(above) <= 0.35) return { word, size, cy: above };
  return undefined;
}

async function gradient(file: string, color: string, from: 'bottom' | 'top', start: number): Promise<void> {
  const [y1, y2] = from === 'bottom' ? [start / H, 1] : [start / H, 0];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="${y1}" x2="0" y2="${y2}">
    <stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset="0.45" stop-color="${color}" stop-opacity="0.66"/><stop offset="1" stop-color="${color}" stop-opacity="0.92"/>
  </linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function shadow(file: string, width: number): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 120}" height="120"><ellipse cx="${(width + 120) / 2}" cy="60" rx="${width / 2}" ry="22" fill="#000" fill-opacity="0.35"/></svg>`;
  await sharp(Buffer.from(svg)).blur(14).png().toFile(file);
}

export type Fit = { x: number; y: number; w: number; h: number };
export type Rect = { x1: number; y1: number; x2: number; y2: number };

const FULL: Rect = { x1: 0, y1: 0, x2: 1, y2: 1 };
// The card a transparent cutout sits on, so every product slide has the same card.
const CARD_LIGHT = '#f4f4f4';
// Every product card has the same size and place: the text below takes what is left.
// The hero shows the product bigger, loose on the ground. The product is the ad: more
// than half the slide.
const CARD = { product: 740, hero: 860, cta: 480 };

// Labels and buttons follow the brand's corners: round enough becomes a pill.
const corner = (radius: number, h: number) => (radius >= 24 ? Math.round(h / 2) : radius);

// The brand's ground across the whole carousel: one wide gradient (with grain) cut in
// slices, so swiping reads as one continuous surface; the decor texture is blended in.
async function groundSlice(run: Run, system: DesignSystem, n: number, dir: string): Promise<string | undefined> {
  const texture = system.decor?.textureFile;
  if (system.ground !== 'gradient' && !system.grain && !texture) return undefined;
  const count = Math.max(1, run.plan?.slides.length ?? 1);
  const pano = path.join(dir, 'ground.png');
  if (!existsSync(pano)) {
    const w = W * count;
    const b = system.base;
    const g = system.ground2 ?? system.base;
    const blobs = Array.from({ length: count }, (_, i) => `<ellipse cx="${Math.round(W * (i + (i % 2 ? 0.25 : 0.75)))}" cy="${i % 2 ? H * 0.8 : H * 0.25}" rx="${W * 0.7}" ry="${H * 0.45}" fill="url(#blob)"/>`).join('');
    const grain = system.grain
      ? `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="${w}" height="${H}" filter="url(#n)" opacity="0.12"/>`
      : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}"><defs>
      <linearGradient id="lin" x1="0" y1="0" x2="1" y2="0.3"><stop offset="0" stop-color="${b}"/><stop offset="0.5" stop-color="${g}"/><stop offset="1" stop-color="${b}"/></linearGradient>
      <radialGradient id="blob"><stop offset="0" stop-color="${g}" stop-opacity="0.7"/><stop offset="1" stop-color="${g}" stop-opacity="0"/></radialGradient>
    </defs><rect width="${w}" height="${H}" fill="url(#lin)"/>${system.ground === 'gradient' ? blobs : ''}${grain}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(pano);
  }
  const out = path.join(dir, `s${n}-ground.png`);
  const plain = await sharp(pano).extract({ left: Math.min(n - 1, count - 1) * W, top: 0, width: W, height: H }).png().toBuffer();
  if (texture && system.decor) {
    // As much texture as the text allows, mirrored on every second slide so it never repeats.
    for (const k of [1, 0.5]) {
      const tex = await sharp(texture).resize(W, H, { fit: 'cover' }).flop(n % 2 === 0).removeAlpha().ensureAlpha(system.decor.strength * k).png().toBuffer();
      const mixed = await sharp(plain).composite([{ input: tex, blend: system.decor.blend }]).png().toBuffer();
      if (await readable(mixed, system.ink)) {
        await sharp(mixed).toFile(out);
        return out;
      }
    }
  }
  await sharp(plain).toFile(out);
  return out;
}

// Text reads on a surface when it holds 4.5:1 on its average and on its lighter and
// darker spots (one deviation away).
export async function readable(surface: Buffer, ink: string): Promise<boolean> {
  const { channels } = await sharp(surface).stats();
  const tone = (d: number) => '#' + channels.slice(0, 3).map((c) => clamp(Math.round(c.mean + d * c.stdev), 0, 255).toString(16).padStart(2, '0')).join('');
  return [-1, 0, 1].every((d) => contrast(tone(d), ink) >= 4.5);
}

export function mix(a: string, b: string, t: number): string {
  const c = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(c(a, i) * (1 - t) + c(b, i) * t).toString(16).padStart(2, '0')).join('');
}

// The backdrop on the ground, as strong as the text band allows, mirrored on every
// second slide; too busy to read even when faint, the slide goes without it.
async function backdropSlice(file: string, ground: string, ink: string, n: number, band: { y1: number; y2: number }, out: string): Promise<string | undefined> {
  const image = await sharp(file).resize(W, H, { fit: 'cover' }).flop(n % 2 === 0).removeAlpha().png().toBuffer();
  const top = clamp(Math.round(band.y1), 0, H - 1);
  const height = clamp(Math.round(band.y2) - top, 1, H - top);
  for (const k of [1, 0.8, 0.6, 0.45, 0.3]) {
    const mixed = await sharp({ create: { width: W, height: H, channels: 3, background: ground } })
      .composite([{ input: await sharp(image).ensureAlpha(k).png().toBuffer() }])
      .png()
      .toBuffer();
    if (await readable(await sharp(mixed).extract({ left: 0, top, width: W, height }).png().toBuffer(), ink)) {
      await sharp(mixed).toFile(out);
      return out;
    }
  }
  return undefined;
}

// A soft light of the accent behind the text, as strong as the text allows.
async function glow(file: string, color: string, base: string, ink: string, cx: number, cy: number): Promise<boolean> {
  const alpha = [0.28, 0.16].find((a) => contrast(mix(base, color, a), ink) >= 4.5);
  if (!alpha) return false;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g"><stop offset="0" stop-color="${color}" stop-opacity="${alpha}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><ellipse cx="${Math.round(cx)}" cy="${Math.round(cy)}" rx="600" ry="480" fill="url(#g)"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return true;
}

// The decor element bleeds off a corner: the first corner (alternating per slide) where
// its pixels touch neither the text, the logo nor the card. Mirrored to face inwards.
const DECOR = 460;
async function decorElement(file: string, n: number, avoid: Rect[], out: string): Promise<Rect | undefined> {
  const cut = Math.round(DECOR * 0.38);
  const corners = [
    { x: W - DECOR + cut, y: -cut, turn: (s: Sharp) => s },
    { x: -cut, y: H - DECOR + cut, turn: (s: Sharp) => s.rotate(180) },
    { x: -cut, y: -cut, turn: (s: Sharp) => s.flop() },
    { x: W - DECOR + cut, y: H - DECOR + cut, turn: (s: Sharp) => s.flip() },
  ];
  const order = n % 2 ? [0, 1, 2, 3] : [1, 0, 3, 2];
  for (const i of order) {
    const c = corners[i];
    const { data, info } = await c.turn(sharp(file).resize(DECOR, DECOR, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // The element's own pixels on the slide, not its square.
    let box: Rect | undefined;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] < 24) continue;
        const sx = c.x + x;
        const sy = c.y + y;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        box = box ? { x1: Math.min(box.x1, sx), y1: Math.min(box.y1, sy), x2: Math.max(box.x2, sx + 1), y2: Math.max(box.y2, sy + 1) } : { x1: sx, y1: sy, x2: sx + 1, y2: sy + 1 };
      }
    }
    if (!box || avoid.some((a) => overlap(box!, { x1: a.x1 - 28, y1: a.y1 - 28, x2: a.x2 + 28, y2: a.y2 + 28 }) > 0)) continue;
    const vis = { x1: Math.max(0, c.x), y1: Math.max(0, c.y), x2: Math.min(W, c.x + DECOR), y2: Math.min(H, c.y + DECOR) };
    await sharp(data, { raw: info })
      .extract({ left: vis.x1 - c.x, top: vis.y1 - c.y, width: vis.x2 - vis.x1, height: vis.y2 - vis.y1 })
      .png()
      .toFile(out);
    return vis;
  }
  return undefined;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

async function size(file: string): Promise<{ width: number; height: number }> {
  const { width = 1, height = 1 } = await sharp(file).metadata();
  return { width, height };
}

// Covering the whole slide around a focus.
function cover(img: { width: number; height: number }, focus = { x: 0.5, y: 0.5 }): Fit {
  const scale = Math.max(W / img.width, H / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  return { x: clamp(Math.round(W / 2 - focus.x * w), W - w, 0), y: clamp(Math.round(H / 2 - focus.y * h), H - h, 0), w, h };
}

// The photo in a region with `keep` (0..1 of the photo) whole and centered: as big as
// covering the region allows, smaller when covering would cut what must stay.
function fitWhole(img: { width: number; height: number }, region: Rect, keep: Rect | undefined, photoScale = 1, margin = 40, maxScale = Infinity): Fit {
  const rw = region.x2 - region.x1;
  const rh = region.y2 - region.y1;
  const k = keep ?? FULL;
  const coverScale = Math.max(rw / img.width, rh / img.height);
  const whole = keep ? Math.min((rw - 2 * margin) / ((k.x2 - k.x1) * img.width), (rh - 2 * margin) / ((k.y2 - k.y1) * img.height)) : coverScale;
  const scale = Math.min(coverScale, whole, maxScale) * photoScale;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const x = region.x1 + rw / 2 - ((k.x1 + k.x2) / 2) * w;
  const y = region.y1 + rh / 2 - ((k.y1 + k.y2) / 2) * h;
  // Bigger than the region: never show its edge. Smaller: stay inside it.
  const place = (v: number, s: number, lo: number, len: number) => Math.round(s >= len ? clamp(v, lo + len - s, lo) : clamp(v, lo, lo + len - s));
  return { x: place(x, w, region.x1, rw), y: place(y, h, region.y1, rh), w, h };
}

// Covering a region around a focus (0..1 of the photo).
function coverAt(img: { width: number; height: number }, region: Rect, focus = { x: 0.5, y: 0.5 }): Fit {
  const rw = region.x2 - region.x1;
  const rh = region.y2 - region.y1;
  const scale = Math.max(rw / img.width, rh / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  return { x: clamp(Math.round(region.x1 + rw / 2 - focus.x * w), region.x2 - w, region.x1), y: clamp(Math.round(region.y1 + rh / 2 - focus.y * h), region.y2 - h, region.y1), w, h };
}

// The photo in the area from the slide's top to `bottom`, cut with a hard edge that
// rises `slant` px to the right, and an accent stripe 18 px under that edge.
async function edgePhoto(file: string, frame: Fit, bottom: number, slant: number, out: string, stripeOut: string, color: string): Promise<Rect> {
  const vis = { x1: Math.max(frame.x, 0), y1: Math.max(frame.y, 0), x2: Math.min(frame.x + frame.w, W), y2: Math.min(frame.y + frame.h, bottom) };
  const shown = await sharp(file)
    .rotate()
    .resize(frame.w, frame.h, { fit: 'fill' })
    .extract({ left: vis.x1 - frame.x, top: vis.y1 - frame.y, width: vis.x2 - vis.x1, height: vis.y2 - vis.y1 })
    .png()
    .toBuffer();
  const edge = (h: number, fill: string) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}"><polygon points="0,0 ${W},0 ${W},${h - slant} 0,${h}" fill="${fill}"/></svg>`);
  await sharp({ create: { width: W, height: bottom, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: shown, left: vis.x1, top: vis.y1 },
      { input: edge(bottom, '#000'), blend: 'dest-in' },
    ])
    .png()
    .toFile(out);
  await sharp(edge(bottom + 18, color)).png().toFile(stripeOut);
  return { ...vis, y2: Math.min(vis.y2, bottom - slant) };
}

// The photo under `box` blurred, with the ground over it as opaque as the text needs,
// rounded: a frosted panel the text sits on.
export async function frostedPanel(file: string, frame: Fit, box: Rect, color: string, ink: string, radius: number, out: string): Promise<void> {
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  const left = clamp(box.x1 - frame.x, 0, frame.w - width);
  const top = clamp(box.y1 - frame.y, 0, frame.h - height);
  const behind = await sharp(file).rotate().resize(frame.w, frame.h, { fit: 'fill' }).extract({ left, top, width, height }).blur(24).png().toBuffer();
  let panel = behind;
  for (const opacity of [0.72, 0.82, 0.9, 0.96]) {
    const veil = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${color}" fill-opacity="${opacity}"/></svg>`);
    panel = await sharp(behind).composite([{ input: veil }]).png().toBuffer();
    if (await readable(panel, ink)) break;
  }
  const shape = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#000"/></svg>`);
  await sharp(panel).ensureAlpha().composite([{ input: shape, blend: 'dest-in' }]).png().toFile(out);
}

// A big circle behind a cutout, tone on tone with the ground (a full accent disc
// behind every product shouted), kept off the text above it.
async function disc(file: string, color: string, product: Rect, top: number): Promise<void> {
  const pw = product.x2 - product.x1;
  const ph = product.y2 - product.y1;
  const d = Math.round(Math.min(W - 2 * M, Math.max(pw * 1.15, ph * 0.8)));
  const cx = (product.x1 + product.x2) / 2;
  const cy = Math.max(top + d / 2, product.y1 + ph * 0.45);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><circle cx="${Math.round(cx)}" cy="${Math.round(cy)}" r="${Math.round(d / 2)}" fill="${color}"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

// A product's own pixels (`content`, 0..1 of the photo) contained and centered in `box`.
function contain(img: { width: number; height: number }, box: Rect, content: Rect, pad: number, photoScale = 1): Fit {
  const bw = box.x2 - box.x1;
  const bh = box.y2 - box.y1;
  const s = Math.min((bw - 2 * pad) / ((content.x2 - content.x1) * img.width), (bh - 2 * pad) / ((content.y2 - content.y1) * img.height), MAX_CUT) * photoScale;
  const w = Math.round(img.width * s);
  const h = Math.round(img.height * s);
  return { x: Math.round((box.x1 + box.x2) / 2 - ((content.x1 + content.x2) / 2) * w), y: Math.round((box.y1 + box.y2) / 2 - ((content.y1 + content.y2) / 2) * h), w, h };
}

// The photo at its size on the slide, scaled here with Lanczos (and sharpened when it
// grows) instead of GIMP's cubic, which turned small website photos into mush.
export async function crisp(file: string, frame: Fit, out: string): Promise<string> {
  const { width = 1, height = 1, orientation } = await sharp(file).metadata();
  const native = orientation && orientation >= 5 ? height : width;
  let img = sharp(file).rotate().resize(frame.w, frame.h, { fit: 'fill', kernel: 'lanczos3' });
  if (frame.w > native * 1.05) img = img.sharpen({ sigma: 0.7 });
  await img.png().toFile(out);
  return out;
}

// The director gave the middle slides one skeleton: real photos under the text
// (photo_band) unless every one of them is a product on a card.
function bandSkeleton(run: Run): boolean {
  return !!run.plan?.slides.slice(1, -1).some((s) => s.layout === 'photo_band' && !run.photos.find((p) => p.id === s.photo)?.backdrop && !!s.photo);
}

export function onSlide(r: Rect, f: Fit): Rect {
  return { x1: Math.round(f.x + r.x1 * f.w), y1: Math.round(f.y + r.y1 * f.h), x2: Math.round(f.x + r.x2 * f.w), y2: Math.round(f.y + r.y2 * f.h) };
}

function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
}

// What must stay whole: the subject and the faces, with a little air, inside the photo.
export function keepBox(boxes: Rect[] | undefined): Rect | undefined {
  if (!boxes?.length) return undefined;
  const u = { x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) };
  const ax = (u.x2 - u.x1) * 0.04;
  const ay = (u.y2 - u.y1) * 0.04;
  return { x1: Math.max(0, u.x1 - ax), y1: Math.max(0, u.y1 - ay), x2: Math.min(1, u.x2 + ax), y2: Math.min(1, u.y2 + ay) };
}

// The part of the photo that shows in `region`, its inner edges fading into the
// ground (the slide's own borders stay sharp); every fade ends before `keep` (on the
// slide), so the subject and the faces are never faded. Returns where the layer goes.
async function regionPhoto(file: string, frame: Fit, region: Rect, out: string, keep?: Rect): Promise<Rect> {
  const vis = {
    x1: Math.max(frame.x, region.x1, 0),
    y1: Math.max(frame.y, region.y1, 0),
    x2: Math.min(frame.x + frame.w, region.x2, W),
    y2: Math.min(frame.y + frame.h, region.y2, H),
  };
  const width = vis.x2 - vis.x1;
  const height = vis.y2 - vis.y1;
  const rgb = await sharp(file)
    .rotate()
    .resize(frame.w, frame.h, { fit: 'fill' })
    .extract({ left: vis.x1 - frame.x, top: vis.y1 - frame.y, width, height })
    .removeAlpha()
    .raw()
    .toBuffer();
  const room = keep ? { top: keep.y1 - vis.y1, bottom: vis.y2 - keep.y2, left: keep.x1 - vis.x1, right: vis.x2 - keep.x2 } : undefined;
  const limit = (len: number, side: 'top' | 'bottom' | 'left' | 'right') => (len && room ? clamp(room[side] - 8, 24, len) : len);
  const fade = {
    top: limit(vis.y1 > 0 ? (vis.y1 === region.y1 ? 160 : 70) : 0, 'top'),
    bottom: limit(vis.y2 < H ? 120 : 0, 'bottom'),
    left: limit(vis.x1 > 0 ? 120 : 0, 'left'),
    right: limit(vis.x2 < W ? 120 : 0, 'right'),
  };
  const ramp = (d: number, len: number) => (len ? Math.min(1, d / len) : 1);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const vy = Math.min(ramp(y, fade.top), ramp(height - 1 - y, fade.bottom));
    for (let x = 0; x < width; x++) {
      const t = Math.min(vy, ramp(x, fade.left), ramp(width - 1 - x, fade.right));
      const i = y * width + x;
      rgba[i * 4] = rgb[i * 3];
      rgba[i * 4 + 1] = rgb[i * 3 + 1];
      rgba[i * 4 + 2] = rgb[i * 3 + 2];
      rgba[i * 4 + 3] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(out);
  return vis;
}

export type SlideInput = {
  run: Run;
  system: DesignSystem;
  slide: SlidePlan;
  photo?: Photo;
  // Where the photo's subject and faces are (0..1 of the photo): they stay whole and uncovered.
  avoid?: Rect[];
  // The faces alone (0..1 of the photo): no gradient or fade goes over them.
  faces?: Rect[];
  focus?: { x: number; y: number };
  // The photo's subject cut out in place (Photo.aligned), for a reference's title behind it.
  person?: string;
};

// Where everything went, for the lint and the fixer.
export type Built = {
  layout: Layout;
  ground: string;
  ink: string;
  // The whole photo's frame on the slide (the layer may show only part of it).
  photoFrame?: Fit;
  textBand: 'top' | 'bottom' | 'middle' | 'under';
  split: boolean;
  // How the slide really came out, which the variety rules count (variety.ts).
  shape: Shape;
  card?: Rect;
  // On the slide: the product's own pixels (cutouts) and what must stay whole (subject, faces).
  product?: Rect;
  subject?: Rect;
  // Where the photo shows.
  visible?: Rect;
  text: Rect;
  // Where the decor element's square shows (it bleeds off a corner on purpose).
  decor?: Rect;
  textScale: number;
  photoCropped: boolean;
  align: 'center' | 'left';
  // Laid out after the owner's reference (layout.ts): its own margins, not the template's.
  free?: boolean;
};

export type Shape = 'text' | 'card' | 'cutout' | 'split' | 'window' | 'photo_top' | 'stacked' | 'overlay' | 'reference';

type Part = { kind: 'number' | 'eyebrow' | 'headline' | 'body' | 'swipe' | 'button'; name: string; w: number; h: number; y: number; top: number };

// Builds one slide from its template in the GIMP image already open (a blank slide).
export async function buildSlide(gimp: Gimp, input: SlideInput): Promise<Built> {
  const { run, system, slide, photo } = input;
  // The reference imitated in HTML: every object it has, drawn; the slide comes into GIMP as
  // one layer. Off with HTML_SLIDES=0; any failure falls back to the plan and the templates.
  if (system.htmlRef && process.env.HTML_SLIDES !== '0' && run.plan) {
    // Every slide in the same reference: a failed page is drawn once more before a template.
    const plan = run.plan;
    const reference = system.htmlRef;
    const draw = () => designHtmlSlide({
      run,
      plan,
      slide,
      reference,
      photo: photo && { path: photo.path, cutout: !!photo.cutout && !photo.matte, note: photo.note },
      logo: run.logo?.path,
      colors: run.brief.brandColors?.length ? run.brief.brandColors : [system.base, system.accent, system.ink],
      critique: slide.critique,
      master: slide.n === plan.slides[1]?.n ? undefined : system.htmlMaster,
      decor: { backdrop: system.decor?.backdropFile, texture: system.decor?.textureFile, element: system.decor?.elementFile },
    }).catch(() => undefined);
    const made = (await draw()) ?? (await draw());
    if (made) {
      if (slide.n === plan.slides[1]?.n) system.htmlMaster = made.html;
      await gimp.python(`_img = Gimp.get_images()[0]
${LIB}
for _old in [_l for _l in _img.get_layers() if _l.get_name() != 'Background']:
    _img.remove_layer(_old)
_image('Design', ${JSON.stringify(made.png)}, 0, 0, ${W}, ${H}, 0)
Gimp.displays_flush()
_result = True`);
      return {
        layout: slide.layout ?? 'photo_band',
        ground: system.base,
        ink: system.ink,
        textBand: 'middle',
        split: false,
        shape: 'reference',
        visible: { x1: 0, y1: 0, x2: W, y2: H },
        text: { x1: 48, y1: 48, x2: W - 48, y2: H - 48 },
        textScale: 1,
        photoCropped: false,
        align: system.align,
        free: true,
      };
    }
  }
  // A reference the owner picked holds even when a slide starts over: they chose that look.
  if (system.layout && (!slide.fresh || !!run.brief.reference)) {
    const built = await buildFromLayout(gimp, input, system.layout);
    if (built) return built;
  }
  const tweaks = slide.tweaks ?? {};
  const dir = path.join(run.dir, 'build');
  await mkdir(dir, { recursive: true });
  const layout: Layout = slide.layout ?? (photo ? 'photo_band' : 'poster');
  // In a set of real photos the text goes on top and a studio product takes the photo's frame.
  // The call to action too: it closes in the carousel's own skeleton. It used to go in a short
  // card where a tall photo shrank between blurred sides, the same last slide every time.
  const banded = bandSkeleton(run);
  // The cutout composition: the subject cut out of its photo, standing on the color block.
  const cutPoster = !!photo?.cutout && !photo.matte && cutsOut(system, layout);
  const inCard = !!photo && !photo.backdrop && !cutPoster && ((!!photo.cutout && !banded) || layout === 'product' || layout === 'hero' || (layout === 'cta' && !banded));
  // A transparent product always stands loose on the ground: the owner read the card as a catalog.
  const clear = !!photo?.cutout && !photo.matte;
  const loose = inCard && clear;
  const left = system.align === 'left';
  const place = left ? '_left' : '_center';
  const R = system.radius;
  const pal = paletteFor(system, layout);
  const ground = pal.ground;
  const ink = pal.ink;
  const accentText = contrast(pal.accent, ground) >= 3 ? pal.accent : ink;
  const logo = await slideLogo(run, ground, ink);
  const heroLogo = !!logo && layout === 'cta' && !photo;
  const logoScale = tweaks.logoScale ?? 1;
  const logoH = Math.round(70 * logoScale);
  const logoY = system.logoPosition === 'top_center' ? 74 : H - 74 - logoH;
  const topSafe = logo && !heroLogo && system.logoPosition === 'top_center' ? logoY + logoH + 46 : 110;
  const bottomSafe = logo && !heroLogo && system.logoPosition === 'bottom_center' ? logoY - 40 : H - M;
  const avail = bottomSafe - topSafe;
  const pill = system.device === 'pill_label';
  const underline = system.device === 'underline';
  const dims = photo ? await size(photo.path) : { width: 1, height: 1 };
  const keep = photo && !photo.cutout && !photo.backdrop ? keepBox(input.avoid) : undefined;
  // A hard edge may crop a body, never a face; lively brands get it slanted.
  const faceKeep = photo && !photo.cutout && !photo.backdrop ? keepBox(input.faces) : undefined;
  // A subject as wide as the photo is a scene (a set table, a terrace): a full-bleed overlay may
  // crop its sides like any ad does; only the faces must stay whole.
  const kept = system.composition === 'overlay' && !!keep && keep.x2 - keep.x1 > 0.7 ? faceKeep : keep;
  const slant = system.personality === 'bold' || system.personality === 'friendly' || system.personality === 'modern' ? 96 : 0;
  // A photo too small to fill the slide's width (or the whole slide, for the overlay) without
  // pixelating goes in a window at its own size; a website banner too, whole and never veiled.
  const needed = system.composition === 'overlay' ? Math.max(W / dims.width, H / dims.height) : Math.max(W / dims.width, 640 / dims.height);
  const small = !!photo && !photo.cutout && !photo.backdrop && needed > MAX_UP;
  // A transparent product needs no window: it stands on the ground under the text.
  const framed = !!photo && (photo.backdrop || small || (system.composition === 'window' && !clear));

  let textScale = 1;
  for (let attempt = 0; ; attempt++) {
    const parts = await measure(gimp, input, layout, textScale, accentText, pal);
    const total = parts.reduce((sum, p, i) => sum + p.h + (i ? p.top : 0), 0);
    const last = attempt === 3;

    // The layout: where the text block starts and where the photo goes.
    let y0 = 0;
    let textBand: Built['textBand'] = 'middle';
    let split = false;
    let card: Rect | undefined;
    let frame: Fit | undefined;
    let region: Rect | undefined;
    let fits = true;
    let windowed = false;
    let edged = false;
    // The photo on top with a hard edge, the text on the solid ground below.
    const edge = () => {
      split = true;
      edged = true;
      textBand = 'bottom';
      y0 = bottomSafe - total;
      region = { x1: 0, y1: 0, x2: W, y2: y0 - 64 };
      fits = region.y2 - slant >= (layout === 'cover' ? 600 : 540);
      frame = faceKeep ? fitWhole(dims, region, faceKeep, tweaks.photoScale ?? 1) : coverAt(dims, region, input.focus);
    };
    if (!photo) {
      const area = heroLogo ? [560, bottomSafe] : [topSafe, bottomSafe];
      fits = total <= area[1] - area[0];
      y0 = Math.round((area[0] + area[1]) / 2 - total / 2);
    } else if (inCard) {
      // The same card on every product slide; if the text doesn't fit under it, the
      // text gets smaller, and only as a last resort the card.
      const gap = 56;
      const fixed = layout === 'cta' ? CARD.cta : layout === 'hero' && loose ? CARD.hero : CARD.product;
      fits = fixed + gap + total <= avail;
      const cardH = fits ? fixed : Math.max(380, avail - gap - total);
      card = { x1: M, y1: topSafe + 10, x2: W - M, y2: topSafe + 10 + cardH };
      y0 = card.y2 + gap;
      textBand = 'under';
    } else if (cutPoster) {
      // The text on the ground at the top, the subject big below it: cut at the waist it
      // stands on the slide's bottom edge, whole it stands a little above it with a shadow.
      split = true;
      textBand = 'top';
      y0 = topSafe;
      const foot = logo && !heroLogo && system.logoPosition === 'bottom_center' ? logoY - 24 : H;
      // Only a person cut at the waist: a bike whose wheels touch its photo's edge stays whole.
      const grounded = !!photo.grounded && !!photo.person && foot === H;
      region = { x1: 40, y1: y0 + total + 36, x2: W - 40, y2: grounded ? H : foot - 40 };
      fits = region.y2 - region.y1 >= (layout === 'cover' ? 620 : 560);
      frame = contain(dims, region, photo.content ?? FULL, 0, tweaks.photoScale ?? 1);
      frame.y = region.y2 - frame.h;
      if (grounded) {
        // Already cut at the bottom, it can grow and bleed off the foot: the head stays
        // where the area starts, the body is cropped by the slide's edge like in an ad.
        const grow = clamp((W * 0.78) / frame.w, 1, clamp((MAX_CUT * dims.width) / frame.w, 1, 1.6));
        const cx = frame.x + frame.w / 2;
        frame = { w: Math.round(frame.w * grow), h: Math.round(frame.h * grow), x: 0, y: region.y1 };
        frame.x = Math.round(cx - frame.w / 2);
      }
    } else if (framed) {
      // Editorial: the photo in a window inside the margins and the text beside it,
      // never over it. Where the subject can't be cropped, or the photo is too small to
      // grow, the window narrows to the photo instead of filling the rest with a blur.
      split = true;
      windowed = true;
      textBand = tweaks.band === 'top' ? 'top' : 'bottom';
      y0 = textBand === 'top' ? topSafe : bottomSafe - total;
      const area: Rect = textBand === 'top' ? { x1: M, y1: topSafe + total + 56, x2: W - M, y2: bottomSafe } : { x1: M, y1: topSafe, x2: W - M, y2: y0 - 56 };
      fits = area.y2 - area.y1 >= (layout === 'cover' ? 560 : 520);
      if (photo.cutout) {
        frame = contain(dims, area, photo.content ?? FULL, 56, tweaks.photoScale ?? 1);
        card = area;
      } else {
        // A banner is shown whole: its baked-in text is never cut.
        frame = fitWhole(dims, area, photo.backdrop ? FULL : keep, tweaks.photoScale ?? 1, photo.backdrop ? 0 : 24, MAX_UP);
        card = { x1: Math.max(area.x1, frame.x), y1: Math.max(area.y1, frame.y), x2: Math.min(area.x2, frame.x + frame.w), y2: Math.min(area.y2, frame.y + frame.h) };
      }
      region = card;
    } else if ((system.composition === 'split' || system.composition === 'cutout') && !photo.cutout && tweaks.band !== 'top') {
      // A cutout composition lands here only where SAM couldn't cut the subject out.
      edge();
    } else if (system.composition === 'photo_top' && tweaks.band !== 'top') {
      // The photo from the slide's top edge down, fading into the ground above the text
      // ("split", the text off the photo, is already this).
      split = true;
      textBand = 'bottom';
      y0 = bottomSafe - total;
      region = { x1: 0, y1: 0, x2: W, y2: y0 - 48 };
      fits = region.y2 - region.y1 >= (layout === 'cover' ? 600 : 540);
      frame = photo.cutout ? contain(dims, { ...region, y1: 60 }, photo.content ?? FULL, 56, tweaks.photoScale ?? 1) : fitWhole(dims, region, keep, tweaks.photoScale ?? 1);
    } else {
      const full = cover(dims, input.focus);
      const k = kept ? onSlide(kept, full) : undefined;
      // Whole means inside the slide, unless the photo itself ends there.
      const whole = !k || ((k.x1 >= 12 || k.x1 <= full.x) && (k.y1 >= 12 || k.y1 <= full.y) && (k.x2 <= W - 12 || k.x2 >= full.x + full.w) && (k.y2 <= H - 12 || k.y2 >= full.y + full.h));
      const band = (top: boolean): Rect => (top ? { x1: M, y1: topSafe, x2: W - M, y2: topSafe + total } : { x1: M, y1: bottomSafe - total, x2: W - M, y2: bottomSafe });
      const covers = (r: Rect) => (k ? overlap(r, k) / ((r.x2 - r.x1) * (r.y2 - r.y1)) : 0);
      // The stacked set keeps its text on top; the overlay always at the bottom.
      const top =
        tweaks.band === 'top' ||
        // A dark overlay reads at the bottom; a light one's panel goes where it covers the subject least.
        (tweaks.band !== 'bottom' && (system.composition !== 'overlay' || luminance(ground) > 0.5) && ((banded && system.composition === 'stacked') || covers(band(true)) < covers(band(false))));
      // The gradient reaches 170 px past the text (a shadow under it, not a veil over the photo): it can't darken a face either.
      const faces = (input.faces ?? []).map((f) => onSlide(f, full));
      const reach = system.composition === 'overlay' && luminance(ground) > 0.5 ? 56 : 170;
      const gradientZone: Rect = top ? { x1: 0, y1: 0, x2: W, y2: topSafe + total + reach } : { x1: 0, y1: bottomSafe - total - reach, x2: W, y2: H };
      const logoBox: Rect = { x1: W / 2 - 120 * logoScale - 22, y1: logoY - 14, x2: W / 2 + 120 * logoScale + 22, y2: logoY + logoH + 14 };
      const blocked = covers(band(top)) > 0.1 || faces.some((f) => overlap(f, gradientZone) > 0) || (!!logo && !!k && overlap(logoBox, k) > 0);
      split = !!photo.cutout || tweaks.band === 'split' || (tweaks.band !== 'top' && tweaks.band !== 'bottom' && (!whole || blocked));
      if (split && system.composition === 'overlay' && !photo.cutout) {
        // An overlay slide that can't take its text over the photo (a person standing
        // the whole height) keeps the text at the bottom on the ground, under a hard edge:
        // the fade here made every overlay brand look like photo_top.
        edge();
      } else if (split && system.composition === 'overlay') {
        y0 = bottomSafe - total;
        textBand = 'bottom';
        region = { x1: 0, y1: 0, x2: W, y2: y0 - 48 };
        fits = region.y2 - region.y1 >= (layout === 'cover' ? 600 : 540);
        frame = photo.cutout ? contain(dims, { ...region, y1: 60 }, photo.content ?? FULL, 56, tweaks.photoScale ?? 1) : fitWhole(dims, region, keep, tweaks.photoScale ?? 1);
      } else if (split) {
        // Text on the ground above, the photo below with its subject whole, fading into the ground.
        y0 = topSafe;
        textBand = 'top';
        region = { x1: 0, y1: topSafe + total + 48, x2: W, y2: logo && !heroLogo && system.logoPosition === 'bottom_center' ? logoY - 24 : H };
        // The cover's photo is the hook: it keeps most of the slide.
        fits = region.y2 - region.y1 >= (layout === 'cover' ? 600 : 540);
        frame = photo.cutout ? contain(dims, region, photo.content ?? FULL, 56, tweaks.photoScale ?? 1) : fitWhole(dims, region, keep, tweaks.photoScale ?? 1);
      } else {
        frame = full;
        textBand = top ? 'top' : 'bottom';
        y0 = textBand === 'top' ? topSafe : bottomSafe - total;
        fits = total <= H * 0.45;
      }
    }
    if (!fits && !last) {
      textScale *= 0.88;
      continue;
    }

    // Drawing: the lower layers (inserted top to bottom right above the Background),
    // then the text in place with its shapes, then the logo.
    const code: string[] = ['_img = Gimp.get_images()[0]', LIB];
    let product: Rect | undefined;
    let visible: Rect | undefined;
    if (photo && inCard && card) {
      const cw = card.x2 - card.x1;
      const ch = card.y2 - card.y1;
      if (photo.cutout) {
        // The product's own pixels (its margins trimmed) contained and centered in the card.
        const c = photo.content ?? FULL;
        frame = contain(dims, card, c, loose ? 24 : 56, tweaks.photoScale ?? 1);
        product = onSlide(c, frame);
        const sharpPhoto = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
        code.push(`_p = _image('Photo', ${py(sharpPhoto)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, _bgpos())`);
        if (!loose) code.push(`_round_mask(_p, ${card.x1}, ${card.y1}, ${cw}, ${ch}, ${Math.max(1, R)})`);
        if (!photo.matte) {
          // A transparent cutout stands on the ground (or its light card) with a soft shadow.
          const shade = path.join(dir, `s${slide.n}-shadow.png`);
          const sw = Math.round((product.x2 - product.x1) * 0.8);
          const cx = Math.round((product.x1 + product.x2) / 2);
          await shadow(shade, sw);
          code.push(`_s = _image('Shadow', ${py(shade)}, ${Math.round(cx - (sw + 120) / 2)}, ${product.y2 - 70}, ${sw + 120}, 120, _bgpos())`);
          if (!loose) code.push(`_round_mask(_s, ${card.x1}, ${card.y1}, ${cw}, ${ch}, ${Math.max(1, R)})`);
        }
        if (layout === 'hero') {
          // A giant ghost word behind the product: the label, or the headline's longest word.
          // It used to be sized for 1240 px, wider than the slide: always cut by the edges.
          const label = slide.eyebrow?.trim().split(/\s+/).length === 1 ? slide.eyebrow.trim().toUpperCase() : undefined;
          const ghost = ghostPlace(label && label.length <= 12 ? label : ghostWord(slide), product, card.y1);
          // Tone on tone with the ground, like the word behind a cutout: the pure accent shouted.
          const tone = luminance(ground) > 0.5 ? mix(ground, pal.accent, 0.2) : mix(ground, '#ffffff', 0.15);
          if (ghost) {
            code.push(`_g = _text('Ghost', ${py(ghost.word)}, ${py(system.gimpHeading ?? 'Sans-serif Bold')}, ${ghost.size}, ${py(tone)}, 99999, -0.1, -0.02, 40)`);
            code.push(`_g.set_opacity(100)
_img.reorder_item(_g, None, _bgpos() - 1)
_g.set_offsets(int(${W / 2} - _g.get_width() / 2), max(${card.y1}, int(${ghost.cy} - _g.get_height() / 2)))`);
          }
        }
        if (!loose) code.push(`_shape('Card', ${card.x1}, ${card.y1}, ${cw}, ${ch}, ${py(photo.matte ?? CARD_LIGHT)}, ${R}, _bgpos())`);
        visible = card;
      } else {
        // A real photo: covering the card with its subject whole; where it can't, the
        // same photo blurred fills the card behind it. Too small to cover it, the card
        // shrinks to the photo and the text follows it up.
        frame = fitWhole(dims, card, keep, tweaks.photoScale ?? 1, 24, MAX_UP);
        if (frame.w < cw && frame.h < ch) {
          card = { x1: frame.x, y1: card.y1, x2: frame.x + frame.w, y2: card.y1 + frame.h };
          frame.y = card.y1;
          y0 = card.y2 + 56;
        }
        const cw2 = card.x2 - card.x1;
        const ch2 = card.y2 - card.y1;
        const sharpPhoto = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
        code.push(`_p = _image('Photo', ${py(sharpPhoto)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, _bgpos())`);
        code.push(`_round_mask(_p, ${card.x1}, ${card.y1}, ${cw2}, ${ch2}, ${Math.max(1, R)})`);
        if (frame.x > card.x1 || frame.y > card.y1 || frame.x + frame.w < card.x2 || frame.y + frame.h < card.y2) {
          const fill = path.join(dir, `s${slide.n}-cardfill.png`);
          await sharp(photo.path).rotate().resize(cw2, ch2, { fit: 'cover' }).blur(30).modulate({ brightness: 0.75 }).png().toFile(fill);
          code.push(`_c = _image('Card', ${py(fill)}, ${card.x1}, ${card.y1}, ${cw2}, ${ch2}, _bgpos())`);
          code.push(`_round_mask(_c, ${card.x1}, ${card.y1}, ${cw2}, ${ch2}, ${Math.max(1, R)})`);
        }
        visible = card;
      }
    } else if (photo && frame && windowed && card) {
      const cw = card.x2 - card.x1;
      const ch = card.y2 - card.y1;
      const sharpPhoto = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
      code.push(`_p = _image('Photo', ${py(sharpPhoto)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, _bgpos())`);
      code.push(`_round_mask(_p, ${card.x1}, ${card.y1}, ${cw}, ${ch}, ${Math.max(1, R)})`);
      if (photo.cutout) {
        product = onSlide(photo.content ?? FULL, frame);
        code.push(`_shape('Card', ${card.x1}, ${card.y1}, ${cw}, ${ch}, ${py(photo.matte ?? CARD_LIGHT)}, ${R}, _bgpos())`);
      }
      visible = card;
    } else if (photo && frame && cutPoster && region) {
      product = onSlide(photo.content ?? FULL, frame);
      const sharpPhoto = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
      code.push(`_image('Photo', ${py(sharpPhoto)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, _bgpos())`);
      if (product.y2 < H) {
        const shade = path.join(dir, `s${slide.n}-shadow.png`);
        const sw = Math.round((product.x2 - product.x1) * 0.8);
        await shadow(shade, sw);
        code.push(`_image('Shadow', ${py(shade)}, ${Math.round((product.x1 + product.x2) / 2 - (sw + 120) / 2)}, ${product.y2 - 70}, ${sw + 120}, 120, _bgpos())`);
      }
      // A complementary accent mixed in turns grey: on a dark ground the tone is the ground, lighter.
      const tone = luminance(ground) > 0.5 ? mix(ground, pal.accent, 0.2) : mix(ground, '#ffffff', 0.15);
      const ghost = ghostPlace(ghostWord(slide), product, region.y1);
      if (ghost) {
        // Depth: a giant word in the ground's own tone behind the subject, as wide as the slide.
        code.push(`_g = _text('Ghost', ${py(ghost.word)}, ${py(system.gimpHeading ?? 'Sans-serif Bold')}, ${ghost.size}, ${py(tone)}, ${W - 40}, -0.1, -0.02, 120)
_img.reorder_item(_g, None, _bgpos() - 1)
_g.set_offsets(int(${W / 2} - _g.get_width() / 2), max(${region.y1}, int(${ghost.cy} - _g.get_height() / 2)))`);
      } else {
        const circle = path.join(dir, `s${slide.n}-disc.png`);
        await disc(circle, tone, product, region.y1);
        code.push(`_image('Disc', ${py(circle)}, 0, 0, ${W}, ${H}, _bgpos())`);
      }
      visible = region;
    } else if (photo && frame && edged && region) {
      const file = path.join(dir, `s${slide.n}-photo.png`);
      const stripe = path.join(dir, `s${slide.n}-stripe.png`);
      visible = await edgePhoto(photo.path, frame, region.y2, slant, file, stripe, pal.accent);
      code.push(`_image('Photo', ${py(file)}, 0, 0, ${W}, ${region.y2}, _bgpos())`);
      code.push(`_image('Stripe', ${py(stripe)}, 0, 0, ${W}, ${region.y2 + 18}, _bgpos())`);
    } else if (photo?.cutout && frame && split && region) {
      product = onSlide(photo.content ?? FULL, frame);
      if (photo.matte) {
        // A studio shot fills the photo area with its own background and fades like the real photos.
        const rw = region.x2 - region.x1;
        const rh = region.y2 - region.y1;
        const plate = path.join(dir, `s${slide.n}-plate.png`);
        // Scaled to the product, the whole shot (its margins too) can outgrow the area: only the part inside it.
        const dx = frame.x - region.x1;
        const dy = frame.y - region.y1;
        const cut = { left: Math.max(0, -dx), top: Math.max(0, -dy), width: Math.min(frame.w - Math.max(0, -dx), rw - Math.max(0, dx)), height: Math.min(frame.h - Math.max(0, -dy), rh - Math.max(0, dy)) };
        const shot = await sharp(photo.path).rotate().resize(frame.w, frame.h, { fit: 'fill' }).extract(cut).png().toBuffer();
        await sharp({ create: { width: rw, height: rh, channels: 3, background: photo.matte } })
          .composite([{ input: shot, left: Math.max(0, dx), top: Math.max(0, dy) }])
          .png()
          .toFile(plate);
        const file = path.join(dir, `s${slide.n}-photo.png`);
        visible = await regionPhoto(plate, { x: region.x1, y: region.y1, w: rw, h: rh }, region, file, product);
        code.push(`_image('Photo', ${py(file)}, ${visible.x1}, ${visible.y1}, ${visible.x2 - visible.x1}, ${visible.y2 - visible.y1}, _bgpos())`);
      } else {
        // A transparent product stands on the ground with a soft shadow.
        const shade = path.join(dir, `s${slide.n}-shadow.png`);
        const sw = Math.round((product.x2 - product.x1) * 0.8);
        await shadow(shade, sw);
        const sharpPhoto = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
        code.push(`_image('Photo', ${py(sharpPhoto)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, _bgpos())`);
        code.push(`_image('Shadow', ${py(shade)}, ${Math.round((product.x1 + product.x2) / 2 - (sw + 120) / 2)}, ${product.y2 - 70}, ${sw + 120}, 120, _bgpos())`);
        visible = region;
      }
    } else if (photo && frame && split && region) {
      const file = path.join(dir, `s${slide.n}-photo.png`);
      visible = await regionPhoto(photo.path, frame, region, file, keep ? onSlide(keep, frame) : undefined);
      code.push(`_image('Photo', ${py(file)}, ${visible.x1}, ${visible.y1}, ${visible.x2 - visible.x1}, ${visible.y2 - visible.y1}, _bgpos())`);
      if (frame.x > 0 || frame.x + frame.w < W) {
        // Narrower than the slide: the same photo, blurred and dimmed, fills the sides.
        const fill = path.join(dir, `s${slide.n}-fill.png`);
        const fillFrame = { x: 0, y: region.y1, w: W, h: region.y2 - region.y1 };
        const blurred = path.join(dir, `s${slide.n}-blur.png`);
        await sharp(photo.path).rotate().resize(fillFrame.w, fillFrame.h, { fit: 'cover' }).blur(40).modulate({ brightness: 0.55 }).png().toFile(blurred);
        const vis = await regionPhoto(blurred, fillFrame, region, fill);
        code.push(`_image('Photo fill', ${py(fill)}, ${vis.x1}, ${vis.y1}, ${vis.x2 - vis.x1}, ${vis.y2 - vis.y1}, _bgpos())`);
      }
    } else if (photo && frame) {
      if (luminance(ground) > 0.5) {
        // A light brand over a full-bleed photo: the text on a frosted panel of its ground,
        // the photo blurred behind it (a light gradient was a pale veil over the photo).
        const tw = Math.max(...parts.map((p) => (p.kind === 'button' ? Math.min(TEXT_W, p.w + 120) : p.kind === 'eyebrow' && pill ? p.w + 56 : p.w)));
        const padX = left ? 40 : 64;
        const pw = Math.min(W - 80, tw + 2 * padX);
        const box: Rect = { x1: left ? 40 : Math.round(W / 2 - pw / 2), y1: Math.max(24, y0 - 56), x2: 0, y2: Math.min(H - 24, y0 + total + 56) };
        box.x2 = box.x1 + pw;
        // The logo on the panel's side sits inside it, as in a signed card.
        if (logo && !heroLogo && textBand === 'bottom' && system.logoPosition === 'bottom_center') box.y2 = Math.min(H - 24, logoY + logoH + 28);
        if (logo && !heroLogo && textBand === 'top' && system.logoPosition === 'top_center') box.y1 = Math.max(24, logoY - 28);
        const file = path.join(dir, `s${slide.n}-panel.png`);
        await frostedPanel(photo.path, frame, box, ground, ink, Math.max(28, R), file);
        code.push(`_image('Panel', ${py(file)}, ${box.x1}, ${box.y1}, ${box.x2 - box.x1}, ${box.y2 - box.y1}, _bgpos())`);
      } else {
        const grad = path.join(dir, `s${slide.n}-gradient.png`);
        await gradient(grad, ground, textBand === 'top' ? 'top' : 'bottom', textBand === 'top' ? Math.min(H, y0 + total + 170) : Math.max(0, y0 - 170));
        code.push(`_image('Gradient', ${py(grad)}, 0, 0, ${W}, ${H}, _bgpos())`);
      }
      const sharpPhoto = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
      code.push(`_image('Photo', ${py(sharpPhoto)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, _bgpos())`);
      visible = { x1: 0, y1: 0, x2: W, y2: H };
    }

    // A slide of type alone, or a loose product standing in it, sits on the carousel's generated
    // scene (the owner rejected a word repeated in rows behind the text; and liked the scene).
    const backdrop = (!photo || clear) && system.decor?.backdropFile ? await backdropSlice(system.decor.backdropFile, ground, ink, slide.n, { y1: y0 - 40, y2: y0 + total + 40 }, path.join(dir, `s${slide.n}-backdrop.png`)) : undefined;
    if (backdrop) code.push(`_image('Backdrop', ${py(backdrop)}, 0, 0, ${W}, ${H}, _bgpos())`);

    // The text block, placed first so the decor can keep clear of it.
    let y = y0;
    parts.forEach((p, i) => {
      if (i) y += p.top;
      p.y = y;
      y += p.h;
    });
    const textW = Math.max(...parts.map((p) => (p.kind === 'button' ? Math.min(TEXT_W, p.w + 120) : p.kind === 'eyebrow' && pill ? p.w + 56 : p.w)));
    const text: Rect = left ? { x1: M, y1: y0, x2: M + textW, y2: y0 + total } : { x1: Math.round(W / 2 - textW / 2), y1: y0, x2: Math.round(W / 2 + textW / 2), y2: y0 + total };

    // The decor kit, on the ground only: the element and the glow never on a full-bleed photo.
    let decor: Rect | undefined;
    // A window leaves the ground around the photo, where the decor may go.
    const fullBleed = !!photo && !inCard && !windowed && !cutPoster && !edged;
    if (system.decor && !fullBleed && tweaks.decor !== false) {
      if (system.decor.elementFile) {
        const logoBox: Rect = heroLogo
          ? { x1: W / 2 - 220, y1: 250, x2: W / 2 + 220, y2: 480 }
          : { x1: left ? M : W / 2 - 120 * logoScale - 22, y1: logoY - 14, x2: left ? M + 240 * logoScale + 44 : W / 2 + 120 * logoScale + 22, y2: logoY + logoH + 14 };
        const out = path.join(dir, `s${slide.n}-decor.png`);
        const photoArea = edged && region ? { ...region, y2: region.y2 + 18 } : cutPoster ? product : undefined;
        decor = await decorElement(system.decor.elementFile, slide.n, [text, ...(logo ? [logoBox] : []), ...(card ? [card] : []), ...(photoArea ? [photoArea] : [])], out);
        if (decor) code.push(`_image('Decor', ${py(out)}, ${decor.x1}, ${decor.y1}, ${decor.x2 - decor.x1}, ${decor.y2 - decor.y1}, _bgpos())`);
      }
      const light = path.join(dir, `s${slide.n}-glow.png`);
      if (system.decor.glow && !photo && !backdrop && (await glow(light, system.accent, ground, ink, W / 2, (text.y1 + text.y2) / 2))) {
        code.push(`_image('Glow', ${py(light)}, 0, 0, ${W}, ${H}, _bgpos())`);
      }
    }

    // A color slide is its own block: the continuous ground would cover it.
    const groundFile = pal.colored ? undefined : await groundSlice(run, system, slide.n, dir);
    if (groundFile) code.push(`_image('Ground', ${py(groundFile)}, 0, 0, ${W}, ${H}, _bgpos())`);

    for (const p of parts) {
      if (p.kind === 'eyebrow' && pill) {
        const w = p.w + 56;
        const x = left ? M : Math.round(W / 2 - w / 2);
        code.push(`_shape('Label', ${x}, ${p.y}, ${w}, ${p.h}, ${py(pal.accent)}, ${corner(R, p.h)}, _below(_get('Eyebrow')))`);
        code.push(`_get('Eyebrow').set_offsets(${x + 28}, ${p.y + 15})`);
      } else if (p.kind === 'button') {
        const w = Math.min(TEXT_W, p.w + 120);
        const x = left ? M : Math.round(W / 2 - w / 2);
        code.push(`_shape('Button', ${x}, ${p.y}, ${w}, ${p.h}, ${py(pal.accent)}, ${corner(R, p.h)}, _below(_get('Button text')))`);
        if (system.button === 'outline') code.push(`_shape('Button fill', ${x + 4}, ${p.y + 4}, ${w - 8}, ${p.h - 8}, ${py(ground)}, ${Math.max(0, corner(R, p.h) - 4)}, _below(_get('Button text')))`);
        code.push(`_bt = _get('Button text')
_bt.set_offsets(int(${x + w / 2} - _bt.get_width() / 2), ${p.y + 32})`);
      } else {
        code.push(`${place}(_get(${py(p.name)}), ${p.y})`);
        if (p.kind === 'headline' && underline) {
          code.push(`_shape('Underline', ${left ? M : W / 2 - 60}, int(${p.y} + _get('Headline').get_height() + 22), 120, 10, ${py(accentText)}, ${Math.min(5, R)}, _below(_get('Headline')))`);
        }
      }
    }

    // Logo: the same place on every slide; on a text-only call to action it is the hero.
    if (logo) {
      const box = heroLogo ? { x: W / 2 - 220, y: 250, w: 440, h: 230 } : { x: W / 2 - 120 * logoScale, y: logoY, w: 240 * logoScale, h: logoH };
      const s = Math.min(box.w / logo.asset.width, box.h / logo.asset.height);
      const f = { w: Math.round(logo.asset.width * s), h: Math.round(logo.asset.height * s), x: 0, y: 0 };
      f.x = left && !heroLogo ? M : Math.round(box.x + (box.w - f.w) / 2);
      f.y = Math.round(box.y + (box.h - f.h) / 2);
      code.push(`_image('Logo', ${py(logo.asset.path)}, ${f.x}, ${f.y}, ${f.w}, ${f.h})`);
    }
    code.push('Gimp.displays_flush()');
    code.push("_result = {'layers': [_l.get_name() for _l in _img.get_layers()]}");
    await gimp.python(code.join('\n'));

    return {
      layout,
      ground,
      ink,
      photoFrame: frame,
      textBand,
      split,
      shape: !photo ? 'text' : inCard ? 'card' : cutPoster ? 'cutout' : edged ? 'split' : windowed ? 'window' : !split ? 'overlay' : textBand === 'top' ? 'stacked' : 'photo_top',
      card,
      product,
      // Under a hard edge only the faces must stay whole.
      subject: edged
        ? faceKeep && frame
          ? onSlide(faceKeep, frame)
          : undefined
        : cutPoster && product
          ? { ...product, y2: Math.min(product.y2, H) }
          : kept !== keep && frame && !split
            ? kept && onSlide(kept, frame)
            : keep && frame ? onSlide(keep, frame) : !card ? product : undefined,
      visible,
      text,
      decor,
      textScale,
      // A cut product only matters where it is the hero (photo_band and poster may keep it).
      photoCropped: !!photo?.cropped && (inCard || layout === 'cover' || !!photo.cutout),
      align: system.align,
    };
  }
}

// Creates the text layers on a cleared slide and measures them in GIMP.
async function measure(gimp: Gimp, input: SlideInput, layout: Layout, scale: number, accentText: string, pal: ReturnType<typeof paletteFor>): Promise<Part[]> {
  const { run, system, slide } = input;
  const tweaks = slide.tweaks ?? {};
  const pill = system.device === 'pill_label';
  const headingFont = system.gimpHeading ?? 'Sans-serif Bold';
  const bodyFont = system.gimpBody ?? 'Sans-serif';
  const bodyBold = system.gimpBodyBold ?? system.gimpHeading ?? 'Sans-serif Bold';
  const base = { poster: { head: 132, body: 44 }, cover: { head: 104, body: 40 }, photo_band: { head: 96, body: 40 }, product: { head: 84, body: 38 }, hero: { head: 92, body: 38 }, cta: { head: 92, body: 40 } }[layout];
  // Loud: the headline is the ad, poster-sized where the slide opens or closes the set.
  const loud = system.typeScale === 'loud' ? (layout === 'cover' || layout === 'poster' || layout === 'cta' ? 1.3 : 1.15) : 1;
  const head = Math.round(base.head * loud * scale * (tweaks.headScale ?? 1));
  const body = Math.round(base.body * scale * (tweaks.bodyScale ?? 1));
  const perLine = (px: number) => Math.max(8, Math.floor(TEXT_W / (px * 0.56)));
  const headline = system.headlineCase === 'upper' ? slide.headline.toUpperCase() : slide.headline;

  const code: string[] = ['_img = Gimp.get_images()[0]', LIB];
  code.push("for _old in [_l for _l in _img.get_layers() if _l.get_name() != 'Background']:\n    _img.remove_layer(_old)");
  if (system.align === 'left') code.push('_J = Gimp.TextJustification.LEFT');
  code.push(`Gimp.context_set_background(_color(${py(pal.ground)}))\n_get('Background').edit_fill(Gimp.FillType.BACKGROUND)`);
  code.push('_m = {}');
  const add = (name: string, call: string) => code.push(`_t = ${call}\n_m[${py(name)}] = [_t.get_width(), _t.get_height()]`);
  const kinds: Omit<Part, 'w' | 'h' | 'y'>[] = [];
  const order = run.plan ? run.plan.slides.findIndex((s) => s.n === slide.n) : -1;
  if (system.numbers && order > 0 && run.plan && order < run.plan.slides.length - 1 && layout !== 'poster') {
    add('Number', `_text('Number', ${py(String(order).padStart(2, '0'))}, ${py(headingFont)}, ${Math.round(150 * Math.max(0.8, scale))}, ${py(accentText)}, 600, -0.3, -0.02)`);
    kinds.push({ kind: 'number', name: 'Number', top: 0 });
  }
  if (slide.eyebrow?.trim()) {
    add('Eyebrow', `_text('Eyebrow', ${py(slide.eyebrow.trim().toUpperCase())}, ${py(bodyBold)}, ${Math.round(30 * Math.max(0.85, scale))}, ${py(pill ? pal.accentInk : accentText)}, ${TEXT_W - 80}, 0.0, 0.12)`);
    kinds.push({ kind: 'eyebrow', name: 'Eyebrow', top: kinds.length ? 6 : 0 });
  }
  const lines = balance(headline, perLine(head), 3);
  // The words that carry the headline in the accent, when it reads as large text on the ground.
  const markup = accentText !== pal.ink ? markEmphasis(lines, slide.emphasis, accentText) : undefined;
  add('Headline', `_text('Headline', ${py(lines)}, ${py(headingFont)}, ${head}, ${py(pal.ink)}, ${TEXT_W}, -0.18, ${system.tracking}, 44, ${markup ? py(markup) : 'None'})`);
  kinds.push({ kind: 'headline', name: 'Headline', top: pill ? 26 : 18 });
  if (slide.body?.trim()) {
    add('Body', `_text('Body', ${py(balance(slide.body.trim(), perLine(body), 3))}, ${py(bodyFont)}, ${body}, ${py(pal.ink)}, ${TEXT_W - 40}, 0.05, 0.0, 26)\n_t.set_opacity(90)`);
    kinds.push({ kind: 'body', name: 'Body', top: 28 });
  }
  if (layout === 'cover' && run.plan && run.plan.slides.length > 1) {
    add('Swipe', `_text('Swipe', ${py(system.swipeLabel)}, ${py(bodyBold)}, 28, ${py(accentText)}, 400, 0.0, 0.08)`);
    kinds.push({ kind: 'swipe', name: 'Swipe', top: 34 });
  }
  if (layout === 'cta' && slide.button?.trim()) {
    add('Button text', `_text('Button text', ${py(slide.button.trim())}, ${py(bodyBold)}, 40, ${py(system.button === 'outline' ? accentText : pal.accentInk)}, ${TEXT_W - 160}, 0.0, 0.0, 28)`);
    kinds.push({ kind: 'button', name: 'Button text', top: 40 });
  }
  code.push('_result = _m');
  const sizes = (await gimp.python(code.join('\n'))) as Record<string, [number, number]>;
  return kinds.map((k) => {
    const [w, h] = sizes[k.name];
    // The pill and the button add their padding; the underline sits under the headline.
    const extra = k.kind === 'eyebrow' && pill ? 30 : k.kind === 'button' ? 64 : k.kind === 'headline' && system.device === 'underline' ? 38 : 0;
    return { ...k, w, h: h + extra, y: 0 };
  });
}

