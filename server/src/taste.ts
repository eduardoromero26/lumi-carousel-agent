import type { Run } from './run.js';

// The owner's taste, learned from votes: each vote keeps the design choices of what
// was voted (a snapshot, so later runs don't change it), and every choice gets a
// Beta(1 + likes, 1 + dislikes). The art director reads it; the code samples from it
// (Thompson sampling) so a choice nobody voted yet still gets tried.
export type Features = Record<string, string>;
export type Vote = { value: 1 | -1; features: Features };
export type Stat = { key: string; value: string; up: number; down: number; mean: number };

// What a carousel, one of its slides or its reel was made of.
export function featuresOf(run: Run, target: string): Features {
  const s = run.system;
  const f: Features = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') f[key] = String(value);
  };
  if (target === 'reel') {
    const spec = run.events.findLast((e) => (e.data as { reel?: { shots?: unknown[] } } | undefined)?.reel?.shots?.length)?.data as
      | { reel: { shots: { layout: string; transition?: string }[]; music?: { energy?: string } } }
      | undefined;
    put('hook', spec?.reel.shots[0]?.layout);
    put('energy', spec?.reel.music?.energy);
    put('shots', spec ? (spec.reel.shots.length <= 7 ? '6-7' : '8-9') : undefined);
    for (const layout of new Set(spec?.reel.shots.slice(1, -1).map((x) => x.layout) ?? [])) put(`scene ${layout}`, 'yes');
    return f;
  }
  put('composition', s?.composition ?? (s ? 'stacked' : undefined));
  put('personality', s?.personality);
  put('heading font', s?.headingFont);
  put('body font', s?.bodyFont);
  put('device', s?.device);
  put('logo', s?.logoPosition);
  put('align', s?.align);
  put('case', s?.headlineCase);
  put('ground', s ? (s.ground === 'gradient' ? 'gradient' : 'flat') + (s.grain ? ' + grain' : '') : undefined);
  put('decor', s ? (s.decor?.elementFile ? 'element' : s.decor?.textureFile ? 'texture' : 'none') : undefined);
  put('type', s?.typeScale);
  put('color slides', s?.colorSlides);
  put('numbers', s ? (s.numbers ? 'yes' : 'no') : undefined);
  put('format', run.plan?.format);
  const n = target.startsWith('slide:') ? Number(target.slice(6)) : NaN;
  const slide = run.plan?.slides.find((x) => x.n === n);
  if (slide) {
    const photo = run.photos.find((p) => p.id === slide.photo);
    put('layout', slide.layout);
    put('photo', !photo ? 'none' : photo.backdrop ? 'backdrop' : photo.cutout ? 'cutout' : 'real');
    put('headline', slide.headline.split(/\s+/).length <= 3 ? '1-3 words' : '4+ words');
  }
  return f;
}

export function tasteStats(votes: Vote[]): Stat[] {
  const counts = new Map<string, Stat>();
  for (const v of votes) {
    for (const [key, value] of Object.entries(v.features)) {
      const id = `${key}\u0000${value}`;
      const s = counts.get(id) ?? { key, value, up: 0, down: 0, mean: 0.5 };
      if (v.value > 0) s.up++;
      else s.down++;
      s.mean = (s.up + 1) / (s.up + s.down + 2);
      counts.set(id, s);
    }
  }
  return [...counts.values()].sort((a, b) => a.key.localeCompare(b.key) || b.mean - a.mean);
}

// For a prompt: what the owner clearly likes and dislikes (two votes or more).
export function describeTaste(stats: Stat[], keys: string[]): string {
  const sure = stats.filter((s) => keys.includes(s.key) && s.up + s.down >= 2);
  const fmt = (s: Stat) => `${s.key} ${s.value} (${s.up} up, ${s.down} down)`;
  const liked = sure.filter((s) => s.mean >= 0.65).sort((a, b) => b.mean - a.mean);
  const disliked = sure.filter((s) => s.mean <= 0.35).sort((a, b) => a.mean - b.mean);
  return [liked.length ? `The owner liked: ${liked.map(fmt).join('; ')}.` : '', disliked.length ? `The owner disliked: ${disliked.map(fmt).join('; ')}.` : '']
    .filter(Boolean)
    .join(' ');
}

// Thompson sampling: one draw from each option's Beta, the highest wins.
export function sampleChoice<T extends string>(stats: Stat[], key: string, options: readonly T[]): T | undefined {
  if (!options.length) return undefined;
  const draw = (o: T) => {
    const s = stats.find((x) => x.key === key && x.value === o);
    return beta(1 + (s?.up ?? 0), 1 + (s?.down ?? 0));
  };
  return options.map((o) => [o, draw(o)] as const).sort((a, b) => b[1] - a[1])[0][0];
}

// What the critic said about what the owner voted, kept at vote time like the features.
export type Verdict = { approved: boolean; score: number | null };
export type Judged = { value: 1 | -1; target: string; critic: Verdict | null; note: string | null; business?: string; runId?: string; at?: string };

// How often the critic agrees with the owner: its approval should mean the owner's
// like. "Too easy" is what it approved and the owner disliked, the miss that matters.
export function calibration(votes: Judged[]) {
  const judged = votes.filter((v) => v.critic);
  const agree = judged.filter((v) => v.critic!.approved === v.value > 0).length;
  return {
    votes: votes.length,
    liked: votes.filter((v) => v.value > 0).length,
    judged: judged.length,
    agree,
    rate: judged.length ? agree / judged.length : null,
    tooEasy: judged.filter((v) => v.critic!.approved && v.value < 0),
    tooHard: judged.filter((v) => !v.critic!.approved && v.value > 0),
  };
}

// For the critic's prompt: the owner's own words on what they disliked, newest first,
// the work the critic had approved before the rest.
export function describeLessons(votes: Judged[], limit = 12): string {
  const lessons = votes
    .filter((v) => v.value < 0 && v.note?.trim())
    .sort((a, b) => Number(!!b.critic?.approved) - Number(!!a.critic?.approved))
    .slice(0, limit);
  return lessons
    .map((v) => {
      const what = v.target === 'carousel' ? 'a whole carousel' : v.target === 'reel' ? 'a reel' : v.target.replace(':', ' ');
      const critic = v.critic?.approved ? ` that you had approved${v.critic.score !== null ? ` with ${v.critic.score}/10` : ''}` : '';
      return `- ${what}${critic}: "${v.note!.trim()}"`;
    })
    .join('\n');
}

export function votesOn(stats: Stat[], key: string): number {
  return stats.filter((s) => s.key === key).reduce((t, s) => t + s.up + s.down, 0);
}

// Beta(a, b) with whole a and b: X / (X + Y), X and Y sums of exponentials.
function beta(a: number, b: number): number {
  const gamma = (k: number) => {
    let sum = 0;
    for (let i = 0; i < k; i++) sum -= Math.log(1 - Math.random());
    return sum;
  };
  const x = gamma(a);
  return x / (x + gamma(b));
}
