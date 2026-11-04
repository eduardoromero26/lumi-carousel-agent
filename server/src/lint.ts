import { SLIDE } from './config.js';
import type { Gimp } from './gimp.js';
import type { SlidePlan } from './run.js';
import type { Built, Rect } from './templates.js';

const W = SLIDE.width;
const H = SLIDE.height;

type Layer = { name: string; x: number; y: number; w: number; h: number; visible: boolean };

// Geometry the critic can't be trusted with, measured on the layers in GIMP:
// overlaps, margins, centering, the product whole and centered in its card, and
// text off the subject and the faces. Any problem rejects the slide whatever the
// critic says. Shapes are full-slide layers, so their boxes come from their text.
export async function lintSlide(gimp: Gimp, built: Built, slide: SlidePlan): Promise<string[]> {
  const raw = (await gimp.python(
    [
      '_img = Gimp.get_images()[0]',
      '_result = []',
      'for _l in _img.get_layers():',
      '    _o = _l.get_offsets()',
      '    _result.append([_l.get_name(), _o[-2], _o[-1], _l.get_width(), _l.get_height(), _l.get_visible()])',
    ].join('\n'),
  )) as [string, number, number, number, number, boolean][];
  const layers = new Map<string, Layer>(raw.map(([name, x, y, w, h, visible]) => [name, { name, x, y, w, h, visible }]));
  const box = (name: string, padX = 0, padY = 0): Rect | undefined => {
    const l = layers.get(name);
    return l?.visible ? { x1: l.x - padX, y1: l.y - padY, x2: l.x + l.w + padX, y2: l.y + l.h + padY } : undefined;
  };
  const headline = box('Headline');
  const groups: [string, Rect | undefined][] = [
    ['the label', layers.has('Label') ? box('Eyebrow', 28, 15) : box('Eyebrow')],
    ['the headline', headline],
    ['the underline', layers.has('Underline') && headline ? { x1: built.align === 'left' ? 80 : W / 2 - 60, y1: headline.y2 + 22, x2: built.align === 'left' ? 200 : W / 2 + 60, y2: headline.y2 + 32 } : undefined],
    ['the body', box('Body')],
    ['the swipe cue', box('Swipe')],
    ['the button', box('Button text', 60, 32)],
    ['the logo', layers.has('Logo plate') ? box('Logo', 22, 14) : box('Logo')],
  ];
  const present = groups.filter((g): g is [string, Rect] => !!g[1]);
  const issues: string[] = [];

  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      if (area(inter(shrink(present[i][1], 3), shrink(present[j][1], 3)))) issues.push(`${present[i][0]} overlaps ${present[j][0]}`);
    }
  }
  for (const [name, r] of present) {
    // The guides: 80 px margins on the sides (a few px of type bearing allowed), less above and below.
    if (r.x1 < 76 || r.x2 > W - 76 || r.y1 < 44 || r.y2 > H - 44) issues.push(`${name} is too close to the slide's edge, outside the margin guides (${r.x1},${r.y1} to ${r.x2},${r.y2})`);
    // Centered text sits on the center guide, a reference's too (it keeps only its own margins).
    if (name !== 'the logo' && built.align === 'center' && Math.abs((r.x1 + r.x2) / 2 - W / 2) > (built.free ? 10 : 6)) issues.push(`${name} is off-center`);
    if (!built.free && name !== 'the logo' && name !== 'the underline' && built.align === 'left' && Math.abs(r.x1 - 80) > 8) issues.push(`${name} is not on the left margin`);
    if (built.card && area(inter(shrink(r, 3), built.card))) issues.push(`${name} overlaps the photo card`);
  }

  // The product, whole and centered in its card.
  if (built.photoCropped) issues.push("the product is cut by its own photo's edge: use another photo of a product shown whole");
  if (built.card && built.product) {
    const p = built.product;
    const c = built.card;
    const m = Math.min(p.x1 - c.x1, c.x2 - p.x2, p.y1 - c.y1, c.y2 - p.y2);
    if (m < 12) issues.push('the product touches or crosses the edge of its card: make it smaller');
    if (Math.abs((p.x1 + p.x2) / 2 - (c.x1 + c.x2) / 2) > (c.x2 - c.x1) * 0.04) issues.push('the product is not centered in its card');
  }

  // What must stay whole: inside the part of the slide where the photo shows,
  // unless the photo itself ends there.
  if (built.subject && built.visible && built.photoFrame) {
    const s = built.subject;
    const v = built.visible;
    const f = built.photoFrame;
    const cut =
      (s.x1 < v.x1 - 2 && v.x1 > f.x + 2) ||
      (s.y1 < v.y1 - 2 && v.y1 > f.y + 2) ||
      (s.x2 > v.x2 + 2 && v.x2 < f.x + f.w - 2) ||
      (s.y2 > v.y2 + 2 && v.y2 < f.y + f.h - 2);
    if (cut) issues.push(`the ${slide.subject ?? 'subject'} is cut by the edge of the photo area: show it whole`);
    // Measured on the text band, as the template does when it chooses where the text goes.
    // A reference layout's text sits in its own column: only that column counts.
    const band = built.free ? built.text : { x1: 80, y1: built.text.y1, x2: W - 80, y2: built.text.y2 };
    if (area(inter(band, s)) / Math.max(1, area(band)) > 0.1) issues.push(`the text covers the ${slide.subject ?? 'subject'}`);
    const logo = present.find(([name]) => name === 'the logo');
    if (logo && area(inter(logo[1], s)) > 0) issues.push(`the logo covers the ${slide.subject ?? 'subject'}`);
  }
  for (const face of slide.faces ?? []) {
    for (const [name, r] of present) if (area(inter(r, face))) issues.push(`${name} covers a face`);
  }
  return [...new Set(issues)];
}

function inter(a: Rect, b: Rect): Rect {
  return { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) };
}

function area(r: Rect): number {
  return Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);
}

function shrink(r: Rect, by: number): Rect {
  return { x1: r.x1 + by, y1: r.y1 + by, x2: r.x2 - by, y2: r.y2 - by };
}
