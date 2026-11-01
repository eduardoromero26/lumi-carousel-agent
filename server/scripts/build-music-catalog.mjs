// Builds data/music.json: Mixkit's free stock music (Mixkit Stock Music Free License,
// no attribution required) by genre, read from the JSON-LD of its genre pages. Only
// metadata and links: the audio is downloaded when a reel needs it.
// Run: node scripts/build-music-catalog.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const GENRES = [
  'hip-hop', 'trap', 'lo-fi-beats', 'chillout', 'downtempo', 'pop', 'dance-pop', 'electropop', 'indie-pop', 'synthwave', 'synthpop', 'edm', 'house', 'deep-house',
  'tropical-house', 'future-bass', 'funk', 'disco', 'soul', 'corporate-music', 'rock', 'indie-folk', 'folk-pop', 'latin', 'latin-pop', 'reggaeton', 'jazz', 'lounge',
  'cinematic', 'ambient', 'electronic',
];

const tracks = new Map();
for (const genre of GENRES) {
  const get = () => fetch(`https://mixkit.co/free-stock-music/${genre}/`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  const res = await get().catch(() => get()).catch(() => undefined);
  if (!res?.ok) {
    console.warn(genre, res?.status ?? 'unreachable');
    continue;
  }
  const html = await res.text().catch(() => '');
  let count = 0;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node['@type'] === 'MusicRecording' && typeof node.url === 'string' && node.url.startsWith('https://assets.mixkit.co/music/')) {
        const d = String(node.duration ?? '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        const seconds = d ? Number(d[1] ?? 0) * 60 + Number(d[2] ?? 0) : 0;
        const known = tracks.get(node.url);
        if (known) known.tags = [...new Set([...known.tags, genre])];
        else tracks.set(node.url, { title: node.name, artist: node.byArtist, genre: node.genre, tags: [genre], seconds, url: node.url });
        count++;
      }
      Object.values(node).forEach(walk);
    };
    walk(json);
  }
  console.log(genre, count);
  await new Promise((r) => setTimeout(r, 400));
}
// Sound effects: the first previews of each category (Mixkit Sound Effects Free License).
const SFX = { whoosh: 'whoosh', impact: 'impact', pop: 'pop', thud: 'thud', riser: 'transition' };
const sfx = {};
for (const [kind, page] of Object.entries(SFX)) {
  const get = () => fetch(`https://mixkit.co/free-sound-effects/${page}/`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  const res = await get().catch(() => get()).catch(() => undefined);
  const html = res?.ok ? await res.text().catch(() => '') : '';
  sfx[kind] = [...new Set([...html.matchAll(/data-audio-player-preview-url-value="(https:\/\/assets\.mixkit\.co\/[^"]+\.mp3)"/g)].map((m) => m[1]))].slice(0, 8);
  console.log('sfx', kind, sfx[kind].length);
  await new Promise((r) => setTimeout(r, 400));
}
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
const list = [...tracks.values()].filter((t) => t.seconds >= 40);
await writeFile(
  new URL('../data/music.json', import.meta.url),
  JSON.stringify({ source: 'https://mixkit.co/', license: 'Mixkit Stock Music Free License and Sound Effects Free License (https://mixkit.co/license/): free for commercial use, no attribution required', tracks: list, sfx }, null, 1),
);
console.log('tracks', list.length);
