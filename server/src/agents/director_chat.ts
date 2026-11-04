import { chatJson } from '../llm.js';
import type { Run } from '../run.js';
import { DIRECTOR_CHAT } from './prompts.js';

export type DirectorAnswer = { reply: string; edits: { slide: number; change: string }[] };

// The owner writes to the director in the team chat: a question gets an answer; a change
// becomes concrete changes per slide that the designer makes in GIMP.
export async function talkToDirector(run: Run, message: string): Promise<DirectorAnswer> {
  const plan = run.plan!;
  const raw = await chatJson<{ reply?: string; edits?: { slide?: unknown; change?: unknown }[] }>([
    { role: 'system', content: DIRECTOR_CHAT },
    {
      role: 'user',
      content: [
        `Carousel: ${plan.concept}`,
        `Why: ${plan.why}`,
        'Slides now:',
        ...plan.slides.map((s) => `- slide ${s.n} (${s.role}${s.photo ? `, photo ${s.photo}` : ''}): headline "${s.headline}"${s.body ? `, text "${s.body}"` : ''}${s.button ? `, button "${s.button}"` : ''}`),
        `Photos you can use: ${run.photos.filter((p) => !p.backdrop).map((p) => `${p.id}${p.cutout ? ' (cut out)' : ''}${p.note ? `: ${p.note.slice(0, 80)}` : ''}`).join('; ') || 'none'}`,
        `Facts from the website (never invent others): ${(run.site?.text ?? '').slice(0, 1500)}`,
        '',
        `The owner writes: ${message}`,
      ].join('\n'),
    },
  ]);
  const known = new Set(plan.slides.map((s) => s.n));
  const edits = (raw.edits ?? [])
    .map((e) => ({ slide: Number(e.slide), change: typeof e.change === 'string' ? e.change.trim() : '' }))
    .filter((e) => known.has(e.slide) && e.change)
    .slice(0, 5);
  return { reply: (raw.reply ?? '').trim() || 'On it.', edits };
}
