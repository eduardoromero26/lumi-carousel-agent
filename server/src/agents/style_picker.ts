import { taste } from '../db.js';
import { chatJson } from '../llm.js';
import { references, type Reference } from '../references.js';
import type { Plan, Run } from '../run.js';
import { describeTaste } from '../taste.js';
import { STYLE_PICKER } from './prompts.js';

export type StylePick = { ref: Reference; business: string; cta: string; why: string };

// The owner no longer browses the gallery: the art director picks the style from the agency's
// library, by the kind of business and the call to action, with what the owner's votes say
// about each reference. Undefined when the library is empty or the pick fails.
export async function pickReference(run: Run, plan: Plan, exclude: string[] = []): Promise<StylePick | undefined> {
  const library = references().filter((r) => !exclude.includes(r.id));
  if (!library.length) return undefined;
  const close = plan.slides.at(-1);
  const kinds = new Map<string, number>();
  for (const a of run.assets) if (a.kind && a.kind !== 'logo' && a.kind !== 'icon') kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  const liked = describeTaste(taste(), ['reference']);
  const raw = await chatJson<{ business?: string; cta?: string; id?: string; why?: string }>([
    { role: 'system', content: STYLE_PICKER },
    {
      role: 'user',
      content: [
        `Business: ${run.site?.title ?? run.brief.url ?? ''} (${plan.business_type ?? 'business'}). Carousel format: ${plan.format ?? 'benefits'}.`,
        `Concept: ${plan.concept}`,
        `Its call to action (last slide): "${close?.headline ?? ''}"${close?.button ? `, button "${close.button}"` : ''}.`,
        `The images it has: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}.`,
        liked ? `The owner's votes on the references used before: ${liked}` : '',
        'The library (id · title · its choices — what makes it look like it does):',
        ...library.map((r) => `${r.id} · ${r.title} · ${r.style.composition}, ${r.style.ground} ground, ${r.style.personality}, ${r.style.products === 'loose' ? 'products loose' : 'products on cards'} — ${r.style.notes.slice(0, 180)}`),
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ]);
  const ref = library.find((r) => r.id === raw.id);
  if (!ref) return undefined;
  return { ref, business: `${raw.business ?? plan.business_type ?? 'business'}`, cta: `${raw.cta ?? 'act'}`, why: `${raw.why ?? ''}` };
}
