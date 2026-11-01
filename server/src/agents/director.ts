import sharp from 'sharp';
import { chatJson, imagePart, type ContentPart } from '../llm.js';
import { hashtagList, type Plan, type Run, type SlidePlan } from '../run.js';
import { describeDirections } from '../db.js';
import { DIRECTOR } from './prompts.js';

export async function planCarousel(run: Run): Promise<Plan> {
  const { brief } = run;
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        brief.business ? `Business: ${brief.business}` : '',
        brief.url ? `Website: ${brief.url}` : '',
        brief.goal ? `Goal of this post: ${brief.goal}` : 'No goal given: choose the topic from the website.',
        `Language for all slide text, caption and hashtags: ${brief.language ?? 'the language of the brief'}`,
        brief.audience ? `Audience: ${brief.audience}` : '',
        brief.brandColors?.length ? `Brand colors: ${brief.brandColors.join(', ')}` : '',
        run.site ? `Website content (facts you may use):
${run.site.text}` : '',
        describeDirections(),
        run.logo ? `The business logo is available: the designer can place it (say on which slide in "visual").` : 'There is no logo file.',
        `Real photos (${run.photos.length}):`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  for (const photo of run.photos) {
    parts.push({ type: 'text', text: `Photo ${photo.id}${photo.backdrop ? ' (backdrop)' : photo.cutout ? ' (cutout)' : photo.cropped ? ' (cut by its edge)' : ''}${photo.note ? ` — ${photo.note}` : ''}:` });
    parts.push(imagePart(await preview(photo.path), 'image/jpeg'));
  }

  run.emit('status', 'director', `Looking at ${run.photos.length} photos and the goal…`);
  const plan = await chatJson<Plan>([
    { role: 'system', content: DIRECTOR },
    { role: 'user', content: parts },
  ]);
  plan.slides = plan.slides.map((s, i) => ({ ...s, n: i + 1 }));
  plan.hashtags = hashtagList(plan.hashtags);
  usePhotos(run, plan);
  fixLayouts(run, plan);
  return plan;
}

// Every slide gets a template that can be built: the cover first, the call to action
// last, a photo layout only with a photo, never two posters in a row when there are photos.
function fixLayouts(run: Run, plan: Plan): void {
  const valid = new Set(['cover', 'product', 'hero', 'photo_band', 'poster', 'cta']);
  plan.slides.forEach((s, i) => {
    const photo = s.photo ? run.photos.find((p) => p.id === s.photo) : undefined;
    const product = photo?.cutout || s.cut_out;
    if (!s.layout || !valid.has(s.layout)) s.layout = photo ? (product ? 'product' : 'photo_band') : 'poster';
    if ((s.layout === 'product' || s.layout === 'hero' || s.layout === 'photo_band') && !photo) s.layout = 'poster';
    if (s.layout === 'hero' && !photo?.cutout) s.layout = 'product';
    if (s.layout === 'poster' && i > 0 && plan.slides[i - 1].layout === 'poster' && photo) s.layout = product ? 'product' : 'photo_band';
    if (i === 0) s.layout = 'cover';
    else if (i === plan.slides.length - 1) s.layout = 'cta';
    else if (s.layout === 'cover' || s.layout === 'cta') s.layout = photo ? (product ? 'product' : 'photo_band') : 'poster';
    if (s.eyebrow && s.eyebrow.split(/\s+/).length > 4) s.eyebrow = undefined;
  });
  // A product cut by its own photo's edge can't be a hero: an unused whole photo takes its place.
  const used = new Set(plan.slides.map((s) => s.photo).filter(Boolean));
  for (const s of plan.slides) {
    const photo = s.photo ? run.photos.find((p) => p.id === s.photo) : undefined;
    if (!photo?.cropped || s.layout === 'photo_band' || s.layout === 'poster') continue;
    const free = run.photos.filter((p) => !used.has(p.id) && !p.cropped && !p.backdrop);
    const swap = free.find((p) => p.cutout === photo.cutout || (s.layout === 'product' && p.cutout)) ?? free[0];
    if (!swap) continue;
    used.delete(photo.id);
    used.add(swap.id);
    s.photo = swap.id;
  }
  // One skeleton for the middle slides, decided by what most of their photos are: a studio
  // product among real photos goes in the same photo frame (text above, photo below), and
  // a real photo among products on the same card. A slide with its own skeleton breaks the set.
  const photoOf = (s: SlidePlan) => (s.photo ? run.photos.find((p) => p.id === s.photo) : undefined);
  const shown = plan.slides.slice(1, -1).filter((s) => photoOf(s) && !photoOf(s)!.backdrop);
  const products = shown.filter((s) => photoOf(s)!.cutout || s.cut_out);
  const card = products.length * 2 > shown.length;
  for (const s of shown) {
    if (card) s.layout = s.layout === 'hero' ? 'hero' : 'product';
    else {
      s.layout = 'photo_band';
      s.cut_out = false;
    }
  }
  // Rhythm, only in a catalog of products (same card, text under it): every second
  // product in a row becomes a hero when its product can float.
  let run3 = 0;
  for (const s of plan.slides) {
    run3 = s.layout === 'product' ? run3 + 1 : 0;
    if (card && products.length === shown.length && run3 >= 2 && run3 % 2 === 0 && photoOf(s)?.cutout) s.layout = 'hero';
  }
  if (card && products.length < shown.length) for (const s of shown) if (s.layout === 'hero') s.layout = 'product';
  // The label above the headline is part of the system: on every slide or on none.
  if (plan.slides.some((s) => !s.eyebrow?.trim())) for (const s of plan.slides) s.eyebrow = undefined;
}

// The website's photos are the point of reading it: slides the director left
// without one get the unused ones, the hook first and the call to action last.
function usePhotos(run: Run, plan: Plan): void {
  const known = new Set(run.photos.map((p) => p.id));
  for (const s of plan.slides) if (s.photo && !known.has(s.photo)) s.photo = null;
  const used = new Set(plan.slides.map((s) => s.photo).filter(Boolean));
  const unused = [...run.photos.filter((p) => !p.backdrop), ...run.photos.filter((p) => p.backdrop)].filter((p) => !used.has(p.id));
  const empty = plan.slides.filter((s) => !s.photo);
  // One text-only call to action is allowed when photos run short.
  const last = plan.slides[plan.slides.length - 1];
  if (empty.length > unused.length && empty.includes(last)) empty.splice(empty.indexOf(last), 1);
  for (const slide of empty) {
    const photo = unused.shift() ?? run.photos[(slide.n - 1) % run.photos.length];
    if (!photo) break;
    slide.photo = photo.id;
    slide.focus ??= { x: 0.5, y: 0.5 };
  }
}

async function preview(file: string): Promise<string> {
  const buffer = await sharp(file).rotate().flatten({ background: '#9a9a9a' }).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
  return buffer.toString('base64');
}
