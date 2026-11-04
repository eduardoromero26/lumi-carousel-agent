import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { SLIDE } from './config.js';
import { contrast, luminance, readableOn, type DesignSystem } from './design.js';
import type { Gimp } from './gimp.js';
import { slideLogo } from './logo.js';
import { mirrorLayout, type BlockRole, type Box, type LayoutBlock, type RefLayout } from './layout.js';
import type { Run } from './run.js';
import { LIB, MAX_UP, crisp, frostedPanel, ghostWord, keepBox, mix, onSlide, readable, type Built, type Fit, type Rect, type SlideInput } from './templates.js';

// A slide built from the owner's reference plan (layout.ts) instead of a template: the
// photo full-bleed with its subject where the reference has it, every text block in the
// reference's box with its type treatment, the reference's lines and arrows, and a giant
// title the subject stands in front of (the subject cut out by SAM, in place). A product
// poster ("box") instead: the ground in the reference's bands, its giant faded letter, the
// product cut out and standing on the reference's line with a soft shadow, the logo where
// the reference has its own. Undefined when this photo can't take the plan (too small to
// fill the slide, a face under the text): the slide then goes to its template.
const W = SLIDE.width;
const H = SLIDE.height;

// Python helpers for the reference's text: wrapped to its box, shrunk until it fits.
const LAYOUT_LIB = String.raw`
import re as _re
from html import escape as _esc

def _wrap(_words, _f, _size, _maxw, _spacing):
    _lines = []
    _cur = ''
    for _w in _words:
        _try = (_cur + ' ' + _w).strip()
        _t = Gimp.TextLayer.new(_img, _try, _f, float(_size), Gimp.Unit.pixel())
        _img.insert_layer(_t, None, 0)
        _t.set_letter_spacing(_spacing * _size)
        _wd = _t.get_width()
        _img.remove_layer(_t)
        if _wd > _maxw and _cur:
            _lines.append(_cur)
            _cur = _w
        else:
            _cur = _try
    if _cur:
        _lines.append(_cur)
    return '\n'.join(_lines)

def _markup(_text, _emph, _mode, _accent):
    if not _emph or _mode == 'none':
        return None
    _m = _re.search(r'\s+'.join([_re.escape(_w) for _w in _emph.split()]), _text, _re.IGNORECASE)
    if not _m:
        return None
    _open = '<b>' if _mode == 'bold' else '<span foreground="%s">' % _accent
    _close = '</b>' if _mode == 'bold' else '</span>'
    return _esc(_text[:_m.start()]) + _open + _esc(_m.group(0)) + _close + _esc(_text[_m.end():])

def _fit(_name, _content, _font, _size, _hex, _maxw, _maxh, _line, _spacing, _just, _emph, _mode, _accent, _min, _wrapit):
    _f = Gimp.Font.get_by_name(_font)
    while True:
        _txt = _wrap(_content.split(), _f, _size, _maxw, _spacing) if _wrapit else _content
        _t = Gimp.TextLayer.new(_img, _txt, _f, float(_size), Gimp.Unit.pixel())
        _img.insert_layer(_t, None, 0)
        _t.set_justification(_just)
        _t.set_line_spacing(_line * _size)
        _t.set_letter_spacing(_spacing * _size)
        _t.set_color(_color(_hex))
        _mk = _markup(_txt, _emph, _mode, _accent)
        if _mk:
            _t.set_markup(_mk)
        if (_t.get_width() <= _maxw and _t.get_height() <= _maxh) or _size <= _min:
            break
        _img.remove_layer(_t)
        _size = int(_size * 0.92)
    _t.set_name(_name)
    return _t

def _place(_t, _align, _x1, _x2, _y):
    _w = _t.get_width()
    _x = _x1 if _align == 'left' else (_x2 - _w if _align == 'right' else int((_x1 + _x2) / 2 - _w / 2))
    _t.set_offsets(int(_x), int(_y))

def _ring(_name, _x, _y, _d, _hex, _stroke):
    _l = _layer(_name)
    _img.select_ellipse(Gimp.ChannelOps.REPLACE, _x, _y, _d, _d)
    _img.select_ellipse(Gimp.ChannelOps.SUBTRACT, _x + _stroke, _y + _stroke, _d - 2 * _stroke, _d - 2 * _stroke)
    Gimp.context_set_foreground(_color(_hex))
    _l.edit_fill(Gimp.FillType.FOREGROUND)
    Gimp.Selection.none(_img)
    return _l
`;

const py = (v: unknown) => JSON.stringify(v);
const px = (b: Box): Rect => ({ x1: Math.round(b.x1 * W), y1: Math.round(b.y1 * H), x2: Math.round(b.x2 * W), y2: Math.round(b.y2 * H) });
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// What each block says on this slide. The title takes the slide's one-word topic; with
// none, the headline takes its place and the headline block carries the body.
export function blockTexts(slide: SlideInput['slide'], layout: RefLayout, business: string): Partial<Record<BlockRole, string>> {
  const has = (role: BlockRole) => layout.blocks.some((b) => b.role === role);
  const topic = slide.kicker?.trim() || slide.emphasis?.trim();
  const out: Partial<Record<BlockRole, string>> = {};
  if (has('title') && topic) {
    out.title = topic;
    out.headline = slide.headline;
    out.body = slide.body;
  } else if (has('title')) {
    out.title = slide.headline;
    out.headline = slide.body;
  } else {
    out.headline = slide.headline;
    out.body = slide.body;
  }
  if (slide.eyebrow?.trim()) out.label = slide.eyebrow.trim();
  if (slide.layout === 'cta' && slide.button?.trim()) out.cta = slide.button.trim();
  out.signature = business;
  return out;
}

// The block's own font from the pair installed for the reference (art_director.ts).
function fontFor(system: DesignSystem, block: LayoutBlock): string {
  const set = system.layoutFonts?.[block.font] ?? {};
  const want = block.weight === 'light' ? [300, 400, 700] : block.weight === 'bold' ? [700, 400, 300] : [400, 300, 700];
  return want.map((w) => set[w]).find(Boolean) ?? (block.font === 'serif' ? system.gimpHeading : system.gimpBody) ?? 'Sans-serif';
}

const START: Record<BlockRole, number> = { title: 0, headline: 54, body: 40, label: 26, cta: 34, signature: 22 };
const MIN: Record<BlockRole, number> = { title: 60, headline: 36, body: 28, label: 18, cta: 24, signature: 16 };
const NAME: Record<BlockRole, string> = { title: 'Title', headline: 'Headline', body: 'Body', label: 'Eyebrow', cta: 'Button text', signature: 'Signature' };

// The brand's name for its initial: the part of the site's title that is in its domain
// ("Muebles y Equipo para Oficina | Delgado" on mueblesdelgado.com.mx is Delgado).
export function brandName(run: Pick<Run, 'site' | 'brief'>): string {
  const parts = (run.site?.title ?? run.brief.business ?? '').split(/[|\-–·:]/).map((p) => p.trim()).filter(Boolean);
  let host = '';
  try {
    host = new URL(run.brief.url ?? '').hostname.toLowerCase();
  } catch {}
  const compact = (t: string) => t.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  return (parts.find((p) => compact(p).length >= 3 && host.includes(compact(p))) ?? parts[0] ?? '').slice(0, 40);
}

export async function buildFromLayout(gimp: Gimp, input: SlideInput, plan: RefLayout): Promise<Built | undefined> {
  const { run, system, slide } = input;
  // A product poster: the product cut out on the reference's ground, never a banner. Only a
  // reference of cut-out subjects; a photo in a frame (a window, a card) keeps its template.
  // Only a poster the reader measured as one (two-tone ground or a giant letter, like Kauri):
  // other boxed references keep their templates, which are tested.
  const poster = plan.photo.mode === 'box' && system.composition === 'cutout' && (!!system.zones?.length || !!plan.ghost);
  // A banner (text baked in) behind a full-bleed reference: the slide takes the plan on a plain
  // ground instead of falling back to a template the owner didn't pick.
  const photo = !poster && plan.photo.mode === 'full' && input.photo?.backdrop ? undefined : input.photo;
  // A slide without a photo (a call to action, a poster) takes the plan on a plain ground,
  // so the set keeps the reference's type; a product shot or a banner keeps its template.
  if (poster ? photo?.backdrop : plan.photo.mode !== 'full' || (photo && (photo.cutout || photo.backdrop))) return undefined;
  // The subject on the other side of the photo than the reference's: the plan in a mirror.
  const subject = poster ? undefined : keepBox(input.avoid);
  const layout = subject && ((subject.x1 + subject.x2) / 2 - 0.5) * (plan.photo.subjectAt - 0.5) < -0.01 ? mirrorLayout(plan) : plan;

  // The photo covers the slide with its subject where the reference has its own.
  let frame: Fit | undefined;
  if (photo && !poster) {
    const { width = 1, height = 1 } = await sharp(photo.path).metadata();
    const scale = Math.max(W / width, H / height);
    if (scale > MAX_UP) return undefined;
    const fw = Math.round(width * scale);
    const fh = Math.round(height * scale);
    const focus = subject ? { x: (subject.x1 + subject.x2) / 2, y: (subject.y1 + subject.y2) / 2 } : (input.focus ?? { x: 0.5, y: 0.5 });
    frame = { w: fw, h: fh, x: clamp(Math.round(layout.photo.subjectAt * W - focus.x * fw), W - fw, 0), y: clamp(Math.round(H * 0.5 - focus.y * fh), H - fh, 0) };
  }
  const faces = keepBox(input.faces);

  const business = brandName(run);
  const texts = blockTexts(slide, layout, business);
  const blocks = layout.blocks.filter((b) => texts[b.role]?.trim() && !(b.role === 'signature' && run.logo));
  // A call to action the reference has no box for: a button under the lowest text block.
  if (texts.cta && !blocks.some((b) => b.role === 'cta')) {
    const last = blocks.filter((b) => b.role !== 'signature').sort((a, b) => b.box.y2 - a.box.y2)[0];
    // Centered text gets a centered button; otherwise it starts where the text starts.
    const [bx1, bx2] = last && last.align === 'center' ? [0.25, 0.75] : [last?.box.x1 ?? 0, Math.min(1, (last?.box.x1 ?? 0) + 0.5)];
    if (last) blocks.push({ role: 'cta', box: { x1: bx1, y1: Math.min(0.86, last.box.y2 + 0.04), x2: bx2, y2: Math.min(0.9, last.box.y2 + 0.08) }, align: last.align, case: 'as_is', weight: 'bold', font: 'sans', tracking: 0.02, behindSubject: false, emphasis: 'none' });
  }
  const faceBox = faces && frame ? onSlide(faces, frame) : undefined;
  // Text over a face: first the text moves below the face (or above it), the reference's
  // own boxes together, as the reference keeps its text under the face; only then a column
  // narrows to end beside it.
  // A pill or a panel whose words this slide doesn't have reads as an empty bar: it goes.
  const near = (e: { x1: number; y1: number; x2: number; y2: number }) =>
    blocks.some((b) => !(e.x2 < b.box.x1 - 0.02 || e.x1 > b.box.x2 + 0.02 || e.y2 < b.box.y1 - 0.02 || e.y1 > b.box.y2 + 0.02));
  const decor = layout.elements.filter((e) => (e.type !== 'pill' && e.type !== 'panel') || near(e.box));
  // Panels behind the headline's lines are a highlight (a marker under the words), not a card.
  const headBox = blocks.find((b) => b.role === 'headline')?.box;
  const highlight = !!headBox && decor.filter((e) => e.type === 'panel' && e.box.y1 < headBox.y2 && e.box.y2 > headBox.y1).length >= 1 && decor.filter((e) => e.type === 'panel').every((e) => e.box.y2 - e.box.y1 < 0.09);
  if (faceBox && blocks.some((b) => !b.behindSubject && overlap(px(b.box), faceBox))) {
    const moving = blocks.filter((b) => !b.behindSubject && b.role !== 'signature');
    const top = Math.min(...moving.map((b) => b.box.y1));
    const bottom = Math.max(...moving.map((b) => b.box.y2));
    const gap = 30 / H;
    const below = faceBox.y2 / H + gap - top;
    const above = faceBox.y1 / H - gap - bottom;
    const dy = bottom + below <= 0.94 ? below : top + above >= 0.06 ? above : 0;
    if (dy) {
      const shift = (b: { x1: number; y1: number; x2: number; y2: number }) => ({ ...b, y1: b.y1 + dy, y2: b.y2 + dy });
      // Panels and pills that sit with the text move with it.
      const inBand = (b: { y1: number; y2: number }) => b.y2 > top - 0.02 && b.y1 < bottom + 0.02;
      for (const [i, b] of blocks.entries()) if (moving.includes(b)) blocks[i] = { ...b, box: shift(b.box) };
      for (const [i, e] of decor.entries()) if (inBand(e.box)) decor[i] = { ...e, box: shift(e.box) };
    }
  }
  if (faceBox) {
    for (const [i, b] of blocks.entries()) {
      const r = px(b.box);
      if (b.behindSubject || !overlap(r, faceBox)) continue;
      const left = (r.x1 + r.x2) / 2 < (faceBox.x1 + faceBox.x2) / 2;
      const narrowed = left ? { ...r, x2: faceBox.x1 - 24 } : { ...r, x1: faceBox.x2 + 24 };
      if (narrowed.x2 - narrowed.x1 < 220) return undefined;
      blocks[i] = { ...b, box: { ...b.box, x1: narrowed.x1 / W, x2: narrowed.x2 / W } };
    }
  }

  const dir = path.join(run.dir, 'build');
  await mkdir(dir, { recursive: true });
  // The poster's ground in bands (system.zones, from the reference); one band otherwise.
  const zones = poster && system.zones?.length ? system.zones : [{ y1: 0, y2: 1, color: system.base }];
  const zoneAt = (y: number) => (zones.find((z) => y >= z.y1 * H && y < z.y2 * H) ?? zones[zones.length - 1]).color;
  const light = poster ? luminance(system.base) < 0.4 : layout.textTone === 'light';
  const ink = poster ? readableOn(system.base, system.ink) : light ? mix('#ffffff', system.base, 0.04) : luminance(system.ink) < 0.3 ? system.ink : '#1d1b19';
  const shade = poster ? system.base : light ? mix(system.base, '#000000', 0.6) : mix(system.base, '#ffffff', 0.7);
  const accent = contrast(system.accent, shade) >= 3 ? system.accent : ink;
  // Without a photo the ground is the shade the text was made for.
  const ground = poster ? zones[0].color : light ? (luminance(system.base) < 0.3 ? system.base : mix(system.accent, '#000000', 0.35)) : luminance(system.base) > 0.6 ? system.base : mix(system.base, '#ffffff', 0.8);
  // The highlight under the headline: a light tone of the brand, the headline dark on it.
  const marker = mix(system.accent, '#ffffff', 0.62);
  const markerInk = readableOn(marker, '#1d1b19');
  // On a poster each block reads on the band under it.
  const inkAt = (r: Rect) => (poster ? readableOn(zoneAt((r.y1 + r.y2) / 2), system.ink) : ink);

  // The shade under the text, as light as the text allows.
  const slidePhoto = photo && frame ? await sharp(photo.path).rotate().resize(frame.w, frame.h, { fit: 'fill' }).extract({ left: -frame.x, top: -frame.y, width: W, height: H }).removeAlpha().png().toBuffer() : undefined;
  const reading = blocks.filter((b) => b.role !== 'title').map((b) => px(b.box));
  const area = reading.length ? { x1: Math.min(...reading.map((r) => r.x1)), y1: Math.min(...reading.map((r) => r.y1)), x2: Math.max(...reading.map((r) => r.x2)), y2: Math.max(...reading.map((r) => r.y2)) } : undefined;
  const side = layout.scrim !== 'none' ? layout.scrim : area && (area.x1 + area.x2) / 2 < W * 0.45 ? 'left' : area && (area.x1 + area.x2) / 2 > W * 0.55 ? 'right' : 'bottom';
  const scrimSvg = (alpha: number) => {
    const [x1, y1, x2, y2] = { left: [0, 0, 1, 0], right: [1, 0, 0, 0], top: [0, 0, 0, 1], bottom: [0, 1, 0, 0] }[side];
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${shade}" stop-opacity="${alpha}"/><stop offset="0.38" stop-color="${shade}" stop-opacity="${alpha * 0.8}"/><stop offset="0.7" stop-color="${shade}" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`,
    );
  };
  let alpha = 0;
  if (area && slidePhoto && (highlight || !decor.some((e) => e.type === 'panel'))) {
    for (const a of [layout.scrim === 'none' ? 0 : 0.3, 0.45, 0.6, 0.75, 0.88]) {
      alpha = a;
      const shaded = a ? await sharp(slidePhoto).composite([{ input: scrimSvg(a) }]).png().toBuffer() : slidePhoto;
      const region = await sharp(shaded).extract({ left: area.x1, top: area.y1, width: area.x2 - area.x1, height: area.y2 - area.y1 }).png().toBuffer();
      if (await readable(region, ink)) break;
    }
  }

  const code: string[] = ['_img = Gimp.get_images()[0]', LIB, LAYOUT_LIB];
  code.push("for _old in [_l for _l in _img.get_layers() if _l.get_name() != 'Background']:\n    _img.remove_layer(_old)");
  const order: string[] = [];
  if (photo && frame) {
    const sized = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
    code.push(`_image('Photo', ${py(sized)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, _bgpos())`);
    order.push('Photo');
  } else code.push(`Gimp.context_set_background(_color(${py(ground)}))
_get('Background').edit_fill(Gimp.FillType.BACKGROUND)`);
  let product: Rect | undefined;
  if (poster) {
    for (const [i, z] of zones.slice(1).entries()) {
      const name = `Ground ${i + 2}`;
      code.push(`_shape(${py(name)}, 0, ${Math.round(z.y1 * H)}, ${W}, ${H - Math.round(z.y1 * H)}, ${py(z.color)}, 0, 0)`);
      order.push(name);
    }
    // The giant faded letter (the brand's initial) or word, tone on tone with its band.
    if (layout.ghost) {
      const g = px(layout.ghost.box);
      const word = layout.ghost.kind === 'letter' ? (business.match(/\p{L}/u)?.[0] ?? '') : (ghostWord(slide) ?? '');
      if (word) {
        const under = zoneAt(clamp((g.y1 + g.y2) / 2, 0, H - 1));
        const tone = luminance(under) > 0.8 ? mix(under, '#000000', 0.06) : mix(under, '#ffffff', 0.22);
        const size = Math.round(Math.min((g.y2 - g.y1) / 0.75, layout.ghost.kind === 'letter' ? 2000 : ((g.x2 - g.x1) / Math.max(1, word.length)) * 1.6));
        code.push(`_g = _text('Ghost', ${py(layout.ghost.kind === 'letter' ? word : word.toUpperCase())}, ${py(system.gimpHeading ?? 'Sans-serif Bold')}, ${size}, ${py(tone)}, 99999, -0.1, -0.02, 40)
_g.set_offsets(int(${(g.x1 + g.x2) / 2} - _g.get_width() / 2), int(${(g.y1 + g.y2) / 2} - _g.get_height() / 2))`);
        order.push('Ghost');
      }
    }
    // The product standing on the reference's line, as big as its box allows.
    if (photo) {
      // The product starts under the text above it (two lines of headline, not the reference's one).
      const center = (layout.photo.box.y1 + layout.photo.box.y2) / 2;
      const textFoot = Math.max(0, ...blocks.filter((b) => b.role !== 'title' && b.box.y1 < center).map((b) => b.box.y1 + Math.max(b.box.y2 - b.box.y1, 0.1) + 0.02));
      const box = px({ ...layout.photo.box, y1: Math.min(Math.max(layout.photo.box.y1, textFoot), layout.photo.box.y2 - 0.2) });
      const cut = !!photo.cutout && !photo.matte;
      const { width = 1, height = 1 } = await sharp(photo.path).metadata();
      const c = photo.content ?? { x1: 0, y1: 0, x2: 1, y2: 1 };
      const cw = (c.x2 - c.x1) * width;
      const ch = (c.y2 - c.y1) * height;
      // A tall product that doesn't fit above its line stands lower (down to 94 % of the
      // slide) rather than shrink: the floor under it was empty anyway.
      const stand = Math.round((layout.photo.standOn ?? layout.photo.box.y2) * H);
      const room = cut ? Math.max(box.y2, Math.round(H * 0.94)) - box.y1 : box.y2 - box.y1;
      const scale = Math.min((box.x2 - box.x1) / cw, room / ch, cut ? 1.5 : MAX_UP) * (slide.tweaks?.photoScale ?? 1);
      const fw = Math.round(width * scale);
      const fh = Math.round(height * scale);
      const foot = cut ? Math.max(stand, box.y1 + Math.round(ch * scale)) : Math.round((box.y1 + box.y2) / 2 + (ch * scale) / 2);
      const cx = (box.x1 + box.x2) / 2;
      frame = { w: fw, h: fh, x: Math.round(cx - ((c.x1 + c.x2) / 2) * fw), y: Math.round(foot - c.y2 * fh) };
      product = { x1: Math.round(frame.x + c.x1 * fw), y1: Math.round(frame.y + c.y1 * fh), x2: Math.round(frame.x + c.x2 * fw), y2: foot };
      if (cut && layout.photo.shadow !== false) {
        const sw = Math.round((product.x2 - product.x1) * 0.95);
        const sh = Math.max(28, Math.round(sw * 0.1));
        const file = path.join(dir, `s${slide.n}-shadow.png`);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw + 2 * sh}" height="${sh * 3}"><defs><filter id="b"><feGaussianBlur stdDeviation="${sh * 0.35}"/></filter></defs><ellipse cx="${sw / 2 + sh}" cy="${sh * 1.5}" rx="${sw / 2}" ry="${sh / 2}" fill="#000" fill-opacity="${luminance(zoneAt(foot)) > 0.4 ? 0.28 : 0.45}" filter="url(#b)"/></svg>`;
        await sharp(Buffer.from(svg)).png().toFile(file);
        code.push(`_image('Shadow', ${py(file)}, ${Math.round((product.x1 + product.x2) / 2 - sw / 2 - sh)}, ${Math.round(foot - sh * 1.6)}, ${sw + 2 * sh}, ${sh * 3}, 0)`);
        order.push('Shadow');
      }
      const sized = await crisp(photo.path, frame, path.join(dir, `s${slide.n}-sized.png`));
      code.push(`_image('Photo', ${py(sized)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, 0)`);
      // A photo that isn't a cutout goes whole, as a card with round corners.
      if (!cut) code.push(`_round_mask(_get('Photo'), ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, ${Math.max(12, system.radius)})`);
      order.push('Photo');
    }
  }
  if (alpha > 0) {
    const scrim = path.join(dir, `s${slide.n}-scrim.png`);
    await sharp(scrimSvg(alpha)).png().toFile(scrim);
    code.push(`_image('Scrim', ${py(scrim)}, 0, 0, ${W}, ${H}, 0)`);
    order.push('Scrim');
  }

  // In reading order, top to bottom: a block longer than the reference's pushes what follows
  // down, keeping at least the reference's gap.
  type Item = { y: number; block?: LayoutBlock; element?: (typeof layout.elements)[number]; i: number };
  // A card the text sits on: the photo blurred behind it, in the ground the text was made for.
  const panel = highlight ? undefined : decor.find((e) => e.type === 'panel');
  if (panel && frame && photo && !poster) {
    const r = px(panel.box);
    const file = path.join(dir, `s${slide.n}-panel.png`);
    await frostedPanel(photo.path, frame, r, light ? shade : mix(system.base, '#ffffff', 0.85), ink, Math.round(Math.min(r.x2 - r.x1, r.y2 - r.y1) * 0.08), file);
    code.push(`_image('Panel', ${py(file)}, ${r.x1}, ${r.y1}, ${r.x2 - r.x1}, ${r.y2 - r.y1}, 0)`);
    order.push('Panel');
  }
  // The arrow says "swipe": the call to action's button says what to do instead.
  // On a poster, pills and panels without their words read as empty bars: only lines and circles.
  const elements = decor.filter((e) => e.type !== 'panel' && !(texts.cta && e.type === 'arrow_circle') && !(poster && e.type === 'pill'));
  const marked = highlight && blocks.some((b) => b.role === 'headline');
  const items: Item[] = [...blocks.map((block, i) => ({ y: block.box.y1, block, i })), ...elements.map((element, i) => ({ y: element.box.y1, element, i }))].sort((a, b) => a.y - b.y);
  code.push('_push = 0\n_prev = 0');
  const flow = (top: number, height: string) => `_y = ${top} + _push
if _y < _prev + 16:
    _push += _prev + 16 - _y
    _y = _prev + 16
_prev = _y + ${height}`;
  for (const { block: b, element: e, i } of items) {
    if (b) {
      const r = px(b.box);
      const text = b.case === 'upper' ? texts[b.role]!.toUpperCase() : texts[b.role]!;
      const name = NAME[b.role];
      const just = b.align === 'center' ? 'CENTER' : b.align === 'right' ? 'RIGHT' : 'LEFT';
      const title = b.role === 'title';
      // A title fills its box's height and shrinks to its width; the rest wrap in its width,
      // taller than the reference's when the words are longer.
      // The headline starts from the reference's own size (its box's height), never below the default.
      const size = title ? Math.round((r.y2 - r.y1) / 0.72) : b.role === 'headline' ? clamp(Math.round((r.y2 - r.y1) * 0.75), START.headline, 110) : START[b.role];
      const maxh = title ? H : Math.max((r.y2 - r.y1) * 2.2, b.role === 'headline' || b.role === 'body' ? 240 : 60);
      const emphasis = b.role === 'headline' || b.role === 'body' ? slide.emphasis : undefined;
      const onMarker = marked && b.role === 'headline';
      code.push(
        `_t = _fit(${py(name)}, ${py(text)}, ${py(fontFor(system, b))}, ${size}, ${py(onMarker ? markerInk : inkAt(r))}, ${r.x2 - r.x1}, ${Math.round(maxh)}, ${title ? -0.1 : 0.12}, ${b.tracking}, Gimp.TextJustification.${just}, ${py(emphasis ?? '')}, ${py(b.emphasis)}, ${py(onMarker ? markerInk : accent)}, ${MIN[b.role]}, ${title ? 'False' : 'True'})`,
      );
      if (b.role === 'cta') {
        // The button: the text on an accent pill, the pill in the flow.
        code.push(flow(r.y1, '_t.get_height() + 36'));
        code.push(`_t.set_color(_color(${py(readableOn(accent, '#ffffff'))}))
_place(_t, ${py(b.align)}, ${r.x1 + 32}, ${r.x2 - 32}, _y + 18)
_bx = _t.get_offsets()[-2] - 32
_shape('Button', _bx, int(_y), _t.get_width() + 64, _t.get_height() + 36, ${py(accent)}, int((_t.get_height() + 36) / 2), 0)`);
        order.push('Button');
      } else {
        code.push(flow(r.y1, '_t.get_height()'));
        code.push(`_place(_t, ${py(b.align)}, ${r.x1}, ${r.x2}, _y)`);
        if (marked && b.role === 'headline') {
          code.push(`_o = _t.get_offsets()[-2:]
_shape('Highlight', _o[0] - 22, _o[1] - 10, _t.get_width() + 44, _t.get_height() + 20, ${py(marker)}, 6, 0)`);
          order.push('Highlight');
        }
      }
      order.push(name);
      // On a poster the product (and its shadow) stand in front of a title behind it.
      if (title && b.behindSubject && poster) {
        for (const n of ['Shadow', 'Photo']) if (order.includes(n)) order.push(...order.splice(order.indexOf(n), 1));
      }
      // The subject stands in front of a title behind it.
      if (title && b.behindSubject && input.person && frame && !poster) {
        const person = await crisp(input.person, frame, path.join(dir, `s${slide.n}-person.png`));
        code.push(`_image('Person', ${py(person)}, ${frame.x}, ${frame.y}, ${frame.w}, ${frame.h}, 0)`);
        order.push('Person');
      }
      continue;
    }
    const r = px(e!.box);
    const name = `Element ${i + 1}`;
    if (e!.type === 'line') {
      code.push(flow(r.y1, '3'));
      code.push(`_shape(${py(name)}, ${r.x1}, int(_y), ${Math.max(40, r.x2 - r.x1)}, 3, ${py(ink)}, 0, 0)`);
    } else if (e!.type === 'arrow_circle' || e!.type === 'circle') {
      const d = Math.max(44, Math.min(r.x2 - r.x1, r.y2 - r.y1));
      code.push(flow(r.y1, String(d)));
      code.push(`_ring(${py(name)}, ${r.x1}, int(_y), ${d}, ${py(ink)}, 3)`);
      if (e!.type === 'arrow_circle') {
        code.push(`_a = _text(${py(`${name} arrow`)}, '›', ${py(fontFor(system, { font: 'sans', weight: 'light' } as LayoutBlock))}, ${Math.round(d * 0.7)}, ${py(ink)}, 999)`);
        code.push(`_a.set_offsets(int(${r.x1 + d / 2} - _a.get_width() / 2 + ${Math.round(d * 0.04)}), int(_y + ${d / 2} - _a.get_height() / 2))`);
        order.push(`${name} arrow`);
      }
    } else if (e!.type === 'pill') {
      code.push(flow(r.y1, String(r.y2 - r.y1)));
      code.push(`_shape(${py(name)}, ${r.x1}, int(_y), ${r.x2 - r.x1}, ${r.y2 - r.y1}, ${py(accent)}, ${Math.round((r.y2 - r.y1) / 2)}, 0)`);
    } else {
      code.push(`_fr = _layer(${py(name)})
_img.select_rectangle(Gimp.ChannelOps.REPLACE, ${r.x1}, ${r.y1}, ${r.x2 - r.x1}, ${r.y2 - r.y1})
_img.select_rectangle(Gimp.ChannelOps.SUBTRACT, ${r.x1 + 3}, ${r.y1 + 3}, ${r.x2 - r.x1 - 6}, ${r.y2 - r.y1 - 6})
Gimp.context_set_foreground(_color(${py(ink)}))
_fr.edit_fill(Gimp.FillType.FOREGROUND)
Gimp.Selection.none(_img)`);
    }
    order.push(name);
  }

  // The logo where the reference has its own, as big as that box; else where it signs, else
  // at the foot under the text.
  const logoBox = layout.logo ? px(layout.logo) : undefined;
  const logoGround = logoBox ? zoneAt((logoBox.y1 + logoBox.y2) / 2) : light ? '#1a1a1a' : '#f5f5f5';
  // One color on a poster: the other band's tone when it reads (Kauri's brown wordmark, Delgado's navy).
  const logoInk = logoBox ? (zones.map((z) => z.color).find((c) => c !== logoGround && contrast(c, logoGround) >= 4.5) ?? readableOn(logoGround, system.ink)) : light ? '#ffffff' : '#111111';
  const logo = await slideLogo(run, logoGround, logoInk, logoBox ? (logoBox.x2 - logoBox.x1) / Math.max(1, logoBox.y2 - logoBox.y1) : undefined);
  if (logo && logoBox) {
    const s = Math.min((logoBox.x2 - logoBox.x1) / logo.asset.width, (logoBox.y2 - logoBox.y1) / logo.asset.height);
    const w = Math.round(logo.asset.width * s);
    const h = Math.round(logo.asset.height * s);
    const mid = (logoBox.x1 + logoBox.x2) / 2;
    const x = Math.abs(mid - W / 2) < W * 0.1 ? Math.round(W / 2 - w / 2) : mid < W / 2 ? logoBox.x1 : logoBox.x2 - w;
    code.push(`_image('Logo', ${py(logo.asset.path)}, ${x}, ${Math.round((logoBox.y1 + logoBox.y2) / 2 - h / 2)}, ${w}, ${h}, 0)`);
    order.push('Logo');
  } else if (logo) {
    const sig = layout.blocks.find((b) => b.role === 'signature');
    const head = layout.blocks.find((b) => b.role === 'headline') ?? layout.blocks[0];
    // On a card without a signature line, the logo signs the card: big, in its lower third.
    const card = !sig && panel && frame ? px(panel.box) : undefined;
    const at = sig ? px(sig.box) : card ? { x1: card.x1, y1: Math.round(card.y2 - (card.y2 - card.y1) * 0.36), x2: card.x2, y2: card.y2 - 40 } : { x1: px(head.box).x1, y1: H - 140, x2: px(head.box).x2, y2: H - 70 };
    const boxH = card ? Math.round((at.y2 - at.y1) * 0.8) : clamp(Math.round((at.y2 - at.y1) * 1.8), 44, 72);
    const s = Math.min((card ? (card.x2 - card.x1) * 0.45 : 240) / logo.asset.width, boxH / logo.asset.height);
    const w = Math.round(logo.asset.width * s);
    const h = Math.round(logo.asset.height * s);
    const align = card ? 'center' : (sig ?? head).align;
    const x = align === 'left' ? at.x1 : align === 'right' ? at.x2 - w : Math.round((at.x1 + at.x2) / 2 - w / 2);
    const y = Math.min(H - 44 - h, at.y1);
    code.push(`_image('Logo', ${py(logo.asset.path)}, ${x}, ${y}, ${w}, ${h}, 0)`);
    order.push('Logo');
  }

  // The logo never sits on the text: below the text, else at the top, else at the foot.
  if (logo) {
    const texts = [...blocks.map((b) => NAME[b.role]), 'Button', 'Highlight'];
    code.push(`_lg = _get('Logo')
def _hits():
    _x, _y = _lg.get_offsets()[-2:]
    for _n in ${py(texts)}:
        _o = _get(_n)
        if not _o:
            continue
        _a, _b = _o.get_offsets()[-2:]
        if _x < _a + _o.get_width() + 12 and _a < _x + _lg.get_width() + 12 and _y < _b + _o.get_height() + 12 and _b < _y + _lg.get_height() + 12:
            return True
    return False
if _lg and _hits():
    _lx = _lg.get_offsets()[-2]
    for _ly in [_prev + 32, 56, ${H} - 48 - _lg.get_height()]:
        if _ly < 40 or _ly + _lg.get_height() > ${H} - 40:
            continue
        _lg.set_offsets(int(_lx), int(_ly))
        if not _hits():
            break`);
  }

  // Bottom to top: the photo, its shade, the title, the subject in front of it, the rest.
  code.push(`_order = ${py([...order].reverse())}
for _i, _n in enumerate(_order):
    _l = _get(_n)
    if _l:
        _img.reorder_item(_l, None, _i)
Gimp.displays_flush()
_result = {_l.get_name(): list(_l.get_offsets()[-2:]) + [_l.get_width(), _l.get_height()] for _l in _img.get_layers()}`);
  const placed = (await gimp.python(code.join('\n'))) as Record<string, [number, number, number, number]>;

  const textNames = blocks.filter((b) => !b.behindSubject).map((b) => NAME[b.role]);
  const boxes = textNames.map((n) => placed[n]).filter(Boolean).map(([x, y, w, h]) => ({ x1: x, y1: y, x2: x + w, y2: y + h }));
  const text: Rect = boxes.length
    ? { x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) }
    : { x1: 0, y1: 0, x2: 0, y2: 0 };
  return {
    layout: slide.layout ?? 'photo_band',
    ground: poster ? zoneAt((text.y1 + text.y2) / 2) : shade,
    ink,
    photoFrame: frame,
    textBand: 'middle',
    split: false,
    shape: 'reference',
    subject: poster ? product : faceBox,
    visible: { x1: 0, y1: 0, x2: W, y2: H },
    text,
    textScale: 1,
    photoCropped: false,
    align: blocks.find((b) => b.role === 'headline')?.align === 'center' ? 'center' : 'left',
    free: true,
  };
}
