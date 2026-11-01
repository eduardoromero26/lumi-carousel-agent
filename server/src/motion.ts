import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { MotionPlan } from './agents/motion.js';
import { config, SLIDE } from './config.js';
import type { LayerInfo } from './gimp.js';

const run = promisify(execFile);
const GSAP = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';

export type Card = { n: number; layers: LayerInfo[]; motion: MotionPlan };

const head = (title: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${SLIDE.width}, height=${SLIDE.height}" />
    <title>${title}</title>
    <script src="${GSAP}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${SLIDE.width}px; height: ${SLIDE.height}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
    </style>
  </head>`;

const host = (card: { n: number; motion: MotionPlan }, start: number) =>
  `      <div id="card-${card.n}" data-composition-id="card-${card.n}" data-composition-src="compositions/card-${card.n}.html" data-start="${start}" data-duration="${card.motion.duration}" data-track-index="0" data-track-kind="graphics" data-width="${SLIDE.width}" data-height="${SLIDE.height}"></div>`;

// Writes the HyperFrames project: one scene per card plus a review reel that
// plays them back to back. Layer PNGs are copied in as assets/c<n>/L<i>.png.
export async function writeCard(dir: string, card: Card): Promise<void> {
  const assets = path.join(dir, 'assets', `c${card.n}`);
  await mkdir(assets, { recursive: true });
  await mkdir(path.join(dir, 'compositions'), { recursive: true });
  for (const layer of card.layers) await copyFile(layer.file, path.join(assets, `${layer.id}.png`));
  await writeFile(path.join(dir, 'compositions', `card-${card.n}.html`), cardHtml(card));
}

export async function writeIndex(dir: string, cards: { n: number; motion: MotionPlan }[]): Promise<void> {
  let start = 0;
  const hosts = cards.map((c) => {
    const h = host(c, start);
    start += c.motion.duration;
    return h;
  });
  await writeFile(
    path.join(dir, 'index.html'),
    `${head('Carousel motion review')}
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${start}" data-width="${SLIDE.width}" data-height="${SLIDE.height}">
${hosts.join('\n')}
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`,
  );
  await writeFile(path.join(dir, 'hyperframes.json'), JSON.stringify({ paths: { compositions: 'compositions', assets: 'assets' } }, null, 2));
}

function cardHtml({ n, layers, motion }: Card): string {
  const id = `c${n}`;
  // GIMP lists the top layer first; HTML paints later elements on top.
  const stack = [...layers].reverse();
  const imgs = stack
    .map((l, z) => {
      const origin = `${Math.round(l.x + l.w / 2)}px ${Math.round(l.y + l.h / 2)}px`;
      return `    <img id="${id}-${l.id}" class="layer" src="assets/${id}/${l.id}.png" alt="${escape(l.name)}" style="z-index: ${z + 1}; transform-origin: ${origin}" />`;
    })
    .join('\n');

  const sel = (layer: string) => JSON.stringify(`#${id}-${layer}`);
  const lines: string[] = [];
  if (motion.camera?.layers.length) {
    const targets = JSON.stringify(motion.camera.layers.map((l) => `#${id}-${l}`));
    lines.push(`tl.fromTo(${targets}, { scale: 1 }, { scale: ${motion.camera.scale}, duration: ${motion.exit_at}, ease: "sine.inOut", transformOrigin: "540px 675px" }, 0);`);
    lines.push(`tl.to(${targets}, { scale: 1, duration: ${(motion.duration - motion.exit_at - 0.05).toFixed(2)}, ease: "power2.inOut" }, ${motion.exit_at});`);
  }
  for (const e of motion.enter) {
    const from = { opacity: e.from.opacity ?? 1, x: e.from.x ?? 0, y: e.from.y ?? 0, scale: e.from.scale ?? 1 };
    lines.push(`tl.fromTo(${sel(e.layer)}, ${JSON.stringify(from)}, { opacity: 1, x: 0, y: 0, scale: 1, duration: ${e.duration}, ease: ${JSON.stringify(e.ease)} }, ${e.at});`);
  }
  for (const p of motion.pulse) {
    lines.push(`tl.to(${sel(p.layer)}, { scale: 1.03, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: 1 }, ${p.at});`);
  }
  // Seamless loop: everything that entered goes back to its frame-0 state.
  const entered = [...new Set(motion.enter.map((e) => e.layer))];
  for (const layer of entered) {
    const e = motion.enter.find((x) => x.layer === layer)!;
    const back = { opacity: e.from.opacity ?? 1, x: e.from.x ?? 0, y: e.from.y ?? 0, scale: e.from.scale ?? 1 };
    lines.push(`tl.to(${sel(layer)}, { ...${JSON.stringify(back)}, duration: ${(motion.duration - motion.exit_at - 0.1).toFixed(2)}, ease: "power1.in" }, ${motion.exit_at});`);
  }

  return `<template>
  <style>
    #${id} { position: absolute; inset: 0; overflow: hidden; background: #000; }
    #${id} .layer { position: absolute; left: 0; top: 0; width: ${SLIDE.width}px; height: ${SLIDE.height}px; will-change: transform, opacity; }
  </style>
  <div id="${id}" data-composition-id="card-${n}" data-width="${SLIDE.width}" data-height="${SLIDE.height}" data-duration="${motion.duration}" data-layout-allow-overflow>
${imgs}
  </div>
  <script>
    (() => {
      // ${escape(motion.notes ?? '')}
      const tl = gsap.timeline({ paused: true });
      ${lines.join('\n      ')}
      window.__timelines["card-${n}"] = tl;
    })();
  </script>
</template>
`;
}

export type CheckResult = { ok: boolean; errors: string[]; warnings: string[] };

export async function check(dir: string): Promise<CheckResult> {
  let stdout = '';
  try {
    stdout = (await npx(['check', '.', '--json'], dir)).stdout;
  } catch (error) {
    // check exits non-zero on errors but still prints its JSON.
    stdout = (error as { stdout?: string }).stdout ?? '';
  }
  const start = stdout.indexOf('{');
  if (start < 0) return { ok: false, errors: [`hyperframes check printed no JSON: ${stdout.slice(0, 300)}`], warnings: [] };
  const report = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const f = node as Record<string, unknown>;
    if (typeof f.code === 'string' && typeof f.severity === 'string') {
      const line = `${f.code}${f.selector ? ` (${f.selector})` : ''}${f.fixHint ? `: ${f.fixHint}` : f.message ? `: ${f.message}` : ''}`;
      (f.severity === 'error' ? errors : warnings).push(line);
      return;
    }
    Object.values(f).forEach(walk);
  };
  walk(report);
  return { ok: report.ok === true || errors.length === 0, errors, warnings };
}

// A scene inside <template> can't be rendered with -c directly, so each card
// gets a temporary one-slot entry page.
export async function renderCard(dir: string, card: { n: number; motion: MotionPlan }, output: string): Promise<void> {
  const entry = `render-card-${card.n}.html`;
  await writeFile(
    path.join(dir, entry),
    `${head(`Card ${card.n}`)}
  <body>
    <div id="root" data-composition-id="render-card-${card.n}" data-start="0" data-duration="${card.motion.duration}" data-width="${SLIDE.width}" data-height="${SLIDE.height}">
${host(card, 0).replace(`id="card-${card.n}"`, `id="card-${card.n}"`)}
    </div>
    <script>
      window.__timelines["render-card-${card.n}"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`,
  );
  try {
    await mkdir(path.dirname(output), { recursive: true });
    await npx(['render', '.', '-c', entry, '--fps', '30', '--quality', 'delivery', '--output', output, '--quiet'], dir);
  } finally {
    await rm(path.join(dir, entry), { force: true });
  }
}

// Frames for the critic plus two numbers the code measures itself: how far the
// rest frame is from the approved slide and how far the last frame is from the first.
export async function inspect(video: string, motion: MotionPlan, slidePng: string, outDir: string) {
  await mkdir(outDir, { recursive: true });
  const last = motion.duration - 1 / 30;
  const times = [0, 0.8, 1.8, Math.max(0, motion.exit_at - 0.2), last];
  const frames: { t: number; file: string }[] = [];
  for (const t of times) {
    const file = path.join(outDir, `f-${t.toFixed(2)}.png`);
    // Seeking to the exact end yields nothing; the last frame is read from the end instead.
    const seek = t === last ? ['-sseof', '-0.2'] : ['-ss', t.toFixed(3)];
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...seek, '-i', video, '-update', '1', '-frames:v', t === last ? '6' : '1', file]);
    frames.push({ t, file });
  }
  const restVsSlide = await difference(frames[3].file, slidePng);
  const loop = await difference(frames[0].file, frames[frames.length - 1].file);
  return { frames, restVsSlide, loop };
}

async function difference(a: string, b: string): Promise<number> {
  const size = { width: 270, height: 338, fit: 'fill' as const };
  const [x, y] = await Promise.all([a, b].map(async (f) => sharp(await readFile(f)).removeAlpha().resize(size).raw().toBuffer()));
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length / 255;
}

function npx(args: string[], cwd: string) {
  return run('npx', ['--yes', `hyperframes@${config.hyperframesVersion}`, ...args], {
    cwd,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
}

function escape(s: string): string {
  return s.replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' })[c]!);
}
