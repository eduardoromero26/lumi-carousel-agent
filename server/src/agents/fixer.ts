import { normalizeTweaks, type Tweaks } from '../design.js';
import { describeRequests, enforceActions, type FixAction, type FixRequest } from '../fixes.js';
import { chatJson, imagePart, type ContentPart } from '../llm.js';
import type { Plan, Run, SlidePlan } from '../run.js';
import type { Built } from '../templates.js';
import { FIXER } from './prompts.js';

export type Fix = {
  tweaks: Tweaks;
  photo?: string;
  text?: { headline?: string; body?: string; eyebrow?: string; button?: string };
  // The owner's changes the template can't make: they go to the retoucher.
  hands: string[];
  note: string;
  // The critic's actions carried out (those the model skipped, the code applied) and
  // the ones nothing could do (no free photo to switch to).
  applied: FixAction[];
  byCode: FixAction[];
  unmet: FixAction[];
};

// The designer of a template slide fixes it by choosing the template's settings
// (sizes, where the text goes, how big the photo is, another photo), never by
// moving layers by hand: the slide is rebuilt, so it can't break.
// requests: the critic's fixes in the contract's actions; every one gets done.
// owner: what the business owner asked, still to honor in the critic's rounds (the
// words can change while there is an owner's request).
export async function chooseFix(
  run: Run,
  plan: Plan,
  slide: SlidePlan,
  built: Built | undefined,
  issues: string[],
  requests: FixRequest[],
  snapshot: string | undefined,
  from: 'critic' | 'owner',
  owner: string[] = [],
): Promise<Fix> {
  const words = from === 'owner' || owner.length > 0;
  const used = new Set(plan.slides.filter((s) => s.n !== slide.n).map((s) => s.photo));
  const photos = run.photos.filter((p) => !used.has(p.id) && p.id !== slide.photo && !p.cropped);
  const current = slide.photo ? run.photos.find((p) => p.id === slide.photo) : undefined;
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        `Slide ${slide.n} of ${plan.slides.length}, template "${slide.layout ?? 'photo_band'}".`,
        `Text: ${slide.eyebrow ? `label "${slide.eyebrow}", ` : ''}headline "${slide.headline}", body "${slide.body || ''}"${slide.button ? `, button "${slide.button}"` : ''}.`,
        `Photo: ${current ? `${current.id} — ${current.note ?? ''}` : 'none'}.`,
        built
          ? `As built: ${built.card ? 'the photo in a card, the text under it' : built.split ? 'text on the ground at the top, the photo below it' : built.photoFrame ? `photo full-bleed, text on the ${built.textBand} band` : 'text only'}; text at ${Math.round(built.textScale * 100)} % of its size.`
          : '',
        `Current settings: ${JSON.stringify(slide.tweaks ?? {})}.`,
        photos.length ? `Photos no other slide uses: ${photos.map((p) => `${p.id}${p.cutout ? ' (cutout)' : p.backdrop ? ' (backdrop)' : ''} — ${p.note ?? ''}`).join('; ')}.` : 'No other photo is free.',
        from === 'owner' ? `The business owner asks: ${issues.join('; ')}` : `The art director rejected it:\n- ${issues.join('\n- ')}`,
        requests.length ? `The art director's actions, every one to be done: ${describeRequests(requests)}.` : '',
        from === 'critic' && owner.length ? `The business owner asked, and it must be done (you may change the words for it): ${owner.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  if (snapshot) parts.push({ type: 'text', text: 'The slide now:' }, imagePart(snapshot));
  const raw = await chatJson<{ tweaks?: Record<string, unknown>; photo?: string | null; text?: Fix['text']; hands?: string[]; note?: string }>([
    { role: 'system', content: FIXER },
    { role: 'user', content: parts },
  ]);
  const chosen = normalizeTweaks({ ...(slide.tweaks ?? {}), ...(raw.tweaks ?? {}) });
  const { tweaks, applied, byCode } = enforceActions(slide.tweaks, chosen, requests);
  let photo = raw.photo && photos.some((p) => p.id === raw.photo) ? raw.photo : undefined;
  const unmet: FixAction[] = [];
  if (requests.some((r) => r.action === 'another_photo')) {
    if (!photo && photos.length) {
      photo = photos[0].id;
      byCode.push('another_photo');
    }
    if (photo) applied.push('another_photo');
    else unmet.push('another_photo');
  }
  // Only the owner changes the words; the art director's fixes keep the plan's text.
  const text =
    words && raw.text
      ? Object.fromEntries(Object.entries(raw.text).filter(([k, v]) => ['headline', 'body', 'eyebrow', 'button'].includes(k) && typeof v === 'string'))
      : undefined;
  return { tweaks, photo, text, hands: words ? (raw.hands ?? []).filter((h) => typeof h === 'string' && h.trim()) : [], note: raw.note ?? '', applied, byCode, unmet };
}
