import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { chatJson, imagePart, type ContentPart, type Message } from '../llm.js';
import type { ReelSpec, Timed } from '../reel.js';
import type { Plan, Run } from '../run.js';
import { REEL_CRITIC, REEL_DIRECTOR } from './prompts.js';
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

async function thumbnail(file: string, size: number): Promise<string> {
  const buffer = await sharp(await readFile(file)).flatten({ background: '#9a9a9a' }).resize(size, size, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  return buffer.toString('base64');
}
