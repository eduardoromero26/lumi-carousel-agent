import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { chatJson, imagePart, type ContentPart, type Message } from '../llm.js';
import { SHOT_ACTIONS, type ReelSpec, type ShotAction, type Timed } from '../reel.js';
import type { Plan, Run } from '../run.js';
import { REEL_CRITIC, REEL_DIRECTOR, REEL_SHOT_CRITIC } from './prompts.js';
import { musicGenres } from '../music.js';
import { hookOrder } from '../variety.js';
import { taste } from '../db.js';
import { describeTaste } from '../taste.js';

// The reel director: one conversation, so rule problems and the critic's fixes
// build on the previous shot list.
export class ReelDirector {
  private messages: Message[] = [];

  constructor(
    private run: Run,
    private plan: Plan,
    private slidePngs: string[],
    private recentHooks: string[] = [],
    private recentScenes: string[] = [],
  ) {}

  async shots(fixes?: string[]): Promise<ReelSpec> {
    if (!this.messages.length) {
      const liked = describeTaste(taste(), ['hook', 'energy', 'shots', 'scene photo_wall', 'scene marquee', 'scene product_drop', 'scene deck', 'scene grid', 'scene stack_list']);
      const parts: ContentPart[] = [
        {
          type: 'text',
          text: [
            `Carousel: ${this.plan.concept}`,
            `Why: ${this.plan.why}`,
            `Language: ${this.run.brief.language ?? 'the carousel language'}`,
            'Slides (the only words you may use):',
            ...this.plan.slides.map((s) => `- slide ${s.n} (${s.role}${s.photo ? `, photo ${s.photo}` : ', no photo'}): "${s.headline}" / "${s.body}"`),
            `Photos: ${this.run.photos.map((p) => `${p.id}${p.backdrop ? ' (backdrop)' : p.cutout ? ' (cutout)' : ''}${p.note ? ` ${p.note}` : ''}`).join('; ') || 'none'}`,
            `Caption (its words may be used too): ${this.plan.caption}`,
            `The carousel's visual system (the reel uses it too): ${this.run.styleNotes ?? 'not set'}`,
            `Music genres you can choose from: ${(await musicGenres()).join(', ')}`,
            liked ? `The owner's votes on past reels: ${liked}` : '',
            this.recentHooks.length
              ? `The agency's last reels for other brands opened with: ${this.recentHooks.slice(0, 4).join(', ')}. Open this one differently when the material allows (hooks you can use, least used first: ${hookOrder(this.run, this.recentHooks).join(', ')}).`
              : '',
            this.recentScenes.length
              ? `The agency's last reels went: ${this.recentScenes.map((s, i) => `${i + 1}) ${s}`).join('; ')}. Build this one with another order and other scenes in the middle, never the same sequence.`
              : '',
            'The approved slides, for the visual system:',
          ].join('\n'),
        },
      ];
      for (const png of this.slidePngs) parts.push(imagePart(await thumbnail(png, 384), 'image/jpeg'));
      this.messages = [
        { role: 'system', content: REEL_DIRECTOR },
        { role: 'user', content: parts },
      ];
    } else if (fixes?.length) {
      this.messages.push({ role: 'user', content: `Fix the shot list:\n- ${fixes.join('\n- ')}\nReply with the full JSON again.` });
    }
    const spec = await chatJson<ReelSpec>(this.messages);
    this.messages.push({ role: 'assistant', content: JSON.stringify(spec) });
    spec.shots ??= [];
    for (const s of spec.shots) {
      s.highlight ??= 'none';
      if (!s.emphasis) s.highlight = 'none';
    }
    return spec;
  }
}

export const REEL_CHECKS = ['hook_frame0', 'motion_graphics', 'readable', 'brand', 'nothing_weird', 'end_card'] as const;

type Answer = { answer: 'yes' | 'no' | 'n/a'; note?: string };

export type ReelReview = { approved: boolean; score: number; checks: Record<(typeof REEL_CHECKS)[number], Answer>; issues: string[]; fixes: string[] };

// Approved only when no check is "no"; the measured length and still ending
// override the model.
export async function reviewReel(
  run: Run,
  shots: Timed[],
  frames: { t: number; file: string; label: string }[],
  measured: { duration: number; stillEnd: number },
): Promise<ReelReview> {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        'Shot list:',
        ...shots.map((s, i) => `${i + 1}. ${s.start.toFixed(1)}-${s.end.toFixed(1)} s ${s.layout} "${s.text}"${s.items?.length ? ` [${s.items.join(' | ')}]` : ''}${s.emphasis ? ` (${s.emphasis}: ${s.highlight})` : ''}, enters with ${i ? s.transition : 'nothing (thumbnail)'}, camera ${s.camera}`),
        `Measured: length ${measured.duration.toFixed(2)} s (target 30), ending still: ${measured.stillEnd.toFixed(3)} (under 0.01 is still).`,
        run.logo ? 'The business logo:' : 'There is no logo file.',
      ].join('\n'),
    },
  ];
  if (run.logo) parts.push(imagePart(await thumbnail(run.logo.path, 256), 'image/jpeg'));
  for (const f of frames) {
    parts.push({ type: 'text', text: `Frame "${f.label}" at ${f.t.toFixed(2)} s:` });
    parts.push(imagePart((await readFile(f.file)).toString('base64'), 'image/jpeg'));
  }
  const raw = await chatJson<{ checks?: Partial<ReelReview['checks']>; score?: number; fixes?: string[] }>([
    { role: 'system', content: REEL_CRITIC },
    { role: 'user', content: parts },
  ]);
  const checks = {} as ReelReview['checks'];
  for (const key of REEL_CHECKS) {
    const answer = raw.checks?.[key];
    checks[key] = answer && ['yes', 'no', 'n/a'].includes(answer.answer) ? answer : { answer: 'no', note: 'not checked' };
  }
  const fixes = raw.fixes ?? [];
  if (Math.abs(measured.duration - 30) > 0.1) checks.nothing_weird = { answer: 'no', note: `measured length ${measured.duration.toFixed(2)} s, not 30` };
  if (measured.stillEnd > 0.01) {
    checks.end_card = { answer: 'no', note: `measured: the last 1.5 s move (${measured.stillEnd.toFixed(3)})` };
    fixes.unshift('Give the end_card more beats so the close holds still for 1.5 s.');
  }
  const failed = REEL_CHECKS.filter((k) => checks[k].answer === 'no');
  return { approved: failed.length === 0, score: raw.score ?? 0, checks, issues: failed.map((k) => `${k}: ${checks[k].note ?? 'no'}`), fixes };
}

export const SHOT_CHECKS = ['readable', 'photo', 'brand', 'nothing_weird'] as const;
export const REEL_SET_CHECKS = ['hook_frame0', 'motion_graphics', 'end_card'] as const;

export type ShotReview = {
  n: number;
  approved: boolean;
  score: number;
  checks: Record<(typeof SHOT_CHECKS)[number], Answer>;
  fixes: { action: ShotAction | 'none'; why: string }[];
};
export type ShotsReview = { approved: boolean; score: number; shots: ShotReview[]; reel: Record<(typeof REEL_SET_CHECKS)[number], Answer>; issues: string[] };

// The reel judged shot by shot, like the slides: every shot's checks and fixes in the
// closed list of actions; what code measured (the HyperFrames check per shot, the length,
// a still ending) overrides the model.
export async function reviewShots(
  run: Run,
  shots: Timed[],
  frames: { t: number; file: string; label: string }[],
  measured: { duration: number; stillEnd: number },
  lint: string[],
): Promise<ShotsReview> {
  // "#s3 > div": the check names the shot by its 0-based id.
  const lintOf = (n: number) => lint.filter((l) => new RegExp(`#s${n - 1}\\b`).test(l));
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        'Shot list:',
        ...shots.map((s, i) => `${i + 1}. ${s.start.toFixed(1)}-${s.end.toFixed(1)} s ${s.layout}${s.photo ? ` (photo ${s.photo})` : ''} "${s.text}"${s.items?.length ? ` [${s.items.join(' | ')}]` : ''}, enters with ${i ? s.transition : 'nothing (thumbnail)'}, camera ${s.camera}${s.textScale && s.textScale !== 1 ? `, text at ${Math.round(s.textScale * 100)}%` : ''}${lintOf(i + 1).length ? `. HyperFrames check: ${lintOf(i + 1).join('; ')}` : ''}`),
        `Measured: length ${measured.duration.toFixed(2)} s (target 30), ending still: ${measured.stillEnd.toFixed(3)} (under 0.01 is still).`,
        run.logo ? 'The business logo:' : 'There is no logo file.',
      ].join('\n'),
    },
  ];
  if (run.logo) parts.push(imagePart(await thumbnail(run.logo.path, 256), 'image/jpeg'));
  for (const f of frames) {
    const shot = /^shot-(\d+)$/.exec(f.label);
    parts.push({ type: 'text', text: shot ? `Shot ${shot[1]} at ${f.t.toFixed(2)} s:` : `Frame "${f.label}" at ${f.t.toFixed(2)} s:` });
    parts.push(imagePart((await readFile(f.file)).toString('base64'), 'image/jpeg'));
  }
  type RawShot = { n?: number; checks?: Partial<ShotReview['checks']>; score?: number; fixes?: { action?: string; why?: string }[] };
  const raw = await chatJson<{ shots?: RawShot[]; reel?: Partial<ShotsReview['reel']>; score?: number }>([
    { role: 'system', content: REEL_SHOT_CRITIC },
    { role: 'user', content: parts },
  ]);
  const answer = (a: Answer | undefined): Answer => (a && ['yes', 'no', 'n/a'].includes(a.answer) ? a : { answer: 'n/a', note: 'not checked' });
  const reviewed: ShotReview[] = shots.map((_, i) => {
    const n = i + 1;
    const r = raw.shots?.find((x) => x.n === n) ?? raw.shots?.[i];
    const checks = {} as ShotReview['checks'];
    for (const key of SHOT_CHECKS) checks[key] = answer(r?.checks?.[key]);
    const fixes = (r?.fixes ?? [])
      .map((f) => ({ action: (SHOT_ACTIONS as readonly string[]).includes(f.action ?? '') ? (f.action as ShotAction) : ('none' as const), why: f.why ?? '' }))
      .filter((f) => f.action !== 'none' || f.why);
    const found = lintOf(n);
    if (found.length) {
      checks.nothing_weird = { answer: 'no', note: `measured: ${found.join('; ').slice(0, 200)}` };
      if (found.some((l) => /occlud|overflow|clip/i.test(l)) && !fixes.some((f) => f.action === 'smaller_text')) fixes.push({ action: 'smaller_text', why: 'the HyperFrames check found the text covered or cut' });
    }
    const failed = SHOT_CHECKS.some((k) => checks[k].answer === 'no');
    return { n, approved: !failed, score: typeof r?.score === 'number' ? r.score : failed ? 5 : 8, checks, fixes };
  });
  const reel = {} as ShotsReview['reel'];
  for (const key of REEL_SET_CHECKS) reel[key] = answer(raw.reel?.[key]);
  const issues: string[] = [];
  if (Math.abs(measured.duration - 30) > 0.1) issues.push(`measured length ${measured.duration.toFixed(2)} s, not 30`);
  if (measured.stillEnd > 0.01) {
    reel.end_card = { answer: 'no', note: `measured: the last 1.5 s move (${measured.stillEnd.toFixed(3)})` };
    const last = reviewed[reviewed.length - 1];
    if (last && !last.fixes.some((f) => f.action === 'longer')) last.fixes.push({ action: 'longer', why: 'the close has to hold still for 1.5 s' });
  }
  for (const key of REEL_SET_CHECKS) if (reel[key].answer === 'no') issues.push(`${key}: ${reel[key].note ?? 'no'}`);
  for (const r of reviewed) for (const k of SHOT_CHECKS) if (r.checks[k].answer === 'no') issues.push(`shot ${r.n} ${k}: ${r.checks[k].note ?? 'no'}`);
  const average = reviewed.reduce((t, r) => t + r.score, 0) / Math.max(1, reviewed.length);
  const score = Math.round(((typeof raw.score === 'number' ? raw.score : average) + average) / 2);
  return { approved: reviewed.every((r) => r.approved) && REEL_SET_CHECKS.every((k) => reel[k].answer !== 'no'), score, shots: reviewed, reel, issues };
}

async function thumbnail(file: string, size: number): Promise<string> {
  const buffer = await sharp(await readFile(file)).flatten({ background: '#9a9a9a' }).resize(size, size, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  return buffer.toString('base64');
}
