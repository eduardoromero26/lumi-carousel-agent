import { COMPOSITIONS, type DesignSystem } from './design.js';
import { sampleChoice, votesOn, type Stat } from './taste.js';
import type { Run } from './run.js';

// What makes a carousel and its reel look like themselves, kept per run so the next
// brand doesn't come out the same: before this, 19 of 19 carousels had the logo top
// center, 18 a pill label, Oswald headed 6 brands and 3 of 4 reels opened on the wall.
export type Look = {
  host: string;
  personality?: Personality;
  composition?: DesignSystem['composition'];
  headingFont?: string;
  bodyFont?: string;
  device?: DesignSystem['device'];
  logoPosition?: DesignSystem['logoPosition'];
  align?: DesignSystem['align'];
  headlineCase?: DesignSystem['headlineCase'];
  hook?: string;
};

export const PERSONALITIES = ['editorial', 'bold', 'friendly', 'modern', 'heritage', 'clean'] as const;
export type Personality = (typeof PERSONALITIES)[number];

type Font = { family: string; weight: number };

// Google Fonts by the brand's personality: the art director names the personality,
// the code keeps the pair away from what other brands just used.
export const FONTS: Record<Personality, { heading: Font[]; body: string[]; hint: string }> = {
  editorial: {
    hint: 'jewelry, fashion, law, architecture, premium: serif headlines, quiet and spacious',
    heading: [
      { family: 'Playfair Display', weight: 700 },
      { family: 'Cormorant Garamond', weight: 700 },
      { family: 'DM Serif Display', weight: 400 },
      { family: 'Bodoni Moda', weight: 700 },
      { family: 'Fraunces', weight: 700 },
      { family: 'Libre Caslon Text', weight: 700 },
    ],
    body: ['Lato', 'Karla', 'Source Sans 3', 'Jost'],
  },
  bold: {
    hint: 'gyms, streetwear, entertainment, sports, nightlife: condensed or black headlines that shout',
    heading: [
      { family: 'Anton', weight: 400 },
      { family: 'Bebas Neue', weight: 400 },
      { family: 'Archivo Black', weight: 400 },
      { family: 'Barlow Condensed', weight: 800 },
      { family: 'Big Shoulders Display', weight: 800 },
      { family: 'Oswald', weight: 700 },
    ],
    body: ['Barlow', 'Roboto Condensed', 'Archivo', 'Rubik'],
  },
  friendly: {
    hint: 'health, kids, pets, family services, education: rounded and warm',
    heading: [
      { family: 'Fredoka', weight: 600 },
      { family: 'Baloo 2', weight: 800 },
      { family: 'Nunito', weight: 800 },
      { family: 'Quicksand', weight: 700 },
      { family: 'Comfortaa', weight: 700 },
      { family: 'Varela Round', weight: 400 },
    ],
    body: ['Nunito Sans', 'Mulish', 'Rubik', 'Figtree'],
  },
  modern: {
    hint: 'tech, agencies, startups, design studios: geometric or grotesk, tight',
    heading: [
      { family: 'Space Grotesk', weight: 700 },
      { family: 'Sora', weight: 700 },
      { family: 'Unbounded', weight: 700 },
      { family: 'Plus Jakarta Sans', weight: 800 },
      { family: 'Manrope', weight: 800 },
      { family: 'Outfit', weight: 700 },
    ],
    body: ['DM Sans', 'Inter', 'IBM Plex Sans', 'Hanken Grotesk'],
  },
  heritage: {
    hint: 'restaurants, coffee, barbers, bakeries, craft, tradition: slab or display with character',
    heading: [
      { family: 'Abril Fatface', weight: 400 },
      { family: 'Alfa Slab One', weight: 400 },
      { family: 'Zilla Slab', weight: 700 },
      { family: 'Roboto Slab', weight: 800 },
      { family: 'Bitter', weight: 800 },
      { family: 'Arvo', weight: 700 },
    ],
    body: ['Lora', 'Work Sans', 'Libre Franklin', 'Crimson Pro'],
  },
  clean: {
    hint: 'retail, home, appliances, everyday products: a neutral, sturdy sans',
    heading: [
      { family: 'Figtree', weight: 800 },
      { family: 'Schibsted Grotesk', weight: 800 },
      { family: 'Archivo', weight: 800 },
      { family: 'Work Sans', weight: 700 },
      { family: 'Poppins', weight: 700 },
      { family: 'Montserrat', weight: 800 },
    ],
    body: ['Public Sans', 'Open Sans', 'Libre Franklin', 'Inter'],
  },
};

export function describeFonts(): string {
  return PERSONALITIES.map((p) => `- "${p}" (${FONTS[p].hint}): headlines ${FONTS[p].heading.map((f) => f.family).join(', ')}; text ${FONTS[p].body.join(', ')}`).join('\n');
}

export function hostOf(url?: string): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// The last reel's shot list is in its "thought" event.
export function lookOf(run: Run): Look {
  const s = run.system;
  const reel = run.events.findLast((e) => (e.data as { reel?: { shots?: { layout?: string }[] } } | undefined)?.reel?.shots?.length)?.data as
    | { reel: { shots: { layout?: string }[] } }
    | undefined;
  return {
    host: hostOf(run.brief.url),
    personality: s?.personality,
    // Before compositions every carousel was stacked.
    composition: s ? (s.composition ?? 'stacked') : undefined,
    headingFont: s?.headingFont,
    bodyFont: s?.bodyFont,
    device: s?.device,
    logoPosition: s?.logoPosition,
    align: s?.align,
    headlineCase: s?.headlineCase,
    hook: reel?.reel.shots[0]?.layout,
  };
}

export function describeLooks(looks: Look[]): string {
  return looks
    .map((l) => `- ${l.host}: ${l.composition ?? 'stacked'}, ${l.headingFont ?? '?'} / ${l.bodyFont ?? '?'}, ${l.device?.replace('_', ' ')}, logo ${l.logoPosition?.replace('_', ' ')}, ${l.align}, ${l.headlineCase === 'upper' ? 'capitals' : 'as is'}`)
    .join('\n');
}

// The website's own fonts always win; a fallback font another brand just used is
// swapped for the next one of the same personality.
export function freshen(system: DesignSystem, siteFonts: string[], recent: Look[], hasLabels: boolean, stats: Stat[] = []): string[] {
  const changes: string[] = [];
  const own = new Set(siteFonts.map((f) => f.toLowerCase()));
  const last = recent.slice(0, 5);
  const used = (font: string, n: number) => last.slice(0, n).some((l) => [l.headingFont, l.bodyFont].some((f) => f?.toLowerCase() === font.toLowerCase()));
  const fonts = FONTS[system.personality ?? 'clean'];

  if (!own.has(system.headingFont.toLowerCase()) && used(system.headingFont, 5)) {
    const next = fonts.heading.find((f) => !used(f.family, 5) && !own.has(f.family.toLowerCase())) ?? fonts.heading.find((f) => !used(f.family, 2));
    if (next && next.family !== system.headingFont) {
      changes.push(`headlines ${system.headingFont} → ${next.family} (other brands just used it)`);
      system.headingFont = next.family;
      system.headingWeight = next.weight;
    }
  }
  if (!own.has(system.bodyFont.toLowerCase()) && used(system.bodyFont, 5) && system.bodyFont !== system.headingFont) {
    const next = fonts.body.find((f) => !used(f, 5) && f !== system.headingFont) ?? fonts.body.find((f) => !used(f, 2) && f !== system.headingFont);
    if (next) {
      changes.push(`text ${system.bodyFont} → ${next}`);
      system.bodyFont = next;
      system.bodyWeight = 400;
    }
  }

  // Most of the last five with the same composition, device or logo position, or a
  // choice the owner voted down: this one changes. With three votes or more on that
  // choice the replacement is sampled from the votes, else it is the least used.
  const most = (n: number) => last.length >= 3 && n > last.length / 2;
  const disliked = (key: string, value: string) => {
    const s = stats.find((x) => x.key === key && x.value === value);
    return !!s && s.up + s.down >= 3 && s.mean <= 0.35;
  };
  const pick = <T extends string>(key: string, options: T[], uses: (o: T) => number) =>
    (votesOn(stats, key) >= 3 ? sampleChoice(stats, key, options) : undefined) ?? [...options].sort((a, b) => uses(a) - uses(b))[0];
  const laidOut = (c: string) => last.filter((l) => (l.composition ?? 'stacked') === c).length;
  if (most(laidOut(system.composition)) || disliked('composition', system.composition)) {
    // The overlay needs photos with room for the text: only the art director picks it.
    const composition = pick('composition', COMPOSITIONS.filter((c) => c !== system.composition && c !== 'overlay'), laidOut);
    changes.push(`composition ${system.composition} → ${composition}`);
    system.composition = composition;
  }
  const devices = (['underline', 'frame', 'pill_label'] as const).filter((d) => d !== 'pill_label' || hasLabels);
  const count = (d: string) => last.filter((l) => l.device === d).length;
  if (most(count(system.device)) || disliked('device', system.device)) {
    const device = pick('device', devices.filter((d) => d !== system.device), count);
    if (device) {
      changes.push(`device ${system.device.replace('_', ' ')} → ${device.replace('_', ' ')}`);
      system.device = device;
    }
  }
  if (most(last.filter((l) => l.logoPosition === system.logoPosition).length)) {
    const other = system.logoPosition === 'top_center' ? 'bottom_center' : 'top_center';
    changes.push(`logo ${system.logoPosition.replace('_', ' ')} → ${other.replace('_', ' ')}`);
    system.logoPosition = other;
  }
  // The photo takes the top edge: the logo goes to the foot.
  if ((system.composition === 'photo_top' || system.composition === 'overlay') && system.logoPosition !== 'bottom_center') {
    changes.push('logo at the foot, under the text (the photo takes the top)');
    system.logoPosition = 'bottom_center';
  }
  return changes;
}

export const HOOKS = ['photo_wall', 'photo_full', 'marquee'] as const;

// The hooks this run can use, the least used by the last reels first.
export function hookOrder(run: Run, recentHooks: string[]): (typeof HOOKS)[number][] {
  const possible = HOOKS.filter((h) => (h === 'marquee' ? run.photos.some((p) => p.cutout) : run.photos.length > 0));
  const count = (h: string) => recentHooks.slice(0, 4).filter((x) => x === h).length;
  return [...possible].sort((a, b) => count(a) - count(b));
}
