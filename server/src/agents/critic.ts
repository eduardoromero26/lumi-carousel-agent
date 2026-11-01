import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { chatJson, imagePart, type ContentPart } from '../llm.js';
import type { Plan, Run, SlidePlan } from '../run.js';
import { protectedText } from '../sam.js';
import { parseFixRequests, type FixRequest } from '../fixes.js';
import { judgedVotes } from '../db.js';
import { describeLessons } from '../taste.js';
import { CRITIC, CRITIC_SET, MOTION_CRITIC } from './prompts.js';

// The owner's words on work they disliked: what a strict art director missed before.
function ownerLessons(): string {
  const lessons = describeLessons(judgedVotes());
  return lessons
    ? `The business owner disliked past work, often work you had approved. Their own words (maybe in Spanish); look for the same problems here and answer "no" when you see them:\n${lessons}`
    : '';
}

export const CHECKS = ['brand', 'content', 'image', 'nothing_weird', 'original_photo', 'same_faces', 'padding', 'whole_subject', 'system', 'aesthetic'] as const;

type Answer = { answer: 'yes' | 'no' | 'n/a'; note?: string };

export type Review = {
  approved: boolean;
  score: number;
  checks: Record<(typeof CHECKS)[number], Answer>;
  issues: string[];
  // What the fixer can do about it, in the contract's actions...
  fixes: FixRequest[];
  // ...and what it can't: problems only the template's author can fix.
  templateIssues: string[];
};

// The slide is approved only when every check is "yes" or "n/a"; the model
// answers the checklist, the code decides.
export async function reviewSlide(
  run: Run,
  plan: Plan,
  slide: SlidePlan,
  snapshot: string,
  approvedSnapshots: string[],
  ownerFeedback: string[] = [],
  coveredFaces: { box: { x1: number; y1: number; x2: number; y2: number }; diff: number }[] = [],
  system = '',
): Promise<Review> {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        `Carousel concept: ${plan.concept}`,
        `Slide ${slide.n} of ${plan.slides.length} (${slide.role}).`,
        `Layout: ${slide.layout ?? 'free'}.`,
        slide.eyebrow ? `Planned label above the headline: ${slide.eyebrow}` : '',
        `Planned headline: ${slide.headline}`,
        `Planned body: ${slide.body || '(none)'}`,
        slide.button ? `Planned button: ${slide.button}` : '',
        slide.layout === 'cover' ? 'The cover also carries a small "swipe" cue: it is part of the system.' : '',
        `Director's notes: ${slide.visual}`,
        protectedText(slide) ? `Found by a vision model on the 1080x1350 slide (your preview is smaller, scale accordingly). ${protectedText(slide)}` : '',
        run.brief.brandColors?.length ? `Brand colors: ${run.brief.brandColors.join(', ')}` : 'No brand colors given.',
        system ? `The carousel's visual system (for "system"): ${system}` : '',
        ownerFeedback.length
          ? `The business owner asked for these changes, and they override the plan: ${ownerFeedback.join('; ')}. Check that every one was applied.`
          : '',
        ownerLessons(),
        'The slide to review:',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    imagePart(snapshot),
  ];
  const photo = slide.photo ? run.photos.find((p) => p.id === slide.photo) : undefined;
  if (photo?.backdrop) {
    parts.push({
      type: 'text',
      text: 'The background is a website image with text baked in, softened and shaded on purpose ("original_photo" and "same_faces" are n/a). For "image": it must read as a background, with its own text never competing with the slide text. The image:',
    });
    parts.push(imagePart(await thumbnail(photo.path), 'image/jpeg'));
  } else if (photo) {
    parts.push({ type: 'text', text: 'The original business photo used on this slide (for "original_photo" and "same_faces"):' });
    parts.push(imagePart(await thumbnail(photo.path), 'image/jpeg'));
  } else {
    parts.push({
      type: 'text',
      text: 'This slide has no photo by plan: it is type on the brand ground. "image", "original_photo" and "whole_subject" are n/a; never ask for a photo. Judge the type, the ground and the hierarchy under "aesthetic".',
    });
  }
  for (const logo of [run.logo, run.logoLight]) {
    if (!logo) continue;
    parts.push({ type: 'text', text: `The business logo${logo === run.logoLight ? ' (light version, for dark backgrounds)' : ''} (for "brand"):` });
    parts.push(imagePart(await thumbnail(logo.path), 'image/jpeg'));
  }
  if (approvedSnapshots.length) {
    parts.push({ type: 'text', text: 'Previously approved slides of this carousel, for consistency:' });
    for (const s of approvedSnapshots.slice(-2)) parts.push(imagePart(s));
  }

  const raw = await chatJson<{ checks?: Partial<Review['checks']>; score?: number; fixes?: unknown }>([
    { role: 'system', content: CRITIC },
    { role: 'user', content: parts },
  ]);
  const checks = {} as Review['checks'];
  for (const key of CHECKS) {
    const answer = raw.checks?.[key];
    // A missing answer counts as a "no": the critic has to look at everything.
    checks[key] = answer && ['yes', 'no', 'n/a'].includes(answer.answer) ? answer : { answer: 'no', note: 'not checked' };
  }
  // The designer can't add a photo the plan didn't give: those checks can't fail.
  if (!photo) for (const key of ['image', 'original_photo', 'whole_subject'] as const) checks[key] = { answer: 'n/a' };
  const { fixes, templateIssues } = parseFixRequests(raw.fixes);
  // Pixel comparison against the original photo overrides the model.
  if (coveredFaces.length) {
    const where = coveredFaces.map((f) => `x ${f.box.x1}-${f.box.x2}, y ${f.box.y1}-${f.box.y2}`).join('; ');
    checks.same_faces = { answer: 'no', note: `measured: something covers or changes the face at ${where}` };
    if (!fixes.some((f) => f.action === 'text_above_photo')) fixes.unshift({ action: 'text_above_photo', why: `measured: something covers or changes the face at ${where}; the text off the photo uncovers it` });
  }
  const failed = CHECKS.filter((k) => checks[k].answer === 'no');
  return {
    approved: failed.length === 0,
    score: raw.score ?? 0,
    checks,
    issues: failed.map((k) => `${k}: ${checks[k].note ?? 'no'}`),
    fixes,
    templateIssues,
  };
}

export type SetReview = { consistent: boolean; score: number; slides: { n: number; fixes: FixRequest[]; templateIssues: string[] }[] };

// The whole carousel on one contact sheet: the check a slide-by-slide review can't
// make (is it one family?).
export async function reviewSet(plan: Plan, slidePngs: { n: number; file: string }[], system: string): Promise<SetReview & { sheet: Buffer }> {
  const cell = { width: 360, height: 450 };
  const tiles = await Promise.all(slidePngs.map(async (s) => sharp(await readFile(s.file)).resize(cell.width, cell.height).png().toBuffer()));
  const sheet = await sharp({ create: { width: cell.width * tiles.length + 16 * (tiles.length + 1), height: cell.height + 32, channels: 3, background: '#e9e9ec' } })
    .composite(tiles.map((input, i) => ({ input, left: 16 + i * (cell.width + 16), top: 16 })))
    .jpeg({ quality: 85 })
    .toBuffer();
  const raw = await chatJson<{ consistent?: boolean; score?: number; slides?: { n?: unknown; fixes?: unknown; fix?: unknown }[] }>([
    { role: 'system', content: CRITIC_SET },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            `Carousel: ${plan.concept}`,
            `Slides in order: ${plan.slides.map((s) => `${s.n} ${s.layout ?? s.role} "${s.headline}"`).join('; ')}.`,
            `The visual system they must share: ${system}`,
            ownerLessons(),
            'The contact sheet, left to right:',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        imagePart(sheet.toString('base64'), 'image/jpeg'),
      ],
    },
  ]);
  const known = new Set(plan.slides.map((s) => s.n));
  const slides: SetReview['slides'] = [];
  for (const s of raw.slides ?? []) {
    const n = Number(s.n);
    if (!known.has(n) || slides.some((k) => k.n === n)) continue;
    // A free-text "fix" from an old-style answer is a template issue, never a fix.
    const parsed = parseFixRequests(Array.isArray(s.fixes) ? s.fixes : typeof s.fix === 'string' ? [s.fix] : []);
    if (parsed.fixes.length || parsed.templateIssues.length) slides.push({ n, ...parsed });
  }
  return { consistent: raw.consistent !== false, score: raw.score ?? 0, slides, sheet };
}

async function thumbnail(file: string): Promise<string> {
  const buffer = await sharp(await readFile(file)).rotate().flatten({ background: '#9a9a9a' }).resize(768, 768, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  return buffer.toString('base64');
}

export const MOTION_CHECKS = ['rest_matches_slide', 'loop_seamless', 'nothing_weird', 'readable', 'pacing', 'brand'] as const;

export type MotionReview = {
  approved: boolean;
  score: number;
  checks: Record<(typeof MOTION_CHECKS)[number], Answer>;
  issues: string[];
  fixes: string[];
};

// Measured limits: above them the check fails whatever the model says.
const MAX_LOOP_DIFF = 0.02;
const MAX_REST_DIFF = 0.06;

export async function reviewMotion(
  slide: SlidePlan,
  slidePng: string,
  frames: { t: number; file: string }[],
  measured: { restVsSlide: number; loop: number },
  notes: string,
): Promise<MotionReview> {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        `Card ${slide.n}: "${slide.headline}". Motion idea: ${notes || '(none)'}`,
        `Measured by code: rest frame vs approved card difference ${measured.restVsSlide.toFixed(3)} (0 = identical; a slow camera push-in alone gives about 0.02-0.04), first vs last frame ${measured.loop.toFixed(3)}.`,
        'The approved static card:',
      ].join('\n'),
    },
    imagePart(await thumbnail(slidePng), 'image/jpeg'),
  ];
  for (const f of frames) {
    parts.push({ type: 'text', text: `Frame at ${f.t.toFixed(2)} s:` });
    parts.push(imagePart(await thumbnail(f.file), 'image/jpeg'));
  }
  const raw = await chatJson<{ checks?: Partial<MotionReview['checks']>; score?: number; fixes?: string[] }>([
    { role: 'system', content: MOTION_CRITIC },
    { role: 'user', content: parts },
  ]);
  const checks = {} as MotionReview['checks'];
  for (const key of MOTION_CHECKS) {
    const answer = raw.checks?.[key];
    checks[key] = answer && ['yes', 'no', 'n/a'].includes(answer.answer) ? answer : { answer: 'no', note: 'not checked' };
  }
  if (measured.loop > MAX_LOOP_DIFF) checks.loop_seamless = { answer: 'no', note: `measured ${measured.loop.toFixed(3)} > ${MAX_LOOP_DIFF}` };
  if (measured.restVsSlide > MAX_REST_DIFF) checks.rest_matches_slide = { answer: 'no', note: `measured ${measured.restVsSlide.toFixed(3)} > ${MAX_REST_DIFF}` };
  const failed = MOTION_CHECKS.filter((k) => checks[k].answer === 'no');
  return {
    approved: failed.length === 0,
    score: raw.score ?? 0,
    checks,
    issues: failed.map((k) => `${k}: ${checks[k].note ?? 'no'}`),
    fixes: raw.fixes ?? [],
  };
}
