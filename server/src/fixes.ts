import { normalizeTweaks, type Tweaks } from './design.js';

// The contract between the critic and the fixer: the only changes a template slide
// can take. The critic asks in these terms, the code validates, and the fixer (model
// or code) carries them out. Anything else is a template issue, not a fix.
export const FIX_ACTIONS = {
  smaller_headline: { knob: 'headScale', step: -0.1, text: 'the headline smaller' },
  bigger_headline: { knob: 'headScale', step: 0.1, text: 'the headline bigger' },
  smaller_body: { knob: 'bodyScale', step: -0.1, text: 'the body text smaller' },
  bigger_body: { knob: 'bodyScale', step: 0.1, text: 'the body text bigger' },
  smaller_photo: { knob: 'photoScale', step: -0.1, text: 'the photo or product smaller in its space, with air around it' },
  bigger_photo: { knob: 'photoScale', step: 0.1, text: 'the photo or product bigger in its space' },
  smaller_logo: { knob: 'logoScale', step: -0.15, text: 'the logo smaller' },
  bigger_logo: { knob: 'logoScale', step: 0.15, text: 'the logo bigger' },
  text_on_top: { knob: 'band', value: 'top', text: 'the text over the top band of a full-bleed photo' },
  text_on_bottom: { knob: 'band', value: 'bottom', text: 'the text over the bottom band of a full-bleed photo' },
  text_above_photo: { knob: 'band', value: 'split', text: 'the text on the ground at the top and the photo below it, whole' },
  hide_decor: { knob: 'decor', value: false, text: 'the decor element and the glow hidden on this slide' },
  another_photo: { knob: 'photo', text: 'another of the free photos, when the photo itself is the problem (cut, wrong subject, blurry)' },
} as const;

export type FixAction = keyof typeof FIX_ACTIONS;
export const ACTION_NAMES = Object.keys(FIX_ACTIONS) as FixAction[];

// One fix the critic asks for: an action from the list and why.
export type FixRequest = { action: FixAction; why: string };

// Lines for the critics' and the fixer's prompts: what the designer can do.
export function describeActions(): string {
  return [...ACTION_NAMES.map((a) => `- "${a}": ${FIX_ACTIONS[a].text}.`), '- "none": nothing in this list fixes it (say what would, in "why").'].join('\n');
}

export const FIX_JSON = '{"action": one of the actions or "none", "why": string}';

// The critic's answer, made safe: real actions go to the fixer; "none" or an unknown
// action becomes a template issue, reported once instead of sent around the loop.
export function parseFixRequests(raw: unknown): { fixes: FixRequest[]; templateIssues: string[] } {
  const fixes: FixRequest[] = [];
  const templateIssues: string[] = [];
  if (!Array.isArray(raw)) return { fixes, templateIssues };
  for (const item of raw) {
    const r = typeof item === 'string' ? { action: 'none', why: item } : (item as { action?: unknown; why?: unknown } | null);
    const why = typeof r?.why === 'string' ? r.why.trim() : '';
    const action = typeof r?.action === 'string' ? r.action.trim().toLowerCase() : '';
    if (action in FIX_ACTIONS) {
      if (!fixes.some((f) => f.action === action)) fixes.push({ action: action as FixAction, why });
    } else if (why || (action && action !== 'none')) {
      templateIssues.push(action && action !== 'none' ? `${why || 'no reason given'} (asked for "${action}", which the template has no action for)` : why);
    }
  }
  return { fixes, templateIssues };
}

// Every requested action in the fixer's settings: what the model left out, the
// code applies with the action's default step, so an agreed fix always happens.
export function enforceActions(before: Tweaks | undefined, chosen: Tweaks, requests: FixRequest[]): { tweaks: Tweaks; applied: FixAction[]; byCode: FixAction[] } {
  const tweaks: Record<string, unknown> = { ...chosen };
  const applied: FixAction[] = [];
  const byCode: FixAction[] = [];
  const current = (knob: keyof Tweaks) => (before?.[knob] as number | undefined) ?? 1;
  for (const { action } of requests) {
    const spec = FIX_ACTIONS[action];
    if (spec.knob === 'photo') continue;
    if ('step' in spec) {
      const was = current(spec.knob);
      const now = chosen[spec.knob] as number | undefined;
      const moved = typeof now === 'number' && Math.sign(now - was) === Math.sign(spec.step) && Math.abs(now - was) >= 0.02;
      if (!moved) {
        tweaks[spec.knob] = was + spec.step;
        byCode.push(action);
      }
    } else if (chosen[spec.knob] !== spec.value) {
      tweaks[spec.knob] = spec.value;
      byCode.push(action);
    }
    applied.push(action);
  }
  return { tweaks: normalizeTweaks(tweaks as Partial<Record<keyof Tweaks, unknown>>), applied, byCode };
}

export function describeRequests(requests: FixRequest[]): string {
  return requests.map((r) => `${r.action}${r.why ? ` (${r.why})` : ''}`).join('; ');
}
