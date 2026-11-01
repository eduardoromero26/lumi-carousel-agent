import type { LibraryItem } from './library.js';
import type { failureKinds } from './metrics.js';
import type { calibration, Judged, Stat } from './taste.js';

// What the agents learned, as a library: one shelf per kind of knowledge, one card per
// thing learned, each with the evidence behind it. Built from what the agents already
// use (votes, the owner's words, docs/LESSONS.md, the queue's failures), never stored apart.
// A card with an id is a lesson the agents apply: the owner can vote it, since a lesson
// can be learned wrong; a dislike turns it off and its note says why.
export type Card = { id?: string; title: string; text: string; evidence: string; tone: 'good' | 'bad' | 'info'; at?: string; image?: string; vote?: 1 | -1; feedback?: string | null };
export type Shelf = { id: string; title: string; about: string; cards: Card[] };
export type LearningVote = { value: 1 | -1; note: string | null };
export type Batch = { batch: string; voted: number; liked: number; stars: number | null; rated: number };

export const tasteId = (s: Stat) => `taste:${s.key}=${s.value}`;
export const noteId = (v: Judged) => `note:${v.runId}:${v.target}`;
export const lessonId = (kind: string) => `lesson:${kind}`;

type Input = {
  stats: Stat[];
  votes: Judged[];
  calibration: ReturnType<typeof calibration>;
  batches: Batch[];
  failures: ReturnType<typeof failureKinds>;
  lessons: Map<string, string>;
  learned: Map<string, LearningVote>;
  // What the runs paid to make (library.ts), with each file's URL.
  made?: { item: LibraryItem; url: string }[];
};

export function library({ stats, votes, calibration: cal, batches, failures, lessons, learned, made = [] }: Input): Shelf[] {
  const voted = (card: Card): Card => {
    const v = card.id ? learned.get(card.id) : undefined;
    return v ? { ...card, vote: v.value, feedback: v.note } : card;
  };
  const shelves: Shelf[] = [
    {
      id: 'design',
      title: 'Design',
      about: 'What you like and dislike, from your votes. The art director follows it and code samples the next choices from it.',
      cards: stats
        .filter((s) => s.up + s.down >= 2 && (s.mean >= 0.65 || s.mean <= 0.35))
        .sort((a, b) => b.up + b.down - (a.up + a.down))
        .map((s) => ({
          id: tasteId(s),
          title: `${s.mean >= 0.65 ? 'Works' : 'Avoid'}: ${s.key} ${s.value}`,
          text:
            s.mean >= 0.65
              ? `You like carousels with ${s.key} "${s.value}": it is chosen more often.`
              : `You dislike ${s.key} "${s.value}": the variety check swaps it for another.`,
          evidence: `${s.up} 👍 · ${s.down} 👎`,
          tone: s.mean >= 0.65 ? 'good' : 'bad',
        })),
    },
    {
      id: 'critic',
      title: 'Critic',
      about: "Your words on what you disliked. The critic reads them before approving the next slides, what it had approved first.",
      cards: [
        ...(cal.rate === null
          ? []
          : [
              {
                title: `The critic agrees with you on ${Math.round(cal.rate * 100)} %`,
                text: `Of ${cal.judged} votes, it approved ${cal.tooEasy.length} that you disliked and rejected ${cal.tooHard.length} that you liked.`,
                evidence: `${cal.agree}/${cal.judged} votes`,
                tone: cal.rate >= 0.8 ? 'good' : 'info',
              } satisfies Card,
            ]),
        ...votes
          .filter((v) => v.value < 0 && v.note?.trim())
          .map(
            (v): Card => ({
              id: noteId(v),
              title: `${v.business ?? 'A carousel'} · ${v.target === 'carousel' ? 'whole carousel' : v.target.replace(':', ' ')}`,
              text: v.note!.trim(),
              evidence: v.critic ? (v.critic.approved ? `the critic had approved it${v.critic.score !== null ? ` (${v.critic.score}/10)` : ''}` : 'the critic had rejected it too') : '',
              tone: v.critic?.approved ? 'bad' : 'info',
              at: v.at,
            }),
          ),
      ],
    },
    {
      id: 'fixes',
      title: 'Fixes',
      about: 'What solved each kind of failure (docs/LESSONS.md), with how often it happened in the queue.',
      cards: [...new Set([...lessons.keys(), ...failures.kinds.keys()])]
        .map((kind) => ({ kind, k: failures.kinds.get(kind), lesson: lessons.get(kind) }))
        .sort((a, b) => (b.k?.total ?? 0) - (a.k?.total ?? 0))
        .map(({ kind, k, lesson }) => {
          const last = k && Object.keys(k.perBatch).at(-1);
          return {
            id: lessonId(kind),
            title: kindName(kind),
            text: lesson ?? 'Nothing fixed it yet.',
            evidence: k
              ? `seen ${k.total} times${last ? ` · ${(k.perBatch[last] / failures.runsPerBatch[last]).toFixed(2)} per carousel in ${last}` : ''}`
              : 'not seen in the queue',
            tone: lesson ? 'good' : 'bad',
          };
        }),
    },
    {
      id: 'quality',
      title: 'Quality',
      about: 'The share of carousels you liked (4-5 stars or 👍) and the average stars in each batch: the numbers each change to the agents has to beat.',
      cards: batches.map((b) => ({
        title: `${b.batch}: ${Math.round((b.liked / b.voted) * 100)} %${b.stars !== null ? ` · ${b.stars.toFixed(1)} ★` : ''}`,
        text: `You liked ${b.liked} of the ${b.voted} carousels you voted${b.rated ? `; ${b.rated} rated with stars` : ''}.`,
        evidence: `${b.voted} votes`,
        tone: b.liked / b.voted >= 0.6 ? 'good' : 'info',
      })),
    },
    {
      id: 'decor',
      title: 'Decor',
      about: `The textures and elements Muse Image made for the decor kits. 👍 brings a piece back for its brand and lets other brands take it; 👎 with your words teaches the art director what not to ask for.${
        made.some((m) => m.item.kind === 'cutout')
          ? ` Also kept: ${made.filter((m) => m.item.kind === 'cutout').length} subjects SAM cut out, never paid twice for the same photo.`
          : ''
      }`,
      cards: made
        .filter((m) => m.item.kind !== 'cutout')
        .map(({ item, url }) => ({
          id: `library:${item.id}`,
          title: `${item.kind === 'texture' ? 'Texture' : 'Element'} · ${item.business}`,
          text: item.prompt,
          evidence: [item.type, item.personality].filter(Boolean).join(' · '),
          tone: 'info' as const,
          at: item.at,
          image: url,
        })),
    },
    {
      id: 'references',
      title: 'References',
      about: 'Recipes from ads that work (Meta Ad Library, running 30+ days): layout, hierarchy, hook and call to action, never the image. Coming next.',
      cards: [],
    },
  ];
  return shelves.map((s) => ({ ...s, cards: s.cards.map(voted) }));
}

// "check:whole_subject" → "Whole subject (critic)"; "lint:subject cut by the edge" → "Subject cut by the edge (measured)".
export function kindName(kind: string): string {
  if (kind === 'error') return 'Runs that failed';
  const [source, name = source] = kind.split(':');
  const words = name.replace(/_/g, ' ');
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return source === 'check' ? `${label} (critic)` : source === 'lint' ? `${label} (measured)` : label;
}
