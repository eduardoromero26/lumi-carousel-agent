import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config } from './config.js';
import type { LayerInfo } from './gimp.js';
import type { Photo, Plan, Run } from './run.js';
import { keyOut } from './cutout.js';
import type { MusicBrief, SfxKind, Track } from './music.js';
import { HOOKS as HOOK_LAYOUTS, hookOrder } from './variety.js';

const exec = promisify(execFile);
const GSAP = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';

export const REEL = { width: 1080, height: 1920, seconds: 30, beat: 0.5, safe: { x1: 80, x2: 1000, y1: 280, y2: 1470 } } as const;
export const LAYOUTS = ['photo_wall', 'marquee', 'product_drop', 'deck', 'grid', 'stack_list', 'photo_full', 'photo_window', 'type_only', 'end_card'] as const;
export const TRANSITIONS = ['carry', 'iris', 'zoom_through', 'whip', 'clip_wipe', 'band', 'panel', 'blur_crossfade', 'cut'] as const;
// Scenes: several elements land inside one shot, which is what reads as motion graphics.
const SCENES = new Set<string>(['photo_wall', 'marquee', 'product_drop', 'deck', 'grid', 'stack_list']);
const NEEDS_PHOTO = new Set<string>(['photo_full', 'photo_window', 'product_drop', 'marquee']);
const HOOKS = new Set<string>(HOOK_LAYOUTS);
export const TEXT_IN = ['words', 'rise', 'slam'] as const;
export const HIGHLIGHTS = ['marker', 'underline', 'color', 'none'] as const;
export const CAMERAS = ['push_in', 'pull_out', 'pan_left', 'pan_right'] as const;

export type Shot = {
  slide: number;
  layout: (typeof LAYOUTS)[number];
  photo?: string | null;
  text: string;
  emphasis?: string;
  text_in: (typeof TEXT_IN)[number];
  highlight: (typeof HIGHLIGHTS)[number];
  camera: (typeof CAMERAS)[number];
  // How this shot enters; ignored on the first one.
  transition: (typeof TRANSITIONS)[number];
  beats: number;
  // End card only: a short call to action in a pill.
  button?: string;
  // deck: the photos dealt as cards (photo_wall: optional, all of them by default).
  photos?: string[];
  // deck: one label per card; stack_list: the slabs; product_drop: up to 3 chips.
  items?: string[];
  // The critic's bigger_text / smaller_text, applied by code (0.7 to 1.3).
  textScale?: number;
};

// The close, rotated by code like the carousels' grounds: on the accent with the logo on
// top, on the dark ground with an accent button, or the logo low with the words above it.
export const END_STYLES = ['accent', 'dark', 'low'] as const;
export type EndStyle = (typeof END_STYLES)[number];

export function endOrder(recent: (string | undefined)[]): EndStyle[] {
  const count = (e: string) => recent.filter((r) => r === e).length;
  return [...END_STYLES].sort((a, b) => count(a) - count(b));
}

export type ReelSpec = { shots: Shot[]; notes?: string; music?: MusicBrief; endStyle?: EndStyle };

// The music bed and the sound effects of the reel.
export type Sound = { music?: Track; sfx: Partial<Record<SfxKind, string>> };

export type Look = {
  headFont: { family: string; weight: number };
  bodyFont: { family: string; weight: number };
  dark: string;
  accent: string;
  ink: string;
  // The brand's way of designing, from the carousel's system.
  onAccent?: string;
  align?: 'center' | 'left';
  radius?: number;
  loose?: boolean;
  ground2?: string;
  grain?: boolean;
  tracking?: number;
  upper?: boolean;
  button?: 'filled' | 'outline';
};

// Timing of one shot, all in seconds from the start of the reel.
type Timed = Shot & { start: number; end: number; textIn: number; textDone: number; readAt: number; words: string[] };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const norm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}$%]/gu, '');

// The agency's rules the code can measure. Problems go back to the reel director.
export function validateReel(spec: ReelSpec, run: Run, plan: Plan, recentHooks: string[] = []): string[] {
  const problems: string[] = [];
  const shots = spec.shots ?? [];
  if (shots.length < 6 || shots.length > 9) problems.push(`use 6 to 9 shots (got ${shots.length})`);
  const total = shots.reduce((t, s) => t + (s.beats || 0), 0);
  if (total !== REEL.seconds / REEL.beat) problems.push(`the beats must add up to ${REEL.seconds / REEL.beat} (30 s at 0.5 s per beat); they add up to ${total}`);
  const allowed = new Set(words([plan.slides.map((s) => `${s.headline} ${s.body}`).join(' '), plan.caption, run.site?.title ?? ''].join(' ')).map(norm));
  const photos = new Set(run.photos.map((p) => p.id));
  const cutouts = run.photos.filter((p) => p.cutout).map((p) => p.id);
  let typeOnly = 0;
  shots.forEach((s, i) => {
    const at = `shot ${i + 1}`;
    if (!LAYOUTS.includes(s.layout)) problems.push(`${at}: layout must be one of ${LAYOUTS.join(', ')}`);
    if (!TEXT_IN.includes(s.text_in)) problems.push(`${at}: text_in must be one of ${TEXT_IN.join(', ')}`);
    if (!HIGHLIGHTS.includes(s.highlight)) problems.push(`${at}: highlight must be one of ${HIGHLIGHTS.join(', ')}`);
    if (!CAMERAS.includes(s.camera)) problems.push(`${at}: camera must be one of ${CAMERAS.join(', ')}`);
    if (i > 0 && !TRANSITIONS.includes(s.transition)) problems.push(`${at}: transition must be one of ${TRANSITIONS.join(', ')}`);
    if (i > 1 && s.transition === shots[i - 1].transition && s.transition !== 'cut') problems.push(`${at}: never the same transition twice in a row (${s.transition})`);
    if (s.transition === 'panel' && i > 0 && s.layout !== 'type_only' && s.layout !== 'end_card') problems.push(`${at}: "panel" only leads into type_only or end_card`);
    if (NEEDS_PHOTO.has(s.layout) && !(s.photo && photos.has(s.photo))) problems.push(`${at}: ${s.layout} needs one of the photos (${[...photos].join(', ') || 'none'})`);
    if ((s.layout === 'product_drop' || s.layout === 'marquee') && s.photo && !cutouts.includes(s.photo)) problems.push(`${at}: ${s.layout} needs a cutout photo (${cutouts.join(', ') || 'none: use deck or photo_window'})`);
    if (s.layout === 'grid') {
      const tiles = (s.photos ?? []).filter((p) => photos.has(p));
      if (tiles.length < 2 || tiles.length > 4) problems.push(`${at}: grid shows 2 to 4 valid photos (got ${tiles.length})`);
    }
    const items = s.items ?? [];
    if (s.layout === 'deck') {
      const dealt = (s.photos ?? []).filter((p) => photos.has(p));
      if (dealt.length < 2 || dealt.length > 5) problems.push(`${at}: deck deals 2 to 5 valid photos (got ${dealt.length})`);
      if (items.length !== (s.photos ?? []).length) problems.push(`${at}: deck needs one label in "items" per photo`);
    }
    if (s.layout === 'stack_list' && (items.length < 2 || items.length > 4)) problems.push(`${at}: stack_list needs 2 to 4 items`);
    if (s.layout === 'product_drop' && items.length > 3) problems.push(`${at}: product_drop has at most 3 chips`);
    if (s.layout === 'grid' && items.length > (s.photos ?? []).length) problems.push(`${at}: grid has at most one label per photo`);
    const maxItem = s.layout === 'stack_list' ? 5 : s.layout === 'deck' ? 4 : 3;
    for (const item of items) if (words(item).length > maxItem) problems.push(`${at}: "${item}" is too long for a ${s.layout} item (max ${maxItem} words)`);
    if (s.layout === 'type_only') typeOnly++;
    const w = words(s.text ?? '');
    if (!w.length) problems.push(`${at}: empty text`);
    if (w.length > (s.layout === 'end_card' ? 8 : 7)) problems.push(`${at}: max 7 words per shot (got ${w.length}): split it into two shots`);
    const invented = [...w, ...words(s.button ?? ''), ...items.flatMap(words)].filter((x) => norm(x) && !allowed.has(norm(x)));
    if (invented.length) problems.push(`${at}: these words are not in the carousel text: ${invented.join(' ')}. Use only the carousel's words.`);
    if (s.emphasis && !w.some((x) => norm(x) === norm(s.emphasis!))) problems.push(`${at}: emphasis "${s.emphasis}" is not a word of its text`);
    const need = readingBeats(s, i);
    if ((s.beats || 0) < need) problems.push(`${at}: ${s.beats} beats are too short to read ${w.length} words; give it at least ${need}`);
  });
  if (shots.length && shots[shots.length - 1].layout !== 'end_card') problems.push('the last shot must be the end_card');
  if (shots.length && !HOOKS.has(shots[0].layout) && run.photos.length) problems.push('shot 1 (the hook) must be photo_wall, marquee or photo_full');
  // Every brand opening the same way is what makes the feed look like one template.
  const others = hookOrder(run, recentHooks).filter((h) => h !== shots[0]?.layout);
  if (shots.length && recentHooks.slice(0, 2).filter((h) => h === shots[0].layout).length === 2 && others.length) {
    problems.push(`the agency's last reels already opened with ${shots[0].layout}: open this brand with ${others.join(' or ')}`);
  }
  const kinds = new Set(shots.filter((s) => SCENES.has(s.layout)).map((s) => s.layout));
  if (kinds.size < 3) problems.push(`use at least 3 different kinds of scene (got ${[...kinds].join(', ') || 'none'}): design the sequence for this brand`);
  const energy = spec.music?.energy;
  if (energy === 'calm' && shots.length > 7) problems.push(`a calm brand gets 6 or 7 longer shots (got ${shots.length})`);
  if (energy === 'high' && shots.length < 7) problems.push(`a high-energy brand gets 7 to 9 shots (got ${shots.length})`);
  if (typeOnly > 2) problems.push(`at most 2 type_only shots (got ${typeOnly}): the photos are what sells`);
  const scenes = shots.filter((s) => SCENES.has(s.layout)).length;
  if (scenes < 3) problems.push(`use at least 3 scenes (photo_wall, product_drop, deck, stack_list), got ${scenes}: one photo with its headline per shot reads as a slideshow`);
  const singles = shots.filter((s) => s.layout === 'photo_full' || s.layout === 'photo_window').length;
  if (singles > 3) problems.push(`at most 3 photo_full or photo_window shots (got ${singles}): show products together in a deck or drop them`);
  const used = new Set(shots.flatMap((s) => (s.layout === 'photo_wall' ? run.photos.map((p) => p.id) : [s.photo, ...(s.photos ?? [])])).filter(Boolean));
  const unused = run.photos.filter((p) => plan.slides.some((s) => s.photo === p.id) && !used.has(p.id)).map((p) => p.id);
  if (unused.length) problems.push(`use every photo of the carousel at least once (missing ${unused.join(', ')})`);
  return problems;
}

// The beats a shot needs to be read. Reading: entrance, then 0.5 s + 0.3 s per word
// still, before the next cut. The first shot is on screen at frame 0; the end card
// adds its button and the still close.
function readingBeats(s: Shot, i: number): number {
  const w = words(s.text ?? '');
  const items = s.items ?? [];
  const entrance = i === 0 ? 0 : 0.6 + 0.08 * w.length;
  const close = s.layout === 'end_card' ? (s.button ? 1.6 : 0) + 1.5 : 0;
  const itemWords = items.reduce((t, x) => t + words(x).length, 0);
  // Scenes: the cards and slabs land one by one and the last one is read too.
  const scene =
    s.layout === 'deck'
      ? 0.7 * (s.photos ?? []).length + 0.3 * words(items[items.length - 1] ?? '').length
      : s.layout === 'stack_list'
        ? 0.5 * items.length + 0.15 * itemWords
        : s.layout === 'product_drop'
          ? 0.7 + 0.4 * items.length
          : s.layout === 'grid'
            ? 0.35 * (s.photos ?? []).length
            : 0;
  return Math.ceil((entrance + 0.5 + 0.3 * w.length + (s.highlight !== 'none' ? 0.5 : 0) + close + scene) / REEL.beat);
}

// Reading time is arithmetic, not taste: every shot gets at least the beats its words
// need and the total is balanced to 30 s from the shots with beats to spare, instead
// of a round trip to the director. False when the words can't fit in 30 s at all.
export function fitBeats(spec: ReelSpec): boolean {
  const shots = spec.shots ?? [];
  const target = REEL.seconds / REEL.beat;
  const need = shots.map((s, i) => readingBeats(s, i));
  if (!shots.length || need.reduce((t, n) => t + n, 0) > target) return false;
  shots.forEach((s, i) => (s.beats = Math.max(Math.round(s.beats || 0), need[i])));
  let total = shots.reduce((t, s) => t + s.beats, 0);
  while (total > target) {
    const k = shots.reduce((best, s, i) => (s.beats - need[i] > shots[best].beats - need[best] ? i : best), 0);
    shots[k].beats--;
    total--;
  }
  // Short: the spare beats go round the shots after the hook, so no shot sits still too long.
  for (let k = 0; total < target; k++, total++) shots[shots.length > 1 ? 1 + (k % (shots.length - 1)) : 0].beats++;
  return true;
}

// Last resort after the director's retries: whatever would break the render or the
// 30 s is fixed here, and said in the run.
export function repairReel(spec: ReelSpec, run: Run, recentHooks: string[] = []): string[] {
  const done: string[] = [];
  const hook = hookOrder(run, recentHooks)[0] ?? 'photo_wall';
  const shots = spec.shots;
  const pick = <T extends string>(v: T, list: readonly T[], fallback: T) => (list.includes(v) ? v : fallback);
  const photos = run.photos.map((p) => p.id);
  shots.forEach((s, i) => {
    s.layout = pick(s.layout, LAYOUTS, 'type_only');
    s.text_in = pick(s.text_in, TEXT_IN, 'words');
    s.highlight = pick(s.highlight, HIGHLIGHTS, 'none');
    s.camera = pick(s.camera, CAMERAS, 'push_in');
    s.transition = pick(s.transition, TRANSITIONS, 'blur_crossfade');
    s.beats = Math.max(4, Math.round(s.beats || 6));
    s.photos = (s.photos ?? []).filter((p) => photos.includes(p)).slice(0, 5);
    s.items = (s.items ?? []).filter((x) => typeof x === 'string');
    if (s.layout === 'deck' && s.photos.length < 2) {
      s.layout = 'photo_window';
      s.photo = s.photos[0] ?? s.photo;
      done.push(`shot ${i + 1}: a deck needs two photos, it became a photo window`);
    }
    if (s.layout === 'deck') s.items = s.photos.map((_, k) => s.items![k] ?? '');
    if (s.layout === 'stack_list' && s.items.length < 2) {
      s.layout = 'type_only';
      done.push(`shot ${i + 1}: a stack needs two items, it became type only`);
    }
    if ((s.layout === 'product_drop' || s.layout === 'marquee') && !run.photos.find((p) => p.id === s.photo)?.cutout) {
      s.layout = i === 0 ? (hook === 'marquee' ? 'photo_full' : hook) : 'photo_window';
      done.push(`shot ${i + 1}: no cutout for it, it became a ${s.layout.replace('_', ' ')}`);
    }
    if (s.layout === 'grid' && s.photos.length < 2) {
      s.layout = 'photo_window';
      s.photo = s.photos[0] ?? s.photo;
      done.push(`shot ${i + 1}: a grid needs two photos, it became a photo window`);
    }
    if (NEEDS_PHOTO.has(s.layout) && !(s.photo && photos.includes(s.photo))) {
      if (photos.length) s.photo = photos[i % photos.length];
      else s.layout = 'type_only';
      done.push(`shot ${i + 1} had no valid photo`);
    }
    if (s.transition === 'panel' && i > 0 && s.layout !== 'type_only' && s.layout !== 'end_card') s.transition = 'band';
    if (i > 1 && s.transition === shots[i - 1].transition && s.transition !== 'cut') {
      s.transition = TRANSITIONS.find((t) => t !== shots[i - 1].transition && t !== 'panel' && t !== 'cut')!;
    }
    if (i === 0 && !HOOKS.has(s.layout) && photos.length) {
      s.layout = hook;
      if (hook === 'marquee' || hook === 'photo_full') s.photo = run.photos.find((p) => (hook === 'marquee' ? p.cutout : !p.backdrop))?.id ?? photos[0];
      done.push(`the hook became a ${hook.replace('_', ' ')}`);
    }
    if (s.emphasis && !words(s.text ?? '').some((w) => norm(w) === norm(s.emphasis!))) {
      s.emphasis = undefined;
      s.highlight = 'none';
    }
  });
  const last = shots[shots.length - 1];
  if (last && last.layout !== 'end_card') {
    last.layout = 'end_card';
    done.push('the last shot became the end card');
  }
  const target = REEL.seconds / REEL.beat;
  const total = shots.reduce((t, s) => t + s.beats, 0);
  if (last && total !== target) {
    // The end card absorbs the difference; if it would get too short, every shot shrinks a bit.
    last.beats += target - total;
    for (let i = 0; last.beats < 9 && i < shots.length * 4; i++) {
      const longest = shots.slice(0, -1).sort((a, b) => b.beats - a.beats)[0];
      if (!longest || longest.beats <= 5) break;
      longest.beats--;
      last.beats++;
    }
    done.push(`beats adjusted to ${target}`);
  }
  return done;
}

// What the reel critic may ask of one shot, as with the slides: settings the code
// applies before the next render, never a new shot list.
export const SHOT_ACTIONS = ['longer', 'bigger_text', 'smaller_text', 'another_photo', 'other_camera', 'simpler_scene', 'other_transition'] as const;
export type ShotAction = (typeof SHOT_ACTIONS)[number];

export function applyShotFixes(spec: ReelSpec, run: Run, fixes: { n: number; action: ShotAction }[]): string[] {
  const done: string[] = [];
  const used = () => new Set(spec.shots.flatMap((s) => [s.photo, ...(s.photos ?? [])]).filter(Boolean));
  for (const { n, action } of fixes) {
    const s = spec.shots[n - 1];
    if (!s) continue;
    const at = `shot ${n}`;
    const middle = n > 1 && n < spec.shots.length;
    if (action === 'longer') {
      s.beats += 2;
      done.push(`${at} stays longer`);
    } else if (action === 'bigger_text' || action === 'smaller_text') {
      const next = Math.min(1.3, Math.max(0.7, (s.textScale ?? 1) + (action === 'bigger_text' ? 0.15 : -0.15)));
      if (next !== (s.textScale ?? 1)) done.push(`${at} text ${action === 'bigger_text' ? 'bigger' : 'smaller'} (${Math.round(next * 100)}%)`);
      s.textScale = next;
    } else if (action === 'another_photo') {
      const cut = s.layout === 'product_drop' || s.layout === 'marquee';
      const pool = run.photos.filter((p) => !p.backdrop && (!cut || p.cutout)).map((p) => p.id);
      const taken = used();
      const next = pool.find((id) => !taken.has(id) && id !== s.photo) ?? pool.find((id) => id !== s.photo);
      if (next) {
        s.photo = next;
        if (s.photos?.length) s.photos = [next, ...s.photos.filter((id) => id !== next)].slice(0, 5);
        done.push(`${at} uses photo ${next}`);
      }
    } else if (action === 'other_camera') {
      // The calm moves first: a pan that loses the subject becomes a push.
      s.camera = s.camera === 'push_in' ? 'pull_out' : 'push_in';
      done.push(`${at} camera ${s.camera.replace('_', ' ')}`);
    } else if (action === 'simpler_scene' && middle && SCENES.has(s.layout)) {
      const photo = s.photo ?? s.photos?.[0];
      s.layout = photo ? 'photo_window' : 'type_only';
      s.photo = photo;
      done.push(`${at} becomes a ${s.layout.replace('_', ' ')}`);
    } else if (action === 'other_transition' && n > 1) {
      s.transition = s.transition === 'cut' ? 'blur_crossfade' : 'cut';
      done.push(`${at} enters with ${s.transition.replace('_', ' ')}`);
    }
  }
  return done;
}

// grid: the music's beat. Each cut moves to the nearest beat (half-time for fast
// tracks), keeping every shot at least 1.5 s.
function timeShots(spec: ReelSpec, grid?: { period: number; phase: number }): Timed[] {
  let t0 = 0;
  const planned = spec.shots.map((s) => {
    const start = t0;
    t0 += s.beats * REEL.beat;
    return start;
  });
  const step = grid ? (grid.period < 0.4 ? grid.period * 2 : grid.period) : 0;
  const starts: number[] = [];
  planned.forEach((st, i) => {
    if (!i || !grid) return starts.push(st);
    const snapped = grid.phase + Math.round((st - grid.phase) / step) * step;
    starts.push(Math.min(REEL.seconds - 3, Math.max(starts[i - 1] + 1.5, snapped)));
  });
  return spec.shots.map((s, i) => {
    const start = starts[i];
    const t = i + 1 < starts.length ? starts[i + 1] : REEL.seconds;
    const w = words(s.text);
    const delay: Record<string, number> = { photo_window: 0.5, end_card: 0.6, product_drop: 0.7, marquee: 0.5, deck: 0.15, grid: 0.15, stack_list: 0.15 };
    const textIn = i === 0 ? 0 : start + (delay[s.layout] ?? 0.2);
    const span = s.text_in === 'rise' ? 0.9 + 0.09 * (w.length - 1) : 0.42 + 0.07 * (w.length - 1) + (s.text_in === 'slam' ? 0.5 : 0);
    const textDone = i === 0 ? 0 : textIn + span;
    // Decks and stacks are read when the last card or slab has landed.
    const readAt = s.layout === 'deck' || s.layout === 'stack_list' || s.layout === 'grid' ? t - 0.4 : Math.min(t - 0.4, textDone + (s.highlight !== 'none' ? 0.9 : 0.4));
    return { ...s, start, end: t, textIn, textDone, readAt, words: w };
  });
}

// Where a photo lands when it covers the 1080x1920 frame around its focus.
type Placed = { file: string; left: number; top: number; width: number; height: number; ox: number; oy: number; zone: 'top' | 'bottom' };

async function placePhoto(file: string, focus: { x: number; y: number }, avoid: { x1: number; y1: number; x2: number; y2: number }[], box: { w: number; h: number } = { w: REEL.width, h: REEL.height }, contain = false): Promise<Placed> {
  const { width = 1, height = 1 } = await sharp(file).metadata();
  // A cutout stays whole inside the box; a photo covers it.
  const scale = contain ? Math.min(box.w / width, box.h / height) * 0.9 : Math.max(box.w / width, box.h / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const left = contain ? Math.round((box.w - w) / 2) : clamp(Math.round(box.w / 2 - focus.x * w), box.w - w, 0);
  const top = contain ? Math.round((box.h - h) / 2) : clamp(Math.round(box.h / 2 - focus.y * h), box.h - h, 0);
  // Text goes in the band (top or bottom third of the safe zone) that covers the fewest faces.
  const bands = { top: [REEL.safe.y1, 820], bottom: [930, REEL.safe.y2] } as const;
  const overlap = ([y1, y2]: readonly [number, number]) =>
    avoid.reduce((sum, b) => sum + Math.max(0, Math.min(y2, top + b.y2 * h) - Math.max(y1, top + b.y1 * h)) * (b.x2 - b.x1), 0);
  const zone = overlap(bands.top) < overlap(bands.bottom) ? 'top' : 'bottom';
  return { file, left, top, width: w, height: h, ox: Math.round(left + focus.x * w), oy: Math.round(top + focus.y * h), zone };
}

// "Poppins Bold" → Poppins 700, for the Google Fonts link and the CSS.
export function parseFont(name?: string): { family: string; weight: number } {
  const weights: Record<string, number> = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, book: 400, normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
  if (!name) return { family: 'Inter', weight: 700 };
  const parts = name.replace(/-/g, ' ').split(/\s+/);
  let weight = 400;
  const family: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase().replace(/[^a-z]/g, '');
    if (key in weights) weight = weights[key];
    else if (!['italic', 'oblique'].includes(key)) family.push(p);
  }
  return { family: family.join(' ') || 'Inter', weight };
}

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const chroma = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
};

// The carousel's visual system, read from the GIMP text layers and the brand colors.
export function readLook(run: Run, layers: LayerInfo[][]): Look {
  // The carousel's own system when there is one: the reel is the same brand.
  const sys = run.system;
  if (sys) {
    return {
      headFont: { family: sys.headingFont, weight: sys.headingWeight },
      bodyFont: { family: sys.bodyFont, weight: sys.bodyWeight },
      dark: sys.base,
      accent: sys.accent,
      ink: sys.ink,
      onAccent: sys.accentInk,
      align: sys.align,
      radius: sys.radius,
      loose: sys.products === 'loose',
      ground2: sys.ground === 'gradient' ? sys.ground2 : undefined,
      grain: sys.grain,
      tracking: sys.tracking,
      upper: sys.headlineCase === 'upper',
      button: sys.button,
    };
  }
  const texts = layers.flat().filter((l) => l.kind === 'text' && l.font);
  const biggest = [...texts].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
  const smallest = [...texts].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0];
  const colors = [...(run.brief.brandColors ?? []), ...texts.map((t) => t.color ?? '')].filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const accent = [...colors].sort((a, b) => chroma(b) - chroma(a))[0] ?? '#ffffff';
  const darkest = [...(run.brief.brandColors ?? [])].sort((a, b) => lum(a) - lum(b))[0];
  return {
    headFont: parseFont(biggest?.font),
    bodyFont: parseFont(smallest?.font ?? biggest?.font),
    dark: darkest && lum(darkest) < 0.3 ? darkest : '#0b0b0d',
    accent: chroma(accent) > 40 ? accent : '#ffffff',
    ink: '#f4f4f1',
  };
}

// Bold sans glyphs average about 0.6 em: the size shrinks until every line holds at
// least two words and the phrase takes at most three lines, so no word is left alone.
// Up to three words, or on a type-only poster, one big word per line is the look.
function fitSize(ws: string[], base: number, poster = false): number {
  const width = REEL.safe.x2 - REEL.safe.x1 - 40;
  const em = 0.6;
  const chars = ws.join(' ').length;
  const pairs = ws.slice(1).map((w, i) => `${ws[i]} ${w}`.length);
  const widestPair = ws.length > 3 && !poster ? Math.max(...pairs) : Math.max(1, ...ws.map((w) => w.length));
  return Math.round(Math.max(64, Math.min(base, width / (widestPair * em), ((poster ? 4 : 3) * width * 0.92) / (chars * em))));
}

const esc = (s: string) => s.replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' })[c]!);
const js = (v: unknown) => JSON.stringify(v);

// Writes the HyperFrames project of the reel: one root composition, every shot a
// layer of it, and the presets of the standard as GSAP on one timeline.
export async function writeReel(dir: string, run: Run, plan: Plan, spec: ReelSpec, look: Look, sound?: Sound): Promise<Timed[]> {
  const assets = path.join(dir, 'assets');
  await mkdir(assets, { recursive: true });
  const shots = timeShots(spec, sound?.music);
  const onAccent = look.onAccent ?? (lum(look.accent) > 0.5 ? '#0b0b0d' : '#ffffff');
  const R = look.radius ?? 24;
  const pillR = R >= 24 ? 999 : R;
  // The brand's ground: its gradient and grain, the same surface as the carousel.
  const groundImage = !!look.ground2 || !!look.grain;
  if (groundImage) {
    const g = look.ground2 ?? look.dark;
    const grain = look.grain ? `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="1200" height="2040" filter="url(#n)" opacity="0.12"/>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="2040"><defs><linearGradient id="l" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${look.dark}"/><stop offset="0.55" stop-color="${g}"/><stop offset="1" stop-color="${look.dark}"/></linearGradient><radialGradient id="b"><stop offset="0" stop-color="${g}" stop-opacity="0.7"/><stop offset="1" stop-color="${g}" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="2040" fill="url(#l)"/><ellipse cx="900" cy="500" rx="800" ry="700" fill="url(#b)"/>${grain}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(assets, 'ground.png'));
  }
  // Loose products float like on the brand's site: a studio shot loses its plain background.
  const free = async (p: Photo) => (look.loose && p.cutout && p.matte ? (run.photos.find((x) => x.id === `${p.id}k`) ?? (await keyOut(run, p).catch(() => undefined)) ?? p) : p);
  // Sound: the music bed and the effects, each placed where something happens.
  const cues: { kind: SfxKind; t: number; volume: number }[] = [];
  const cue = (kind: SfxKind, t: number, volume = 0.5) => {
    if (sound?.sfx[kind] && t >= 0 && t < REEL.seconds - 0.3) cues.push({ kind, t, volume });
  };
  const logoFor = (light: boolean) => (light ? run.logo : (run.logoLight ?? run.logo));
  for (const logo of [run.logo, run.logoLight]) if (logo) await copyFile(logo.path, path.join(assets, `logo-${logo.id}${path.extname(logo.path)}`));
  const logoSrc = (light: boolean) => {
    const logo = logoFor(light);
    return logo ? `assets/logo-${logo.id}${path.extname(logo.path)}` : '';
  };

  const html: string[] = [];
  const tl: string[] = [];
  const at = (t: number) => Math.max(0, t).toFixed(3);
  const copied = new Map<string, string>();
  const src = async (photo: Photo) => {
    if (!copied.has(photo.id)) {
      const rel = `assets/${photo.id}${path.extname(photo.path)}`;
      await copyFile(photo.path, path.join(dir, rel));
      copied.set(photo.id, rel);
    }
    return copied.get(photo.id)!;
  };
  // A product inside a box: a cutout fitted by its own pixels and centered, a photo covering it.
  const inBox = async (photo: Photo, w: number, h: number, fill = 0.82) => {
    const { width = 1, height = 1 } = await sharp(photo.path).metadata();
    if (!photo.cutout) return `<img src="${await src(photo)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />`;
    const c = photo.content ?? { x1: 0, y1: 0, x2: 1, y2: 1 };
    const s = Math.min((w * fill) / ((c.x2 - c.x1) * width), (h * fill) / ((c.y2 - c.y1) * height));
    const iw = Math.round(width * s);
    const ih = Math.round(height * s);
    return `<img src="${await src(photo)}" alt="" style="position:absolute;max-width:none;left:${Math.round(w / 2 - ((c.x1 + c.x2) / 2) * iw)}px;top:${Math.round(h / 2 - ((c.y1 + c.y2) / 2) * ih)}px;width:${iw}px;height:${ih}px" />`;
  };
  const carouselPhotos = plan.slides.map((p) => run.photos.find((x) => x.id === p.photo)).filter((p): p is Photo => !!p);
  // Always moving under everything: film grain, still for the closing hold.
  html.push('<div class="grain" id="grain"></div>');
  tl.push(`tl.fromTo("#grain", { x: 0, y: 0 }, { x: -160, y: -110, duration: ${REEL.seconds - 1.6}, ease: "steps(280)" }, 0);`);

  for (const [i, s] of shots.entries()) {
    const id = `s${i}`;
    const slide = plan.slides.find((p) => p.n === s.slide);
    const photo = s.photo ? run.photos.find((p) => p.id === s.photo) : undefined;
    let placed: Placed | undefined;
    if (photo && NEEDS_PHOTO.has(s.layout) && s.layout !== 'product_drop') {
      const ext = path.extname(photo.path);
      await copyFile(photo.path, path.join(assets, `${photo.id}${ext}`));
      const faces = slide?.photo === photo.id ? [...(slide.facesNorm ?? []), ...(slide.subjectNorm ? [slide.subjectNorm] : [])] : [];
      const focus = slide?.photo === photo.id && slide.subjectNorm
        ? { x: (slide.subjectNorm.x1 + slide.subjectNorm.x2) / 2, y: (slide.subjectNorm.y1 + slide.subjectNorm.y2) / 2 }
        : (slide?.focus ?? { x: 0.5, y: 0.5 });
      const box = s.layout === 'photo_window' || photo.cutout ? { w: 920, h: 820 } : undefined;
      placed = await placePhoto(photo.path, focus, faces, box, photo.cutout);
      placed.file = `assets/${photo.id}${ext}`;
    }
    const endStyle = spec.endStyle ?? 'accent';
    const ground = s.layout === 'end_card' && endStyle !== 'dark' ? look.accent : look.dark;
    if (i > 0 && s.transition !== 'cut' && s.transition !== 'panel') cue('whoosh', s.start - 0.32, 0.4);
    const ink = s.layout === 'end_card' && endStyle !== 'dark' ? onAccent : look.ink;
    // A cutout on photo_full is a catalog hero: the product whole on the brand ground, text under it.
    const hero = s.layout === 'photo_full' && !!photo?.cutout;
    const zone = hero || s.layout === 'photo_window' || s.layout === 'product_drop' || s.layout === 'marquee' ? 'under' : s.layout === 'photo_full' ? placed!.zone : s.layout === 'deck' || s.layout === 'stack_list' || s.layout === 'grid' ? 'top' : 'center';
    // Big type: small text in a big frame reads as the banned "void with small things".
    const short = s.words.length <= 4;
    const base = { photo_wall: short ? 132 : 112, marquee: short ? 120 : 100, product_drop: short ? 104 : 92, deck: 84, grid: 84, stack_list: 84, photo_full: short ? 128 : 108, photo_window: short ? 112 : 96, type_only: short ? 176 : 160, end_card: 104 }[s.layout];
    const size = Math.round(fitSize(s.words, base, s.layout === 'type_only') * (s.textScale ?? 1));
    const emphasis = s.emphasis ? norm(s.emphasis) : '';
    const wordHtml = s.words
      .map((w) => {
        const em = emphasis && norm(w) === emphasis;
        return `<span class="w${em ? ` em em-${s.highlight}` : ''}">${em && s.highlight !== 'none' && s.highlight !== 'color' ? '<span class="mk"></span>' : ''}<span class="wi">${esc(w)}</span></span>`;
      })
      .join(' ');

    // The first shot is visible from CSS: frame 0 is the thumbnail.
    html.push(`<div class="shot${s.layout === 'end_card' ? ` end-${spec.endStyle ?? 'accent'}` : ''}" id="${id}" style="z-index:${i + 1}${i === 0 ? ';visibility:visible;opacity:1' : ''}">`);
    if (s.layout !== 'photo_full' || hero) html.push(`  <div class="ground${groundImage && ground === look.dark ? ' img' : ''}" style="background-color:${ground}"></div>`);
    const len0 = s.end - s.start;
    if (s.layout === 'photo_wall') {
      // Every photo of the carousel on a tilted wall, rows drifting against each other.
      const pics = (s.photos?.length ? s.photos.map((id) => run.photos.find((p) => p.id === id)).filter((p): p is Photo => !!p) : carouselPhotos).filter((p) => !p.backdrop);
      const list = pics.length ? pics : carouselPhotos;
      const rows: string[] = [];
      for (let r = 0; r < 6; r++) {
        const tiles: string[] = [];
        for (let k = 0; k < 6; k++) {
          const p = list[(r * 2 + k) % list.length];
          tiles.push(`<div class="tile" style="background:${p.matte ?? (p.cutout ? '#f4f4f4' : look.dark)}">${await inBox(p, 560, 420, 0.86)}</div>`);
        }
        rows.push(`<div class="row r${r}" style="top:${r * 444}px">${tiles.join('')}</div>`);
      }
      // A calm brand gets a level wall, an energetic one a steep tilt.
      const tilt = { calm: 0, medium: -6, high: -12 }[spec.music?.energy ?? 'medium'] ?? -6;
      html.push(`  <div class="wall"><div class="plane" style="transform:rotate(${tilt}deg)">${rows.join('')}</div></div><div class="wall-shade" style="--d:${look.dark}"></div>`);
      const t0 = i === 0 ? 0 : s.start - 0.4;
      tl.push(`tl.fromTo(${js(`#${id} .wall`)}, { scale: 1.25 }, { scale: 1, duration: 1.4, ease: "power3.out" }, ${at(t0)});`);
      for (let r = 0; r < 6; r++) {
        const [a, b] = r % 2 ? [-420, 0] : [0, -420];
        tl.push(`tl.fromTo(${js(`#${id} .r${r}`)}, { x: ${a} }, { x: ${b}, duration: ${(len0 + 0.85).toFixed(3)}, ease: "none" }, ${at(t0)});`);
      }
    }
    if (s.layout === 'marquee' && photo) {
      // Rows of giant type drift against each other behind the floating product.
      const word = (s.emphasis ?? [...s.words].sort((a, b) => b.length - a.length)[0] ?? '').toUpperCase();
      const line = Array.from({ length: 6 }, () => esc(word)).join(' <span class="dot">•</span> ');
      const rows = Array.from({ length: 6 }, (_, r) => `<div class="mrow m${r}${r % 2 ? ' stroke' : ''}" style="top:${170 + r * 290}px;${r % 2 ? `-webkit-text-stroke-color:${look.accent}` : `color:${look.ink}`}">${line}</div>`);
      const p = await free(photo);
      const box = { x: 190, y: 470, w: 700, h: 640 };
      const card = !p.cutout || p.matte ? `background:${p.matte ?? '#f4f4f4'};border-radius:${R}px;` : '';
      html.push(`  <div class="marquee">${rows.join('')}</div><div class="stage"><div class="pshadow" style="top:1095px"></div><div class="prod" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;${card}">${await inBox(p, box.w, box.h, card ? 0.8 : 0.96)}</div></div>`);
      const t0 = i === 0 ? 0 : s.start - 0.4;
      for (let r = 0; r < 6; r++) {
        const [a, b] = r % 2 ? [-700, 0] : [0, -700];
        tl.push(`tl.fromTo(${js(`#${id} .m${r}`)}, { x: ${a} }, { x: ${b}, duration: ${(s.end - t0 + 0.45).toFixed(3)}, ease: "none" }, ${at(t0)});`);
      }
      if (i > 0) {
        tl.push(`tl.fromTo(${js(`#${id} .prod`)}, { scale: 0.6, rotation: -8 }, { scale: 1, rotation: 0, duration: 0.6, ease: "back.out(1.4)" }, ${at(s.start)});`);
        cue('pop', s.start + 0.1, 0.45);
      }
      const floatFrom = i === 0 ? 0 : s.start + 0.6;
      const floats = Math.max(0, Math.floor((s.end + 0.4 - floatFrom) / 1.4) - 1);
      tl.push(`tl.to(${js(`#${id} .prod`)}, { y: -16, rotation: 2, duration: 1.4, ease: "sine.inOut", yoyo: true, repeat: ${floats} }, ${at(floatFrom)});`);
    }
    if (s.layout === 'grid') {
      // The products land in a grid one by one, then the camera leans in.
      const tiles = (s.photos ?? []).map((pid) => run.photos.find((p) => p.id === pid)).filter((p): p is Photo => !!p).slice(0, 4);
      const spots = tiles.length === 2 ? [[80, 560, 440, 620], [560, 560, 440, 620]] : [[80, 520, 440, 440], [560, 520, 440, 440], [80, 1000, 440, 440], [560, 1000, 440, 440]];
      if (tiles.length === 3) spots[2] = [320, 1000, 440, 440];
      const cells: string[] = [];
      for (const [k, p0] of tiles.entries()) {
        const p = await free(p0);
        const [x, y, w, h] = spots[k];
        const bg = look.loose && p.cutout && !p.matte ? 'transparent' : (p.matte ?? (p.cutout ? '#f4f4f4' : look.dark));
        const label = s.items?.[k] ? `<div class="glabel" style="background:${look.accent};color:${onAccent};border-radius:${pillR}px">${esc(s.items[k])}</div>` : '';
        cells.push(`<div class="gcell g${k}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${bg};border-radius:${R}px">${await inBox(p, w, h, 0.84)}${label}</div>`);
      }
      html.push(`  <div class="gridw">${cells.join('')}</div>`);
      tiles.forEach((_, k) => {
        const t = s.start + 0.15 + k * 0.35;
        tl.push(`tl.fromTo(${js(`#${id} .g${k}`)}, { scale: 0.5, rotation: ${k % 2 ? 6 : -6}, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.5, ease: "back.out(1.7)" }, ${at(t)});`);
        cue('pop', t + 0.05, 0.4);
      });
      tl.push(`tl.fromTo(${js(`#${id} .gridw`)}, { scale: 1 }, { scale: 1.05, duration: ${(s.end - s.start + 0.45).toFixed(3)}, ease: "none" }, ${at(s.start)});`);
    }
    if (s.layout === 'product_drop' && photo) {
      // The product falls in, the frame takes the hit, a giant outlined word sits behind.
      const big = (s.emphasis ?? [...s.words].sort((a, b) => b.length - a.length)[0] ?? '').toUpperCase();
      // Wider than the frame, so it shows on both sides of the product's card.
      const bigSize = Math.round(Math.min(460, 1400 / (Math.max(1, big.length) * 0.62)));
      html.push(`  <div class="bigword" style="font-size:${bigSize}px;-webkit-text-stroke-color:${look.accent}">${esc(big)}</div>`);
      const p = await free(photo);
      const box = p.matte ? { x: 170, y: 380, w: 740, h: 700 } : { x: 110, y: 330, w: 860, h: 780 };
      const card = p.matte ? `background:${p.matte};border-radius:${R}px;` : '';
      const chips = (s.items ?? []).slice(0, 3);
      const spots = ['left:70px;top:360px', 'right:70px;top:650px', 'left:90px;top:960px'];
      html.push(
        `  <div class="stage"><div class="pshadow"></div><div class="prod" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;${card}">${await inBox(p, box.w, box.h, p.matte ? 0.8 : 0.96)}</div>` +
          chips.map((c, k) => `<div class="chip chip${k}" style="${spots[k]};background:${look.accent};color:${onAccent};border-radius:${pillR}px">${esc(c)}</div>`).join('') +
          '</div>',
      );
      const drop = s.start + (i === 0 ? 0 : 0.1);
      const land = drop + 0.45;
      tl.push(`tl.fromTo(${js(`#${id} .bigword`)}, { scale: 1.2, opacity: 0 }, { scale: 1, opacity: 0.55, duration: ${len0.toFixed(3)}, ease: "none" }, ${at(s.start - 0.3)});`);
      tl.push(`tl.fromTo(${js(`#${id} .prod`)}, { y: -1500, rotation: -12 }, { y: 0, rotation: 0, duration: 0.45, ease: "back.out(1.6)" }, ${at(drop)});`);
      tl.push(`tl.fromTo(${js(`#${id} .pshadow`)}, { scaleX: 0.4, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.3, ease: "power2.out" }, ${at(land - 0.05)});`);
      tl.push(`tl.to(${js(`#${id} .stage`)}, { keyframes: { y: [0, 10, -4, 0] }, duration: 0.25, ease: "none" }, ${at(land)});`);
      cue(sound?.sfx.impact ? 'impact' : 'thud', land, 0.6);
      const swayFrom = land + 0.3;
      const sways = Math.max(0, Math.floor((s.end + 0.4 - swayFrom) / 1.2) - 1);
      tl.push(`tl.to(${js(`#${id} .prod`)}, { rotation: 2.5, y: -10, duration: 1.2, ease: "sine.inOut", yoyo: true, repeat: ${sways} }, ${at(swayFrom)});`);
      chips.forEach((_, k) => {
        const pop = land + 0.15 + k * 0.4;
        tl.push(`tl.fromTo(${js(`#${id} .chip${k}`)}, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(2)" }, ${at(pop)});`);
        cue('pop', pop + 0.05, 0.4);
        const floats = Math.max(0, Math.floor((s.end + 0.4 - pop - 0.4) / 0.8) - 1);
        tl.push(`tl.to(${js(`#${id} .chip${k}`)}, { y: -14, duration: 0.8, ease: "sine.inOut", yoyo: true, repeat: ${floats} }, ${at(pop + 0.4)});`);
      });
    }
    if (s.layout === 'deck') {
      // Products dealt like cards from alternating sides; the earlier ones recede.
      const cards = (s.photos ?? []).map((id) => run.photos.find((p) => p.id === id)).filter((p): p is Photo => !!p);
      const cardHtml: string[] = [];
      for (const [k, p0] of cards.entries()) {
        const p = await free(p0);
        const loose = look.loose && p.cutout && !p.matte;
        cardHtml.push(`<div class="card card${k}${loose ? ' loose' : ''}" style="z-index:${k + 1};border-radius:${R}px;background:${loose ? 'transparent' : (p.matte ?? (p.cutout ? '#f4f4f4' : look.dark))}">${await inBox(p, 720, 800, 0.84)}<div class="cshade" style="background:${look.dark}"></div></div>`);
      }
      const labels = (s.items ?? []).map((t, k) => `<div class="label label${k}" style="font-family:'${look.bodyFont.family}',system-ui,sans-serif">${esc(t)}</div>`);
      html.push(`  <div class="deck">${cardHtml.join('')}</div><div class="labels" style="color:${look.ink}">${labels.join('')}</div>`);
      // The first card flies in while the shot enters, so the scene never opens empty.
      const first = s.start - 0.05;
      const gap = cards.length > 1 ? Math.min(1.1, Math.max(0.44, (s.end - 0.9 - first) / (cards.length - 1))) : 0;
      // Every step is a fromTo with its own start values: the render seeks frames in any order.
      // Loose products have no card to hide the one behind: the earlier ones step back and fade.
      const depth = look.loose
        ? [
            { card: { scale: 1, y: 0, opacity: 1 }, shade: 0 },
            { card: { scale: 0.86, y: -60, opacity: 0.18 }, shade: 0 },
            { card: { scale: 0.8, y: -90, opacity: 0 }, shade: 0 },
            { card: { scale: 0.8, y: -90, opacity: 0 }, shade: 0 },
          ]
        : [
            { card: { scale: 1, y: 0, opacity: 1 }, shade: 0 },
            { card: { scale: 0.94, y: -32, opacity: 1 }, shade: 0.4 },
            { card: { scale: 0.88, y: -64, opacity: 1 }, shade: 0.68 },
            { card: { scale: 0.88, y: -64, opacity: 0 }, shade: 0.68 },
          ];
      const later = 'immediateRender: false, ';
      cards.forEach((_, k) => {
        const t = first + k * gap;
        const side = k % 2 ? -1 : 1;
        tl.push(`tl.fromTo(${js(`#${id} .card${k}`)}, { x: ${side * 1300}, y: 40, rotation: ${side * 10} }, { x: 0, y: 0, rotation: ${side * 1.5}, duration: 0.55, ease: "expo.out" }, ${at(t)});`);
        if (k) cue('whoosh', t - 0.05, 0.3);
        for (let j = Math.max(0, k - 3); j < k; j++) {
          const d = k - j;
          tl.push(`tl.fromTo(${js(`#${id} .card${j}`)}, ${js(depth[d - 1].card)}, { ${later}...${js(depth[d].card)}, duration: 0.45, ease: "power2.out" }, ${at(t)});`);
          tl.push(`tl.fromTo(${js(`#${id} .card${j} .cshade`)}, { opacity: ${depth[d - 1].shade} }, { ${later}opacity: ${depth[d].shade}, duration: 0.45, ease: "power2.out" }, ${at(t)});`);
        }
        if (s.items?.[k]) tl.push(`tl.fromTo(${js(`#${id} .label${k}`)}, { y: 84 }, { ${later}y: 0, duration: 0.4, ease: "power3.out" }, ${at(t + 0.1)});`);
        if (k >= 1 && s.items?.[k - 1]) tl.push(`tl.fromTo(${js(`#${id} .label${k - 1}`)}, { y: 0 }, { ${later}y: -84, duration: 0.3, ease: "power3.in" }, ${at(t)});`);
      });
      tl.push(`tl.fromTo(${js(`#${id} .deck`)}, { scale: 1 }, { scale: 1.04, duration: ${(len0 + 0.85).toFixed(3)}, ease: "none" }, ${at(s.start - 0.4)});`);
    }
    if (s.layout === 'stack_list') {
      // The points land as slabs, one per beat; the frame takes each hit.
      const items = s.items ?? [];
      const slabH = 150;
      const top0 = Math.round(600 + (840 - (items.length * slabH + (items.length - 1) * 24)) / 2);
      const slabs = items.map((t, k) => {
        const fill = k % 2 === 0;
        const fs = Math.round(Math.min(72, 820 / (Math.max(8, t.length) * 0.56)));
        return `<div class="slab slab${k}" style="border-radius:${R}px;top:${top0 + k * (slabH + 24)}px;font-size:${fs}px;${fill ? `background:${look.accent};color:${onAccent}` : `border:5px solid ${look.ink};color:${look.ink}`}">${esc(t)}</div>`;
      });
      html.push(`  <div class="stage">${slabs.join('')}</div>`);
      items.forEach((_, k) => {
        const landAt = s.start + 0.7 + k * 0.5;
        tl.push(`tl.fromTo(${js(`#${id} .slab${k}`)}, { y: -1500, rotation: ${k % 2 ? 3 : -3} }, { y: 0, rotation: 0, duration: 0.32, ease: "power3.in" }, ${at(landAt - 0.32)});`);
        tl.push(`tl.to(${js(`#${id} .stage`)}, { keyframes: { y: [0, 10, -4, 0] }, duration: 0.25, ease: "none" }, ${at(landAt)});`);
        cue('thud', landAt, 0.5);
        for (let j = 0; j < k; j++) tl.push(`tl.to(${js(`#${id} .slab${j}`)}, { keyframes: { scaleY: [1, 0.9, 1.03, 1] }, duration: 0.25, ease: "none" }, ${at(landAt)});`);
      });
    }
    if (hero && placed) {
      html.push(`  <div class="hero"${photo?.matte ? ` style="background:${photo.matte}"` : ''}><img class="cam" src="${placed.file}" alt="" style="left:${placed.left}px;top:${placed.top}px;width:${placed.width}px;height:${placed.height}px" /></div>`);
    } else if (s.layout === 'photo_full' && placed) {
      html.push(`  <div class="photo"><img class="cam${photo?.backdrop ? ' soft' : ''}" src="${placed.file}" alt="" style="left:${placed.left}px;top:${placed.top}px;width:${placed.width}px;height:${placed.height}px;transform-origin:${placed.ox - placed.left}px ${placed.oy - placed.top}px" /></div>`);
      if (photo?.backdrop) html.push(`  <div class="shade" style="background:${look.dark}"></div>`);
      html.push(`  <div class="scrim scrim-${placed.zone}" style="--d:${look.dark}"></div>`);
    }
    if (s.layout === 'photo_window' && placed) {
      html.push(`  <div class="window"><div class="outline" style="border-color:${look.accent}"></div><div class="clip"${photo?.matte ? ` style="background:${photo.matte}"` : ''}><img class="cam" src="${placed.file}" alt="" style="left:${placed.left}px;top:${placed.top}px;width:${placed.width}px;height:${placed.height}px" />${photo?.backdrop ? `<div class="shade" style="background:${look.dark}"></div>` : ''}</div></div>`);
    }
    if (s.layout === 'end_card') {
      const src = logoSrc(lum(ground) > 0.5);
      if (src) html.push(`  <div class="ring" style="border-color:${ink}"></div><img class="logo" src="${src}" alt="logo" />`);
    }
    if (i === 0 && s.layout === 'photo_full' && placed?.zone === 'bottom' && logoSrc(false)) {
      html.push(`  <img class="mini-logo" src="${logoSrc(false)}" alt="logo" />`);
    }
    html.push(`  <div class="text zone-${zone}" style="color:${ink};font-size:${size}px;--accent:${look.accent};--on-accent:${onAccent}">${s.layout === 'type_only' ? `<div class="rule" style="background:${look.accent}"></div>` : ''}${wordHtml}</div>`);
    if (s.layout === 'end_card' && s.button) {
      const pill = spec.endStyle === 'dark' ? `background:${look.accent};color:${onAccent}` : look.button === 'outline' ? `border:5px solid ${onAccent};color:${onAccent};background:transparent` : `background:${onAccent};color:${ground}`;
      html.push(`  <div class="pill" style="border-radius:${pillR}px;${pill}">${esc(s.button)}</div>`);
    }
    html.push('</div>');

    const sel = (x: string) => js(`#${id} ${x}`);
    const me = js(`#${id}`);
    const len = s.end - s.start;

    // Entrance of the shot (the first one is already on screen: it is the thumbnail).
    if (i > 0) {
      const prev = js(`#s${i - 1}`);
      const T = s.start;
      switch (s.transition) {
        case 'carry': {
          // An accent bar grows into a panel that carries the cut, then wipes up to reveal the shot.
          html.push(`<div class="band" id="carry${i}" style="background:${look.accent}"></div>`);
          const c = js(`#carry${i}`);
          tl.push(`tl.set(${c}, { autoAlpha: 1 }, ${at(T - 0.65)});`);
          tl.push(`tl.fromTo(${c}, { clipPath: "inset(49.74% 50% 49.74% 50%)" }, { clipPath: "inset(49.74% 42.6% 49.74% 42.6%)", duration: 0.15, ease: "power2.out" }, ${at(T - 0.65)});`);
          tl.push(`tl.to(${c}, { clipPath: "inset(49.74% 0% 49.74% 0%)", duration: 0.22, ease: "expo.inOut" }, ${at(T - 0.5)});`);
          tl.push(`tl.to(${c}, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.28, ease: "expo.inOut" }, ${at(T - 0.28)});`);
          tl.push(`tl.set(${me}, { autoAlpha: 1 }, ${at(T)});`);
          tl.push(`tl.to(${c}, { clipPath: "inset(0% 0% 100% 0%)", duration: 0.4, ease: "power3.inOut" }, ${at(T)});`);
          tl.push(`tl.set(${c}, { autoAlpha: 0 }, ${at(T + 0.42)});`);
          break;
        }
        case 'iris':
          tl.push(`tl.set(${me}, { autoAlpha: 1 }, ${at(T - 0.38)});`);
          tl.push(`tl.fromTo(${me}, { clipPath: "circle(0px at 50% 50%)" }, { clipPath: "circle(1700px at 50% 50%)", duration: 0.38, ease: "power3.in" }, ${at(T - 0.38)});`);
          tl.push(`tl.set(${me}, { clipPath: "none" }, ${at(T + 0.02)});`);
          break;
        case 'zoom_through':
          tl.push(`tl.to(${prev}, { scale: 2.4, opacity: 0, filter: "blur(10px)", duration: 0.32, ease: "power3.in" }, ${at(T - 0.32)});`);
          tl.push(`tl.fromTo(${me}, { autoAlpha: 0, scale: 0.62, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.38, ease: "power3.out" }, ${at(T - 0.18)});`);
          break;
        case 'whip':
          tl.push(`tl.to(${prev}, { x: -320, skewX: -8, opacity: 0, filter: "blur(16px)", duration: 0.3, ease: "power3.in" }, ${at(T - 0.3)});`);
          tl.push(`tl.fromTo(${me}, { autoAlpha: 0, x: 320, skewX: 8, filter: "blur(16px)" }, { autoAlpha: 1, x: 0, skewX: 0, filter: "blur(0px)", duration: 0.36, ease: "power3.out" }, ${at(T - 0.18)});`);
          break;
        case 'clip_wipe':
          tl.push(`tl.set(${me}, { autoAlpha: 1 }, ${at(T - 0.4)});`);
          tl.push(`tl.fromTo(${me}, { clipPath: "inset(0% 0% 0% 100%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.8, ease: "expo.inOut" }, ${at(T - 0.4)});`);
          tl.push(`tl.fromTo(${js(`#bar${i}`)}, { x: ${REEL.width}, autoAlpha: 1 }, { x: -6, duration: 0.8, ease: "expo.inOut" }, ${at(T - 0.4)});`);
          tl.push(`tl.set(${js(`#bar${i}`)}, { autoAlpha: 0 }, ${at(T + 0.42)});`);
          tl.push(`tl.to(${prev}, { x: -70, opacity: 0.5, duration: 0.6, ease: "power2.in" }, ${at(T - 0.3)});`);
          html.push(`<div class="bar" id="bar${i}" style="background:${look.accent}"></div>`);
          break;
        case 'band':
        case 'panel': {
          const color = s.transition === 'panel' ? ground : look.accent;
          html.push(`<div class="band" id="band${i}" style="background:${color}"></div>`);
          if (s.transition === 'band') {
            tl.push(`tl.fromTo(${js(`#band${i}`)}, { yPercent: 100, autoAlpha: 1 }, { yPercent: -100, duration: 0.75, ease: "power3.inOut" }, ${at(T - 0.35)});`);
            tl.push(`tl.set(${js(`#band${i}`)}, { autoAlpha: 0 }, ${at(T + 0.42)});`);
          } else {
            tl.push(`tl.fromTo(${js(`#band${i}`)}, { yPercent: 100, autoAlpha: 1 }, { yPercent: 0, duration: 0.45, ease: "power3.inOut" }, ${at(T - 0.45)});`);
            tl.push(`tl.set(${js(`#band${i}`)}, { autoAlpha: 0 }, ${at(T + 0.02)});`);
          }
          tl.push(`tl.set(${me}, { autoAlpha: 1 }, ${at(T)});`);
          break;
        }
        case 'blur_crossfade':
          tl.push(`tl.to(${prev}, { opacity: 0, scale: 1.04, filter: "blur(14px)", duration: 0.5, ease: "power2.inOut" }, ${at(T - 0.25)});`);
          tl.push(`tl.fromTo(${me}, { autoAlpha: 0, scale: 0.97, filter: "blur(14px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.55, ease: "power2.out" }, ${at(T - 0.25)});`);
          break;
        default:
          tl.push(`tl.set(${me}, { autoAlpha: 1 }, ${at(T)});`);
      }
      tl.push(`tl.set(${prev}, { autoAlpha: 0 }, ${at(T + 0.45)});`);
    }

    // Camera: always moving, linear for the whole shot; the hook zooms in and settles.
    const camFrom = s.start - (i === 0 ? 0 : 0.4);
    const camLen = len + (i === 0 ? 0 : 0.4) + 0.45;
    if (placed) {
      if (i === 0) {
        tl.push(`tl.fromTo(${sel('.cam')}, { scale: 1.32 }, { scale: 1.06, duration: 0.8, ease: "expo.out" }, 0.05);`);
        tl.push(`tl.to(${sel('.cam')}, { scale: 1.16, duration: ${(camLen - 0.85).toFixed(3)}, ease: "none" }, 0.85);`);
      } else {
        const moves: Record<Shot['camera'], [Record<string, number>, Record<string, number>]> = {
          push_in: [{ scale: 1 }, { scale: 1.12 }],
          pull_out: [{ scale: 1.14 }, { scale: 1 }],
          pan_left: [{ scale: 1.1, x: 40 }, { scale: 1.1, x: -40 }],
          pan_right: [{ scale: 1.1, x: -40 }, { scale: 1.1, x: 40 }],
        };
        const [from, to] = moves[s.camera] ?? moves.push_in;
        tl.push(`tl.fromTo(${sel('.cam')}, ${js(from)}, { ...${js(to)}, duration: ${camLen.toFixed(3)}, ease: "none" }, ${at(camFrom)});`);
      }
    }
    if (s.layout !== 'photo_full' || hero) {
      tl.push(`tl.fromTo(${sel('.ground')}, { scale: 1 }, { scale: 1.06, duration: ${camLen.toFixed(3)}, ease: "none" }, ${at(camFrom)});`);
    }
    if (s.layout === 'type_only') {
      tl.push(`tl.fromTo(${sel('.rule')}, { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.out" }, ${at(s.start + 0.1)});`);
    }
    if (s.layout === 'photo_window') {
      tl.push(`tl.fromTo(${sel('.clip')}, { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 1.1, ease: "expo.out" }, ${at(s.start)});`);
      tl.push(`tl.fromTo(${sel('.outline')}, { x: -26, y: 26, opacity: 0 }, { x: 0, y: 0, opacity: 1, duration: 1.0, ease: "power3.out" }, ${at(s.start + 0.15)});`);
    }
    if (s.layout === 'end_card') {
      cue(sound?.sfx.impact ? 'impact' : 'thud', s.start + 0.2, 0.65);
      if (sound?.sfx.riser) cues.push({ kind: 'riser', t: -1, volume: 0.35 });
      tl.push(`tl.fromTo(${sel('.logo')}, { opacity: 0, scale: 1.35, filter: "blur(12px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.5, ease: "expo.out" }, ${at(s.start + 0.2)});`);
      tl.push(`tl.fromTo(${sel('.ring')}, { opacity: 0.85, scale: 0.6 }, { opacity: 0, scale: 3.4, duration: 0.8, ease: "power2.out" }, ${at(s.start + 0.2)});`);
      if (s.button) {
        tl.push(`tl.fromTo(${sel('.pill')}, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2)" }, ${at(s.textDone + 0.15)});`);
        tl.push(`tl.to(${sel('.pill')}, { keyframes: { scale: [1, 1.06, 1] }, duration: 0.5, ease: "sine.inOut" }, ${at(s.textDone + 0.9)});`);
      }
    }

    // Text: the first shot's headline is on screen at frame 0; the others build word by word.
    if (i > 0) {
      const ws = sel('.wi');
      if (s.text_in === 'rise') {
        tl.push(`tl.fromTo(${ws}, { yPercent: 110 }, { yPercent: 0, duration: 0.9, ease: "power4.out", stagger: 0.09 }, ${at(s.textIn)});`);
      } else {
        const target = s.text_in === 'slam' && emphasis ? sel('.w:not(.em) .wi') : ws;
        tl.push(`tl.fromTo(${target}, { yPercent: 60, opacity: 0, filter: "blur(8px)" }, { yPercent: 0, opacity: 1, filter: "blur(0px)", duration: 0.42, ease: "power3.out", stagger: 0.07 }, ${at(s.textIn)});`);
        if (s.text_in === 'slam' && emphasis) {
          tl.push(`tl.fromTo(${sel('.em .wi')}, { scale: 1.55, opacity: 0, filter: "blur(14px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.42, ease: "expo.out" }, ${at(s.textDone - 0.42)});`);
        }
      }
    }
    if (emphasis && (s.highlight === 'marker' || s.highlight === 'underline')) {
      // On the thumbnail the marker is already there, or the word would not read.
      if (i > 0) tl.push(`tl.fromTo(${sel('.mk')}, { scaleX: 0 }, { scaleX: 1, duration: 0.45, ease: "power2.out" }, ${at(s.textDone + 0.28)});`);
    }
  }

  // Audio: the bed for the whole reel, then every effect on its own track.
  const audio: string[] = [];
  if (sound?.music) {
    await copyFile(sound.music.file, path.join(assets, 'music.mp3'));
    audio.push(`<audio id="music" class="clip" src="assets/music.mp3" data-start="0" data-duration="${REEL.seconds}" data-volume="0.55" data-track-index="1"></audio>`);
  }
  const lengths = new Map<SfxKind, number>();
  for (const [kind, file] of Object.entries(sound?.sfx ?? {}) as [SfxKind, string][]) {
    await copyFile(file, path.join(assets, `sfx-${kind}.mp3`));
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).catch(() => ({ stdout: '1' }));
    lengths.set(kind, Number(stdout) || 1);
  }
  const endCard = shots.find((s) => s.layout === 'end_card');
  cues.forEach((c, k) => {
    // The riser crests on the end card.
    const len = Math.min(lengths.get(c.kind) ?? 1, c.kind === 'riser' ? 6 : 2.5);
    const t = c.kind === 'riser' ? Math.max(0, (endCard?.start ?? REEL.seconds) - len) : c.t;
    const dur = Math.min(len, REEL.seconds - 1.5 - t);
    if (dur > 0.1) audio.push(`<audio id="fx${k}" class="clip" src="assets/sfx-${c.kind}.mp3" data-start="${t.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-volume="${c.volume}" data-track-index="${2 + (k % 4)}"></audio>`);
  });
  html.push(...audio);

  const fonts = [...new Map([look.headFont, look.bodyFont].map((f) => [`${f.family}:${f.weight}`, f])).values()];
  const families = [...new Set(fonts.map((f) => f.family))]
    .map((family) => `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${[...new Set(fonts.filter((f) => f.family === family).map((f) => f.weight))].sort().join(';')}`)
    .join('&');

  const page = `<!doctype html>
<html lang="${esc(run.brief.language?.slice(0, 2).toLowerCase() || 'en')}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${REEL.width}, height=${REEL.height}" />
    <title>Reel</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families}&display=block" />
    <script src="${GSAP}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${REEL.width}px; height: ${REEL.height}px; overflow: hidden; background: ${look.dark}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${look.dark}; }
      .shot { position: absolute; inset: 0; overflow: hidden; visibility: hidden; opacity: 0; will-change: transform, opacity, filter; }
      .ground { position: absolute; inset: -60px; --g1: color-mix(in srgb, ${look.ink} 7.5%, transparent); --g2: color-mix(in srgb, ${look.ink} 3.5%, transparent); background-image:
        linear-gradient(var(--g1) 1px, transparent 1px), linear-gradient(90deg, var(--g1) 1px, transparent 1px),
        linear-gradient(var(--g2) 1px, transparent 1px), linear-gradient(90deg, var(--g2) 1px, transparent 1px);
        background-size: 270px 270px, 270px 270px, 90px 90px, 90px 90px; }
      .ground::after { content: ""; position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 45%, transparent 40%, rgba(0,0,0,${lum(look.dark) > 0.5 ? '.12' : '.45'})); }
      .photo, .clip { position: absolute; overflow: hidden; }
      .photo { inset: 0; }
      .cam { position: absolute; max-width: none; will-change: transform; }
      .shade { position: absolute; inset: 0; opacity: .62; }
      .soft { filter: blur(10px); }
      .photo .soft + .shade { opacity: .7; }
      .scrim { position: absolute; left: 0; right: 0; height: 62%; }
      .scrim-bottom { bottom: 0; background: linear-gradient(to top, var(--d) 0%, color-mix(in srgb, var(--d) 70%, transparent) 45%, transparent 100%); }
      .scrim-top { top: 0; background: linear-gradient(to bottom, var(--d) 0%, color-mix(in srgb, var(--d) 70%, transparent) 45%, transparent 100%); }
      .hero { position: absolute; left: 80px; top: 290px; width: 920px; height: 820px; border-radius: 24px; overflow: hidden; }
      .window { position: absolute; left: 80px; top: 290px; width: 920px; height: 820px; }
      .window .clip { inset: 0; border-radius: 10px; }
      .outline { position: absolute; inset: 0; transform: translate(26px, 26px); border: 4px solid; border-radius: 10px; }
      .ground.img { background-image: url(assets/ground.png); background-size: cover; background-position: center; }
      .ground.img::after { display: none; }
      .marquee { position: absolute; inset: 0; overflow: hidden; }
      .mrow { position: absolute; left: -200px; white-space: nowrap; font-size: 210px; line-height: 1; opacity: .16; letter-spacing: -0.02em;
        font-family: "${look.headFont.family}", system-ui, sans-serif; font-weight: ${look.headFont.weight}; }
      .mrow.stroke { color: transparent; -webkit-text-stroke-width: 4px; opacity: .5; }
      .mrow .dot { font-size: .5em; vertical-align: middle; }
      .gridw { position: absolute; inset: 0; transform-origin: 50% 55%; }
      .gcell { position: absolute; overflow: hidden; }
      .glabel { position: absolute; left: 20px; bottom: 20px; padding: 10px 22px; font-size: 32px; font-weight: 700; white-space: nowrap;
        font-family: "${look.bodyFont.family}", system-ui, sans-serif; }
      .card.loose { box-shadow: none; overflow: visible; }
      .card.loose img { filter: drop-shadow(0 30px 40px rgba(0,0,0,.28)); }
      .card.loose .cshade { display: none; }
      .text { position: absolute; text-wrap: balance; left: ${REEL.safe.x1}px; width: ${REEL.safe.x2 - REEL.safe.x1}px; text-align: ${look.align === 'left' ? 'left' : 'center'}; line-height: 1.05; letter-spacing: ${look.tracking ?? -0.02}em;${look.upper ? ' text-transform: uppercase;' : ''}
        font-family: "${look.headFont.family}", system-ui, sans-serif; font-weight: ${look.headFont.weight}; }
      .zone-top { top: 330px; }
      .zone-bottom { bottom: ${REEL.height - REEL.safe.y2 + 20}px; }
      .zone-under { top: 1170px; }
      .zone-center { top: 50%; transform: translateY(-50%); }
      .shot:has(.logo) .zone-center { top: 1010px; transform: none; }
      .w { display: inline-block; position: relative; overflow: hidden; padding: 0.04em 0.06em 0.1em; vertical-align: top; }
      .wi { display: inline-block; position: relative; }
      .em-color .wi { color: var(--accent); }
      .em-marker .wi { color: var(--on-accent); }
      .mk { position: absolute; left: 0; right: 0; top: 0.08em; bottom: 0.06em; background: var(--accent); transform-origin: 0 50%; }
      .em-underline .mk { top: auto; height: 8px; bottom: 0.02em; }
      .logo { position: absolute; left: 50%; top: 560px; width: 340px; margin-left: -170px; }
      .ring { position: absolute; left: 50%; top: 560px; width: 340px; height: 340px; margin-left: -170px; border: 6px solid; border-radius: 50%; opacity: 0; }
      .end-low .logo, .end-low .ring { top: 1080px; }
      .shot.end-low .zone-center { top: 420px; transform: none; }
      .mini-logo { position: absolute; left: 50%; top: 300px; width: 170px; margin-left: -85px; }
      .pill { position: absolute; left: 50%; top: 1330px; transform: translateX(-50%); padding: 26px 54px; border-radius: 999px; white-space: nowrap;
        font-family: "${look.bodyFont.family}", system-ui, sans-serif; font-weight: 700; font-size: 54px; }
      .rule { width: 160px; height: 10px; margin: 0 auto 48px; }
      .bar { position: absolute; top: 0; left: 0; width: 6px; height: 100%; z-index: 90; visibility: hidden; opacity: 0; }
      .band { position: absolute; inset: 0; z-index: 95; visibility: hidden; opacity: 0; }
      .grain { position: absolute; inset: -200px; z-index: 200; pointer-events: none; opacity: .07; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
      .wall { position: absolute; inset: 0; }
      .plane { position: absolute; left: -1260px; top: -390px; width: 3600px; height: 2700px; }
      .row { position: absolute; left: 0; display: flex; gap: 24px; }
      .tile { position: relative; flex: none; width: 560px; height: 420px; border-radius: ${Math.min(R, 28)}px; overflow: hidden; }
      .wall-shade { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 52%, color-mix(in srgb, var(--d) 82%, transparent) 0%, color-mix(in srgb, var(--d) 55%, transparent) 55%, color-mix(in srgb, var(--d) 30%, transparent) 100%); }
      .bigword { position: absolute; left: -200px; right: -200px; top: 520px; text-align: center; color: transparent; -webkit-text-stroke-width: 6px; line-height: 1; white-space: nowrap;
        font-family: "${look.headFont.family}", system-ui, sans-serif; font-weight: ${look.headFont.weight}; }
      .stage { position: absolute; inset: 0; }
      .prod { position: absolute; overflow: hidden; }
      .pshadow { position: absolute; left: 240px; width: 600px; top: 1080px; height: 60px; border-radius: 50%; background: radial-gradient(ellipse, rgba(0,0,0,.55), transparent 70%); }
      .chip { position: absolute; padding: 18px 32px; border-radius: 999px; font-size: 40px; font-weight: 700; white-space: nowrap; z-index: 3;
        font-family: "${look.bodyFont.family}", system-ui, sans-serif; }
      .deck { position: absolute; left: 180px; top: 560px; width: 720px; height: 800px; }
      .card { position: absolute; inset: 0; border-radius: 28px; overflow: hidden; box-shadow: 0 30px 60px rgba(0,0,0,.35); }
      .cshade { position: absolute; inset: 0; opacity: 0; }
      .labels { position: absolute; left: 80px; right: 80px; top: 1385px; height: 84px; overflow: hidden; }
      .label { position: absolute; inset: 0; text-align: ${look.align === 'left' ? 'left' : 'center'}; font-size: 60px; font-weight: 700; line-height: 84px; white-space: nowrap; transform: translateY(84px); }
      .slab { position: absolute; left: 100px; width: 880px; height: 150px; border-radius: 22px; display: flex; align-items: center; justify-content: center; transform-origin: 50% 100%;
        font-family: "${look.headFont.family}", system-ui, sans-serif; font-weight: ${look.headFont.weight}; text-transform: uppercase; letter-spacing: -0.01em; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="reel" data-start="0" data-duration="${REEL.seconds}" data-width="${REEL.width}" data-height="${REEL.height}">
${html.map((l) => `      ${l}`).join('\n')}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      ${tl.join('\n      ')}
      // Holds the last frame still until the end.
      tl.set({}, {}, ${REEL.seconds});
      window.__timelines["reel"] = tl;
    </script>
  </body>
</html>
`;
  await writeFile(path.join(dir, 'index.html'), page);
  await writeFile(path.join(dir, 'hyperframes.json'), JSON.stringify({ paths: { assets: 'assets' } }, null, 2));
  return shots;
}

export async function renderReel(dir: string, output: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await exec('npx', ['--yes', `hyperframes@${config.hyperframesVersion}`, 'render', '.', '--fps', '30', '--quality', 'delivery', '--output', output, '--quiet'], {
    cwd: dir,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
}

// Frames for the critic at the thumbnail, every shot's reading point and the end,
// plus what the code measures: the length and whether the ending is still.
export async function inspectReel(video: string, shots: Timed[], outDir: string) {
  await mkdir(outDir, { recursive: true });
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]);
  const duration = Number(stdout.trim());
  const grab = async (t: number, name: string) => {
    const file = path.join(outDir, `${name}.jpg`);
    await exec('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', file]);
    return { t, file, label: name };
  };
  const frames = [await grab(0, 'thumbnail')];
  for (const [i, s] of shots.entries()) frames.push(await grab(i === 0 ? 1.2 : s.readAt, `shot-${i + 1}`));
  const end1 = await grab(duration - 1.5, 'end-hold-start');
  const end2 = await grab(duration - 0.1, 'end');
  frames.push(end2);
  const stillEnd = await difference(end1.file, end2.file);
  return { frames, duration, stillEnd };
}

async function difference(a: string, b: string): Promise<number> {
  const [x, y] = await Promise.all([a, b].map(async (f) => sharp(await readFile(f)).removeAlpha().resize(180, 320, { fit: 'fill' }).raw().toBuffer()));
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length / 255;
}

// SPEC.md and REVIEW.md, the two documents every piece of the agency carries.
export async function writeReelDocs(
  dir: string,
  plan: Plan,
  shots: Timed[],
  look: Look,
  review: { approved: boolean; score: number; checks: Record<string, { answer: string; note?: string }>; fixes: string[] },
  measured: { duration: number; stillEnd: number },
  notes: string,
  music?: string,
): Promise<void> {
  const t = (n: number) => n.toFixed(2);
  const spec = `# SPEC — ${plan.concept} (reel, 30 s)

GOAL:    ${plan.why}

OUTPUT:  HyperFrames 1080x1920, 30 fps, H.264. Safe zone x 80–1000, y 280–1470.

AUDIO:   ${music ? `Music ${music}; cuts on its beat. Effects from Mixkit (free license).` : 'Silent: no music was found.'}

TIME:    30 s = 900 frames, beat grid 0.5 s. ${shots.length} shots.

LOOK:    Headlines ${look.headFont.family} ${look.headFont.weight}, details ${look.bodyFont.family} ${look.bodyFont.weight}. Ground ${look.dark}, accent ${look.accent}, ink ${look.ink}. Same photos and logo as the carousel.

SHOTS:
${shots.map((s, i) => `  ${i + 1}. ${t(s.start)}–${t(s.end)} · ${s.layout}${s.photo ? ` (${s.photo})` : ''} · "${s.text}"${s.emphasis ? ` [${s.emphasis}: ${s.highlight}]` : ''} · text ${i === 0 ? 'on screen at frame 0' : s.text_in} · camera ${s.camera}${i ? ` · enters with ${s.transition}` : ''}${s.button ? ` · button "${s.button}"` : ''}${s.items?.length ? ` · items: ${s.items.join(' | ')}` : ''}${s.photos?.length ? ` · photos ${s.photos.join(', ')}` : ''}`).join('\n')}

BANNED:  continuous pan through the slides, fade + slide-up on everything, the same transition twice in a row, text moving while it is read, logo in a corner, glow, particles, emoji.

QA:      0.00 (thumbnail), ${shots.map((s, i) => t(i === 0 ? 1.2 : s.readAt)).join(', ')}, ${t(measured.duration - 0.1)} (end).
`;
  const lines = Object.entries(review.checks).map(([k, v]) => `- ${k}: ${v.answer}${v.note ? ` — ${v.note}` : ''}`);
  const reviewDoc = `# REVIEW — ${plan.concept} (reel, 30 s)

## Decisions

${notes || '(none)'}

## Measured

- Length: ${t(measured.duration)} s (target 30.00).
- Still ending: difference between ${t(measured.duration - 1.5)} s and the last frame ${measured.stillEnd.toFixed(3)} (0 = still).

## Critic (${review.approved ? 'approved' : 'not approved'}, ${review.score}/10)

${lines.join('\n')}

## Weak / pending

${review.fixes.length ? review.fixes.map((f) => `- ${f}`).join('\n') : '- Nothing flagged.'}
- ${music ? `Music: ${music}. The owner can still swap it for trending audio in Instagram or Facebook.` : 'Silent: the owner adds trending audio in Instagram or Facebook.'}
`;
  await writeFile(path.join(dir, 'SPEC.md'), spec);
  await writeFile(path.join(dir, 'REVIEW.md'), reviewDoc);
}

export type { Timed };
