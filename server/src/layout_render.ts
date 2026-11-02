import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { SLIDE } from './config.js';
import { contrast, luminance, readableOn, type DesignSystem } from './design.js';
import type { Gimp } from './gimp.js';
import { mirrorLayout, type BlockRole, type Box, type LayoutBlock, type RefLayout } from './layout.js';
import { LIB, MAX_UP, crisp, keepBox, mix, onSlide, pickLogo, readable, type Built, type Fit, type Rect, type SlideInput } from './templates.js';

// A slide built from the owner's reference plan (layout.ts) instead of a template: the
// photo full-bleed with its subject where the reference has it, every text block in the
// reference's box with its type treatment, the reference's lines and arrows, and a giant
// title the subject stands in front of (the subject cut out by SAM, in place). Undefined
// when this photo can't take the plan (too small to fill the slide, a face under the text):
// the slide then goes to its template.
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

export async function buildFromLayout(gimp: Gimp, input: SlideInput, plan: RefLayout): Promise<Built | undefined> {
  const { run, system, slide, photo } = input;
  // A slide without a photo (a call to action, a poster) takes the plan on a plain ground,
  // so the set keeps the reference's type; a product shot or a banner keeps its template.
  if (plan.photo.mode !== 'full' || (photo && (photo.cutout || photo.backdrop))) return undefined;
  // The subject on the other side of the photo than the reference's: the plan in a mirror.
  const subject = keepBox(input.avoid);
  const layout = subject && ((subject.x1 + subject.x2) / 2 - 0.5) * (plan.photo.subjectAt - 0.5) < -0.01 ? mirrorLayout(plan) : plan;

  // The photo covers the slide with its subject where the reference has its own.
  let frame: Fit | undefined;
  if (photo) {
    const { width = 1, height = 1 } = await sharp(photo.path).metadata();
    const scale = Math.max(W / width, H / height);
    if (scale > MAX_UP) return undefined;
    const fw = Math.round(width * scale);
    const fh = Math.round(height * scale);
    const focus = subject ? { x: (subject.x1 + subject.x2) / 2, y: (subject.y1 + subject.y2) / 2 } : (input.focus ?? { x: 0.5, y: 0.5 });
    frame = { w: fw, h: fh, x: clamp(Math.round(layout.photo.subjectAt * W - focus.x * fw), W - fw, 0), y: clamp(Math.round(H * 0.5 - focus.y * fh), H - fh, 0) };
  }
  const faces = keepBox(input.faces);

  const business = (run.site?.title ?? run.brief.business ?? '').split(/[|\-–·]/)[0].trim().slice(0, 40);
  const texts = blockTexts(slide, layout, business);
  const blocks = layout.blocks.filter((b) => texts[b.role]?.trim() && !(b.role === 'signature' && run.logo));
  // A call to action the reference has no box for: a button under the lowest text block.
  if (texts.cta && !blocks.some((b) => b.role === 'cta')) {
    const last = blocks.filter((b) => b.role !== 'signature').sort((a, b) => b.box.y2 - a.box.y2)[0];
    if (last) blocks.push({ role: 'cta', box: { x1: last.box.x1, y1: Math.min(0.86, last.box.y2 + 0.04), x2: Math.min(1, last.box.x1 + 0.5), y2: Math.min(0.9, last.box.y2 + 0.08) }, align: last.align, case: 'as_is', weight: 'bold', font: 'sans', tracking: 0.02, behindSubject: false, emphasis: 'none' });
  }
  const faceBox = faces && frame ? onSlide(faces, frame) : undefined;
  // A text column that reaches a face narrows to end before it; too narrow to read, the
  // reference doesn't fit this photo.
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
  const light = layout.textTone === 'light';
  const ink = light ? mix('#ffffff', system.base, 0.04) : luminance(system.ink) < 0.3 ? system.ink : '#1d1b19';
  const shade = light ? mix(system.base, '#000000', 0.6) : mix(system.base, '#ffffff', 0.7);
  const accent = contrast(system.accent, shade) >= 3 ? system.accent : ink;
  // Without a photo the ground is the shade the text was made for.
  const ground = light ? shade : luminance(system.base) > 0.6 ? system.base : mix(system.base, '#ffffff', 0.8);

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
  if (area && slidePhoto) {
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
  if (alpha > 0) {
    const scrim = path.join(dir, `s${slide.n}-scrim.png`);
    await sharp(scrimSvg(alpha)).png().toFile(scrim);
    code.push(`_image('Scrim', ${py(scrim)}, 0, 0, ${W}, ${H}, 0)`);
    order.push('Scrim');
  }

  // In reading order, top to bottom: a block longer than the reference's pushes what follows
  // down, keeping at least the reference's gap.
  type Item = { y: number; block?: LayoutBlock; element?: (typeof layout.elements)[number]; i: number };
  // The arrow says "swipe": the call to action's button says what to do instead.
  const elements = layout.elements.filter((e) => !(texts.cta && e.type === 'arrow_circle'));
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
      const size = title ? Math.round((r.y2 - r.y1) / 0.72) : START[b.role];
      const maxh = title ? H : Math.max((r.y2 - r.y1) * 2.2, b.role === 'headline' || b.role === 'body' ? 240 : 60);
      const emphasis = b.role === 'headline' || b.role === 'body' ? slide.emphasis : undefined;
      code.push(
        `_t = _fit(${py(name)}, ${py(text)}, ${py(fontFor(system, b))}, ${size}, ${py(ink)}, ${r.x2 - r.x1}, ${Math.round(maxh)}, ${title ? -0.1 : 0.12}, ${b.tracking}, Gimp.TextJustification.${just}, ${py(emphasis ?? '')}, ${py(b.emphasis)}, ${py(accent)}, ${MIN[b.role]}, ${title ? 'False' : 'True'})`,
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
      }
      order.push(name);
      // The subject stands in front of a title behind it.
      if (title && b.behindSubject && input.person && frame) {
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

  // The logo where the reference signs, else at the foot under the text.
  const logo = pickLogo(run, light ? '#1a1a1a' : '#f5f5f5');
  if (logo) {
    const sig = layout.blocks.find((b) => b.role === 'signature');
    const head = layout.blocks.find((b) => b.role === 'headline') ?? layout.blocks[0];
    const at = sig ? px(sig.box) : { x1: px(head.box).x1, y1: H - 140, x2: px(head.box).x2, y2: H - 70 };
    const boxH = clamp(Math.round((at.y2 - at.y1) * 1.8), 44, 72);
    const s = Math.min(240 / logo.asset.width, boxH / logo.asset.height);
    const w = Math.round(logo.asset.width * s);
    const h = Math.round(logo.asset.height * s);
    const align = (sig ?? head).align;
    const x = align === 'left' ? at.x1 : align === 'right' ? at.x2 - w : Math.round((at.x1 + at.x2) / 2 - w / 2);
    const y = Math.min(H - 44 - h, at.y1);
    if (logo.pill) code.push(`_shape('Logo plate', ${x - 18}, ${y - 12}, ${w + 36}, ${h + 24}, ${py(logo.pill)}, ${Math.round((h + 24) / 2)}, 0)`);
    code.push(`_image('Logo', ${py(logo.asset.path)}, ${x}, ${y}, ${w}, ${h}, 0)`);
    if (logo.pill) order.push('Logo plate');
    order.push('Logo');
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
    ground: shade,
    ink,
    photoFrame: frame,
    textBand: 'middle',
    split: false,
    shape: 'reference',
    subject: faceBox,
    visible: { x1: 0, y1: 0, x2: W, y2: H },
    text,
    textScale: 1,
    photoCropped: false,
    align: blocks.find((b) => b.role === 'headline')?.align === 'center' ? 'center' : 'left',
    free: true,
  };
}
