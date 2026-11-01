import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Free music: Mixkit's stock music first (data/music.json, built by
// scripts/build-music-catalog.mjs; free for commercial use, no attribution), then
// Openverse (api.openverse.org: Freesound, Jamendo, Wikimedia; no key), only licenses
// that allow commercial use with no conditions beyond credit: CC0 and CC BY.
const API = 'https://api.openverse.org/v1/audio/';
const LICENSES = new Set(['cc0', 'by']);
const PLAYABLE = new Set(['mp3', 'wav', 'ogg', 'flac']);

// What the reel director asks for: genres from the catalog, words to search, the
// energy and a tempo range.
export type MusicBrief = { genres?: string[]; query: string; mood?: string; energy: 'calm' | 'medium' | 'high'; bpm?: [number, number] };

type CatalogTrack = { title: string; artist: string; genre: string; tags: string[]; seconds: number; url: string };
const catalogFile = fileURLToPath(new URL('../data/music.json', import.meta.url));
let catalog: CatalogTrack[] | undefined;
async function tracks(): Promise<CatalogTrack[]> {
  catalog ??= existsSync(catalogFile) ? (JSON.parse(await readFile(catalogFile, 'utf8')) as { tracks: CatalogTrack[] }).tracks : [];
  return catalog;
}

async function effects(): Promise<Record<string, string[]>> {
  return existsSync(catalogFile) ? ((JSON.parse(await readFile(catalogFile, 'utf8')) as { sfx?: Record<string, string[]> }).sfx ?? {}) : {};
}

// The genres the reel director can choose from.
export async function musicGenres(): Promise<string[]> {
  return [...new Set((await tracks()).flatMap((t) => t.tags))].sort();
}

// The 30 s bed: its beat (period and the time of the first beat) so cuts land on it.
export type Track = { file: string; title: string; creator: string; license: string; url: string; bpm: number; period: number; phase: number; credit: string };

type Hit = { id: string; title: string; creator: string; license: string; url: string; foreign_landing_url: string; duration: number; filetype: string };

async function search(q: string, extra = ''): Promise<Hit[]> {
  const url = `${API}?q=${encodeURIComponent(q)}&license=cc0,by&page_size=20${extra}`;
  // Openverse is sometimes slow to answer: one retry.
  const once = () => fetch(url, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'CarouselAgent/0.1' } });
  const res = await once().catch(() => once());
  if (!res.ok) throw new Error(`Openverse ${res.status}`);
  const json = (await res.json()) as { results?: Hit[] };
  return (json.results ?? []).filter((r) => LICENSES.has(r.license) && PLAYABLE.has(r.filetype) && r.url?.startsWith('https://'));
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'CarouselAgent/0.1' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

const DEFAULT_QUERY = { calm: 'chill lofi loop', medium: 'upbeat funky loop', high: 'energetic electronic loop' } as const;
const DEFAULT_BPM = { calm: [70, 100], medium: [95, 125], high: [118, 150] } as const;

// Finds, measures and cuts the music: a few candidates are downloaded and the one
// whose measured tempo fits the brief, with the most steady energy, becomes a 30 s
// bed starting on a beat. Undefined when nothing usable is found: the reel stays silent.
// seed: varies the pick between runs, so two brands asking for the same genre don't
// get the same song.
export async function findMusic(brief: MusicBrief, dir: string, seed = ''): Promise<Track | undefined> {
  await mkdir(dir, { recursive: true });
  const range = brief.bpm && brief.bpm[0] < brief.bpm[1] ? brief.bpm : DEFAULT_BPM[brief.energy];
  const hits: Hit[] = [];
  const wanted = new Set((brief.genres ?? []).map((g) => g.toLowerCase().trim()));
  if (wanted.size) {
    const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const pool = (await tracks()).filter((t) => t.tags.some((g) => wanted.has(g))).sort((a, b) => hash(seed + a.url) - hash(seed + b.url));
    for (const t of pool.slice(0, 3)) {
      hits.push({ id: t.url, title: t.title, creator: t.artist, license: 'mixkit', url: t.url, foreign_landing_url: 'https://mixkit.co/free-stock-music/', duration: t.seconds * 1000, filetype: 'mp3' });
    }
  }
  const seen = new Set<string>(hits.map((h) => h.id));
  for (const q of hits.length ? [] : [brief.query, brief.mood ? `${brief.mood} loop` : '', DEFAULT_QUERY[brief.energy]].filter(Boolean)) {
    for (const h of await search(q).catch(() => [])) {
      if (seen.has(h.id) || h.duration < 20000 || h.duration > 300000) continue;
      seen.add(h.id);
      hits.push(h);
    }
    if (hits.length >= 8) break;
  }
  // A tempo in the title is a strong hint; CC0 needs no credit line; 30 s or more needs no loop.
  const titleBpm = (h: Hit) => Number(h.title.match(/(\d{2,3})\s*bpm/i)?.[1] ?? 0);
  const prior = (h: Hit) => {
    const t = titleBpm(h);
    return (t && (t < range[0] || t > range[1]) ? 3 : 0) + (h.license === 'by' ? 0.5 : 0) + (h.duration < 30000 ? 1 : 0);
  };
  hits.sort((a, b) => prior(a) - prior(b));
  let best: { hit: Hit; file: string; bpm: number; period: number; phase: number; start: number; score: number } | undefined;
  for (const [i, hit] of hits.slice(0, 3).entries()) {
    const file = path.join(dir, `candidate-${i}.${hit.filetype}`);
    try {
      await download(hit.url, file);
      const m = await measure(file, range, titleBpm(hit));
      const off = m.bpm < range[0] ? range[0] - m.bpm : m.bpm > range[1] ? m.bpm - range[1] : 0;
      const score = off / 10 + (1 - m.steady) * 2 + prior(hit);
      if (!best || score < best.score) best = { hit, file, ...m, score };
    } catch {
      // A file that doesn't download or decode is just skipped.
    }
  }
  if (!best) return undefined;
  const out = path.join(dir, 'music.mp3');
  // Looped when short, faded in briefly and out over the closing hold.
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-stream_loop', '-1', '-ss', best.start.toFixed(3), '-i', best.file, '-t', '30', '-af', 'afade=t=in:d=0.25,afade=t=out:st=28.2:d=1.8', '-ar', '44100', '-ac', '2', '-b:a', '192k', out]);
  const phase = (((best.phase - best.start) % best.period) + best.period) % best.period;
  const h = best.hit;
  const licence = h.license === 'mixkit' ? 'Mixkit Stock Music Free License' : h.license === 'cc0' ? 'CC0' : 'CC BY 4.0';
  const credit = `"${h.title}" by ${h.creator || 'unknown'} (${licence}), ${h.foreign_landing_url || h.url}`;
  return { file: out, title: h.title, creator: h.creator, license: h.license, url: h.foreign_landing_url || h.url, bpm: best.bpm, period: best.period, phase, credit };
}

// Tempo and beat of a track from its onsets (energy rises), by autocorrelation; the
// 30 s window with the most energy starting on a beat; how steady its energy is (0..1).
async function measure(file: string, range: readonly [number, number] | [number, number], hint: number): Promise<{ bpm: number; period: number; phase: number; start: number; steady: number }> {
  const rate = 11025;
  const hop = 256;
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const pcm = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const frames = Math.floor(pcm.length / hop);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += pcm[i] * pcm[i];
    energy[f] = Math.sqrt(s / hop);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  const fps = rate / hop;
  let bestLag = 0;
  let bestAc = -1;
  for (let bpm = 60; bpm <= 190; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    const l0 = Math.floor(lag);
    const t = lag - l0;
    let ac = 0;
    for (let f = 0; f + l0 + 1 < frames; f++) ac += onset[f] * (onset[f + l0] * (1 - t) + onset[f + l0 + 1] * t);
    // A gentle preference for the brief's range and the title's tempo (octave errors).
    const inRange = bpm >= range[0] && bpm <= range[1] ? 1.15 : 1;
    const near = hint && Math.abs(bpm - hint) < 2 ? 1.3 : 1;
    if (ac * inRange * near > bestAc) {
      bestAc = ac * inRange * near;
      bestLag = lag;
    }
  }
  const bpm = Math.round((60 * fps) / bestLag * 2) / 2;
  const period = 60 / bpm;
  let phaseFrame = 0;
  let phaseSum = -1;
  for (let p = 0; p < Math.round(bestLag); p++) {
    let s = 0;
    for (let f = p; f < frames; f += bestLag) s += onset[Math.round(f)] ?? 0;
    if (s > phaseSum) {
      phaseSum = s;
      phaseFrame = p;
    }
  }
  const phase = phaseFrame / fps;
  const duration = frames / fps;
  // The loudest 30 s window starting on a beat (whole track when it is short).
  let start = 0;
  if (duration > 34) {
    let bestMean = -1;
    for (let t = phase; t + 30 <= duration; t += period * 4) {
      let s = 0;
      const a = Math.floor(t * fps);
      const b = Math.floor((t + 30) * fps);
      for (let f = a; f < b; f++) s += energy[f];
      if (s > bestMean) {
        bestMean = s;
        start = t;
      }
    }
  }
  // Steady: the quietest 2 s stretch of the window against its average.
  const a = Math.floor(start * fps);
  const b = Math.min(frames, Math.floor((start + 30) * fps));
  const mean = energy.slice(a, b).reduce((s, v) => s + v, 0) / Math.max(1, b - a);
  let quiet = Infinity;
  const win = Math.round(2 * fps);
  for (let f = a; f + win < b; f += win) quiet = Math.min(quiet, energy.slice(f, f + win).reduce((s, v) => s + v, 0) / win);
  const steady = mean > 0 && Number.isFinite(quiet) ? Math.min(1, quiet / mean) : 0;
  return { bpm, period, phase, start, steady };
}

// Short sound effects, CC0 only (no credit needed), cached across runs.
export const SFX = { whoosh: 'whoosh swoosh', impact: 'impact boom hit', pop: 'pop bubble', thud: 'thud drop', riser: 'riser' } as const;
export type SfxKind = keyof typeof SFX;

export async function findSfx(cache: string): Promise<Partial<Record<SfxKind, string>>> {
  await mkdir(cache, { recursive: true });
  const out: Partial<Record<SfxKind, string>> = {};
  for (const kind of Object.keys(SFX) as SfxKind[]) {
    const file = path.join(cache, `${kind}.mp3`);
    const longest = kind === 'riser' ? 8 : kind === 'impact' ? 4.5 : 2.5;
    // Mixkit's effects first (fast and free), then Openverse's CC0 ones.
    const urls = [...((await effects())[kind] ?? [])];
    if (!existsSync(file) && !urls.length) {
      const hits = await search(SFX[kind], '&license=cc0').catch(() => []);
      urls.push(...hits.filter((h) => h.license === 'cc0' && h.duration > 150 && h.duration < longest * 1000).map((h) => h.url));
    }
    for (const url of existsSync(file) ? [] : urls.slice(0, 4)) {
      try {
        const raw = path.join(cache, `${kind}-raw${path.extname(new URL(url).pathname) || '.mp3'}`);
        await download(url, raw);
        const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw]);
        if (Number(stdout) > longest || Number(stdout) < 0.15) continue;
        await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '44100', '-ac', '2', '-b:a', '160k', file]);
        break;
      } catch {
        continue;
      }
    }
    if (existsSync(file)) out[kind] = file;
  }
  return out;
}
