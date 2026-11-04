import { setDefaultResultOrder } from 'node:dns';
import { createReadStream, existsSync } from 'node:fs';
import archiver from 'archiver';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import sharp from 'sharp';
import path from 'node:path';
import { config } from './config.js';
import { ensureGimp, stopGimp } from './gimp_process.js';
import { animateCarousel, chatWithDirector, editSlide, runCarousel } from './orchestrator.js';
import { alphaBox, isBadge, luminance, plainEdge, studioShot, trimLogo } from './agents/analyst.js';
import type { Asset } from './run.js';

// Some hosts (Mixkit, Openverse) hang over IPv6 on this network: IPv4 first.
setDefaultResultOrder('ipv4first');
import { Run, type Brief, type PlanReview } from './run.js';
import { backfill, batchFeedback, calibrationReport, judgedVotes, learningVotes, listCarousels, rawTaste, saveBatchFeedback, saveCarousel, saveLearningVote, saveVote, starsOf, taste, votesOf } from './db.js';
import { library } from './learned.js';
import { backfillLibrary, libraryItems, libraryUrl } from './library.js';
import { failureKinds } from './metrics.js';
import { addReference, deleteReference, reference, referenceFromRun, references, referenceUrl, type Reference } from './references.js';
import { batchReport, batchSummaries, enqueue, failuresReport, historyRows, isPaused, lessons, markFailed, markFinished, markRunning, nextWaiting, queueItems, removeWaiting, savedLists, setPaused, type QueueItem } from './queue.js';

Run.onSave = (run) => {
  try {
    saveCarousel(run);
  } catch (error) {
    console.error('Feed index:', (error as Error).message);
  }
};

const runs = new Map<string, Run>();
// GIMP is a single desktop app: one run at a time.
let busy = false;
// The run GIMP is on now, from the queue or from Create: the agents' room opens it live.
let current: string | null = null;

// kind "logo": the business logo; anything else is a photo.
type PhotoUpload = { name: string; base64: string; note?: string; kind?: 'logo' };

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    // POST /api/runs {brief, photos}
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      if (busy) return json(res, 409, { error: 'Another carousel is being made. Wait for it to finish.' });
      const body = (await readJson(req)) as { brief: Brief; photos: PhotoUpload[] };
      if (!body.brief?.url && !body.brief?.business) return json(res, 400, { error: 'Add your website' });
      if (!body.brief.url && !body.brief.goal) return json(res, 400, { error: 'Without a website, tell us what the post should do' });
      if (body.brief.url && !/^https?:\/\//i.test(body.brief.url)) body.brief.url = `https://${body.brief.url}`;
      if (body.brief.reference && !reference(body.brief.reference)) return json(res, 400, { error: 'That style is no longer in the gallery' });
      const run = new Run(body.brief);
      // From Create: the owner reviews the plan before the design starts.
      run.interactive = true;
      await run.init();
      await addPhotos(run, body.photos ?? []);
      runs.set(run.id, run);
      start(run);
      return json(res, 201, run.summary());
    }

    // GET /api/queue: the websites in line, the one running and each batch's numbers
    if (req.method === 'GET' && url.pathname === '/api/queue') return json(res, 200, queueState());

    // POST /api/queue {urls, language, batch}: one carousel per website, one after another
    if (req.method === 'POST' && url.pathname === '/api/queue') {
      const body = (await readJson(req)) as { urls?: string[]; language?: string; batch?: string };
      const batch = body.batch?.trim() || new Date().toISOString().slice(0, 16).replace('T', ' ');
      const result = enqueue(body.urls ?? [], body.language, batch);
      if (!result.added) return json(res, 400, { error: 'No new websites to add' });
      void pump();
      return json(res, 201, { ...result, ...queueState() });
    }

    // POST /api/queue/feedback {batch, stars?: 1-5, note?}: the owner's verdict on a whole batch;
    // the note is a direction every agent reads from the next carousel on. Neither clears it.
    if (req.method === 'POST' && url.pathname === '/api/queue/feedback') {
      const { batch, stars, note } = (await readJson(req)) as { batch?: unknown; stars?: unknown; note?: unknown };
      if (typeof batch !== 'string' || !batch.trim()) return json(res, 400, { error: 'Bad batch' });
      saveBatchFeedback(batch, typeof stars === 'number' ? stars : null, typeof note === 'string' ? note : null);
      return json(res, 200, queueState());
    }

    // POST /api/queue/pause {paused}: the run in progress finishes; the next one waits
    if (req.method === 'POST' && url.pathname === '/api/queue/pause') {
      const { paused } = (await readJson(req)) as { paused?: boolean };
      setPaused(paused !== false);
      void pump();
      return json(res, 200, queueState());
    }

    // DELETE /api/queue/:id, or /api/queue?batch=… (or no query: everything waiting)
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'queue') {
      removeWaiting(parts[2] ? Number(parts[2]) : undefined, url.searchParams.get('batch') ?? undefined);
      return json(res, 200, queueState());
    }

    // GET /api/queue/report?batch=…: the batch in Markdown, also in runs/batches/
    if (req.method === 'GET' && url.pathname === '/api/queue/report') {
      const batch = url.searchParams.get('batch');
      if (!batch) return json(res, 400, { error: 'Which batch?' });
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      return void res.end(batchReport(batch));
    }

    // GET /api/queue/lists: the saved lists of websites, [{name, urls}]
    if (req.method === 'GET' && url.pathname === '/api/queue/lists') return json(res, 200, savedLists());

    // GET /api/queue/failures: every failure seen in any batch, with examples and past fixes
    if (req.method === 'GET' && url.pathname === '/api/queue/failures') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      return void res.end(failuresReport());
    }

    // GET /api/config: what the app should show
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { reels: config.reels });

    // GET /api/feed: every finished carousel, newest first, as the feed shows it
    if (req.method === 'GET' && url.pathname === '/api/feed') return json(res, 200, listCarousels());

    // GET /api/taste: what the votes say about each design choice
    if (req.method === 'GET' && url.pathname === '/api/taste') return json(res, 200, taste());

    // GET /api/calibration: how often the critic agrees with the owner's votes, and the likes per batch
    if (req.method === 'GET' && url.pathname === '/api/calibration') return json(res, 200, calibrationReport());

    // GET /api/learned: what the agents learned, as shelves of cards
    if (req.method === 'GET' && url.pathname === '/api/learned') {
      const { batches, ...cal } = calibrationReport();
      return json(
        res,
        200,
        library({ stats: rawTaste(), votes: judgedVotes(), calibration: cal, batches, failures: failureKinds(historyRows()), lessons: lessons(), learned: learningVotes(), made: libraryItems().map((item) => ({ item, url: libraryUrl(item) })),
          verdicts: batchFeedback(),
          styles: references().map((r) => ({ title: r.title, url: referenceUrl(r), source: r.source, notes: r.style.notes, choices: `${r.style.composition} · ${r.style.ground} ground · ${r.style.typeScale} type · ${r.style.personality}`, at: r.at })),
        }),
      );
    }

    // POST /api/learned/vote {id: a card's id, value: 1 | -1 | 0, note?: why it was learned wrong}
    if (req.method === 'POST' && url.pathname === '/api/learned/vote') {
      const { id, value, note } = (await readJson(req)) as { id?: unknown; value?: number; note?: unknown };
      if (typeof id !== 'string' || !/^(taste|note|lesson|library|direction):.+/.test(id) || ![1, -1, 0].includes(Number(value))) return json(res, 400, { error: 'Bad vote' });
      saveLearningVote(id, Number(value), typeof note === 'string' ? note : undefined);
      return json(res, 200, Object.fromEntries(learningVotes()));
    }

    // GET /api/references: the style gallery, newest first
    if (req.method === 'GET' && url.pathname === '/api/references') return json(res, 200, references().map(publicRef));

    // POST /api/references {name, base64, title?}: a design the owner likes, read once by a vision model
    if (req.method === 'POST' && url.pathname === '/api/references') {
      const { name, base64, title } = (await readJson(req)) as { name?: unknown; base64?: unknown; title?: unknown };
      if (typeof base64 !== 'string' || base64.length < 100) return json(res, 400, { error: 'Add an image' });
      const fallback = typeof name === 'string' ? name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') : '';
      return json(res, 201, publicRef(await addReference(base64, typeof title === 'string' && title.trim() ? title : fallback)));
    }

    // DELETE /api/references/:id
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'references' && parts[2]) {
      return (await deleteReference(parts[2])) ? json(res, 200, references().map(publicRef)) : json(res, 404, { error: 'Not in the gallery' });
    }

    let run = parts[0] === 'api' && parts[1] === 'runs' && parts[2] ? runs.get(parts[2]) : undefined;
    if (!run && parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
      run = await Run.load(parts[2]);
      if (run) runs.set(run.id, run);
    }

    // POST /api/runs/:id/reference: the carousel joins the style gallery
    if (req.method === 'POST' && parts[3] === 'reference') {
      if (!run) return json(res, 404, { error: 'Run not found' });
      if (run.status !== 'done') return json(res, 409, { error: 'The carousel is not finished yet' });
      return json(res, 201, publicRef(await referenceFromRun(run)));
    }

    // POST /api/runs/:id/stop: ends the run at its next step (GIMP and the models finish what they are doing)
    if (req.method === 'POST' && parts[3] === 'stop') {
      if (!run) return json(res, 404, { error: 'Run not found' });
      if (run.status !== 'running') return json(res, 409, { error: 'This run is not running' });
      run.stopRequested = true;
      return json(res, 202, run.summary());
    }

    // POST /api/runs/:id/vote {target: "carousel" | "reel" | "slide:N", value: 1 | -1 | 0, stars?: 1-5 (carousel only), note?: what is wrong}
    if (req.method === 'POST' && parts[3] === 'vote') {
      if (!run) return json(res, 404, { error: 'Run not found' });
      const { target, value, stars, note } = (await readJson(req)) as { target?: string; value?: number; stars?: unknown; note?: unknown };
      const rated = stars === undefined || stars === null ? undefined : Number(stars);
      if (!target || !/^(carousel|reel|slide:\d+)$/.test(target)) return json(res, 400, { error: 'Bad vote' });
      if (rated === undefined ? ![1, -1, 0].includes(Number(value)) : target !== 'carousel' || ![1, 2, 3, 4, 5].includes(rated)) return json(res, 400, { error: 'Bad vote' });
      saveVote(run, target, Number(value ?? 0), typeof note === 'string' ? note : undefined, rated);
      return json(res, 200, { votes: votesOf(run.id), stars: starsOf(run.id) });
    }

    // POST /api/runs/:id/images {exclude}: the website images the owner leaves out, while they wait
    if (req.method === 'POST' && parts[3] === 'images') {
      if (!run?.imagePick) return json(res, 409, { error: 'The director has already started with the images.' });
      const { exclude } = (await readJson(req)) as { exclude?: unknown };
      run.imagePick(Array.isArray(exclude) ? exclude.filter((x): x is string => typeof x === 'string') : []);
      return json(res, 202, run.summary());
    }

    // POST /api/runs/:id/plan {slides, note}: the owner's changes to the plan, while it waits
    if (req.method === 'POST' && parts[3] === 'plan') {
      if (!run?.planReview) return json(res, 409, { error: 'The plan can no longer change: the design has started.' });
      const review = (await readJson(req)) as PlanReview;
      run.planReview({
        slides: Array.isArray(review?.slides) ? review.slides : [],
        note: typeof review?.note === 'string' ? review.note.slice(0, 600) : undefined,
        exclude: Array.isArray(review?.exclude) ? review.exclude.filter((x): x is string => typeof x === 'string') : undefined,
      });
      return json(res, 202, run.summary());
    }

    // POST /api/runs/:id/chat {text}: the owner writes to the director in the team chat
    if (req.method === 'POST' && parts[3] === 'chat') {
      if (!run) return json(res, 404, { error: 'Run not found' });
      if (run.status !== 'done' || !run.plan) return json(res, 409, { error: 'The director answers once the carousel is ready' });
      if (busy) return json(res, 409, { error: 'The team is busy with another carousel: pause the queue and try again.' });
      const { text } = (await readJson(req)) as { text?: string };
      if (!text?.trim()) return json(res, 400, { error: 'Write something to the director' });
      busy = true;
      current = run.id;
      void chatWithDirector(run, text.trim().slice(0, 1000)).finally(() => {
        current = null;
        release();
      });
      return json(res, 202, run.summary());
    }

    // POST /api/runs/:id/slides/:n/edit {feedback}
    if (req.method === 'POST' && parts[3] === 'slides' && parts[5] === 'edit') {
      if (!run) return json(res, 404, { error: 'Run not found' });
      if (run.status !== 'done') return json(res, 409, { error: 'The carousel is not finished yet' });
      if (busy) return json(res, 409, { error: 'Another carousel is being made.' });
      const { feedback } = (await readJson(req)) as { feedback?: string };
      if (!feedback?.trim()) return json(res, 400, { error: 'Tell the designer what to change' });
      busy = true;
      void editSlide(run, Number(parts[4]), feedback.trim()).finally(release);
      return json(res, 202, run.summary());
    }

    // POST /api/runs/:id/reel: only the 30 s reel, keeping the card videos already made
    // POST /api/runs/:id/motion: animate the approved carousel with HyperFrames, then the reel
    if (req.method === 'POST' && (parts[3] === 'motion' || parts[3] === 'reel')) {
      if (!config.reels) return json(res, 404, { error: 'Reels are off (REELS=1 in server/.env turns them on)' });
      if (!run) return json(res, 404, { error: 'Run not found' });
      if (run.status !== 'done' || !run.slides.length) return json(res, 409, { error: 'The carousel is not finished yet' });
      if (busy) return json(res, 409, { error: 'Another carousel is being made.' });
      busy = true;
      // The room opens it live, like a carousel being made.
      current = run.id;
      void animateCarousel(run, { cards: parts[3] === 'motion' }).finally(() => {
        current = null;
        release();
      });
      return json(res, 202, run.summary());
    }

    // GET /api/runs/:id/events (Server-Sent Events, replays history first)
    if (req.method === 'GET' && parts[3] === 'events') {
      if (!run) return json(res, 404, { error: 'Run not found' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      run.events.forEach(send);
      const unsubscribe = run.subscribe(send);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }

    // GET /api/runs/:id/download: everything in one ZIP (browsers block a burst of downloads)
    if (req.method === 'GET' && parts[3] === 'download') {
      if (!run) return json(res, 404, { error: 'Run not found' });
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="carousel-${run.id}.zip"` });
      return void (await downloadZip(run, res));
    }

    // GET /api/runs/:id
    if (req.method === 'GET' && parts.length === 3 && parts[1] === 'runs') {
      return run ? json(res, 200, run.summary()) : json(res, 404, { error: 'Run not found' });
    }

    // GET /files/:runId/... (slides, snapshots, photos)
    if (req.method === 'GET' && parts[0] === 'files' && parts.length >= 3) {
      const file = path.resolve(config.runsDir, ...parts.slice(1));
      if (!file.startsWith(config.runsDir + path.sep)) return json(res, 400, { error: 'Bad path' });
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': info.size });
      return void createReadStream(file).pipe(res);
    }

    // Anything else: the built Flutter app (single-page, so unknown paths get index.html).
    if (req.method === 'GET' && parts[0] !== 'api') {
      const target = path.resolve(config.webDir, ...parts);
      const inside = target === config.webDir || target.startsWith(config.webDir + path.sep);
      const info = inside ? await stat(target).catch(() => null) : null;
      const file = info?.isFile() ? target : path.join(config.webDir, 'index.html');
      const index = await stat(file).catch(() => null);
      if (!index) return json(res, 404, { error: 'App not built. Run: cd app && flutter build web' });
      res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': index.size });
      return void createReadStream(file).pipe(res);
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: (error as Error).message });
  }
});

// Runs that failed in a row because GIMP was down: past 3 the queue pauses instead of
// failing every website left in the batch.
let gimpFailures = 0;

function start(run: Run, item?: QueueItem): void {
  busy = true;
  current = run.id;
  // A carousel from Create goes on to its 30 s reel (REELS=1); the queue's mass runs don't.
  const reel = () => (config.reels && !item && run.status === 'done' && run.slides.length ? animateCarousel(run, { cards: false }) : undefined);
  void runCarousel(run)
    .then(reel)
    .catch((error: Error) => console.error(error))
    .finally(() => {
    current = null;
    if (item) {
      markFinished(item.id, run);
      const error = run.status === 'failed' ? [...run.events].reverse().find((e) => e.type === 'error')?.text ?? '' : '';
      gimpFailures = /MCP error|GIMP/i.test(error) ? gimpFailures + 1 : 0;
      if (gimpFailures >= 3) {
        setPaused(true);
        gimpFailures = 0;
        console.error(`Queue paused: GIMP failed 3 runs in a row (${error}).`);
      }
    }
    release();
  });
}

// GIMP is free again: the next website in the queue, unless it is paused.
function release(): void {
  busy = false;
  void pump();
}

async function pump(): Promise<void> {
  if (busy || isPaused()) return;
  const item = nextWaiting();
  if (!item) return;
  busy = true;
  try {
    const run = new Run({ url: item.url, language: item.language ?? undefined });
    await run.init();
    runs.set(run.id, run);
    markRunning(item.id, run.id);
    start(run, item);
  } catch (error) {
    markFailed(item.id, (error as Error).message);
    release();
  }
}

function queueState() {
  const items = queueItems();
  const feedback = batchFeedback();
  return { paused: isPaused(), busy, running: items.find((i) => i.status === 'running')?.runId ?? null, current, items, batches: batchSummaries().map((b) => ({ ...b, feedback: feedback.find((f) => f.batch === b.batch) ?? null })) };
}

// The owner's own photos and logo, read like the website's: a studio shot shows the
// product whole on a card, a transparent PNG is already a cutout.
async function addPhotos(run: Run, uploads: PhotoUpload[]): Promise<void> {
  for (const upload of uploads) {
    // Applies the phone's EXIF rotation once, so GIMP and SAM see the same pixels.
    const image = sharp(Buffer.from(upload.base64, 'base64')).rotate();
    const { hasAlpha } = await image.metadata();
    const transparent = !!hasAlpha && ((await image.clone().stats()).channels[3]?.min ?? 255) < 250;
    if (upload.kind === 'logo') {
      const id = `u${run.assets.length + 1}`;
      const file = path.join(run.dir, 'photos', `${id}-logo.png`);
      const out = await image.png().toFile(file);
      const logo: Asset = { id, path: file, source: 'upload', alt: 'the business logo', hint: 'uploaded by the owner', width: out.width, height: out.height, transparent, kind: 'logo' };
      logo.matte = transparent ? undefined : await plainEdge(file);
      await trimLogo(logo);
      logo.tone = await luminance(logo);
      logo.badge = await isBadge(logo);
      run.assets.push(logo);
      run.logo = logo;
      continue;
    }
    const id = `p${run.photos.length + 1}`;
    const file = path.join(run.dir, 'photos', `${id}.${transparent ? 'png' : 'jpg'}`);
    await writeFile(file, transparent ? await image.png().toBuffer() : await image.jpeg({ quality: 92 }).toBuffer());
    const shot = transparent ? { cropped: false, content: await alphaBox(file) } : await studioShot(file);
    const cutout = transparent || (!!shot.matte && !shot.cropped);
    run.photos.push({ id, path: file, note: upload.note ? `the owner's photo: ${upload.note}` : "the owner's photo", cutout, matte: cutout && !transparent ? shot.matte : undefined, content: shot.content, cropped: shot.cropped || undefined });
  }
}

// Slides, card videos, the reel and its cover, the caption and the motion docs.
async function downloadZip(run: Run, res: http.ServerResponse): Promise<void> {
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.pipe(res);
  for (const s of run.slides) zip.file(path.join(run.dir, s.file), { name: `slides/${s.file}` });
  const renders = path.join(run.dir, 'motion', 'renders');
  for (const s of run.slides) {
    const card = path.join(renders, `card-${s.n}.mp4`);
    if (existsSync(card)) zip.file(card, { name: `videos/card-${s.n}.mp4` });
  }
  for (const name of config.reels ? ['reel.mp4', 'reel-cover.png'] : []) {
    if (existsSync(path.join(renders, name))) zip.file(path.join(renders, name), { name: `reel/${name}` });
  }
  for (const name of config.reels ? ['SPEC.md', 'REVIEW.md'] : []) {
    if (existsSync(path.join(run.dir, 'motion', name))) zip.file(path.join(run.dir, 'motion', name), { name: `reel/${name}` });
  }
  if (run.plan) zip.append(`${run.plan.caption}\n\n${run.plan.hashtags.join(' ')}\n`, { name: 'caption.txt' });
  await zip.finalize();
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

const publicRef = (ref: Reference) => ({ id: ref.id, title: ref.title, url: referenceUrl(ref), source: ref.source, runId: ref.runId, style: ref.style, at: ref.at });

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
};

function contentType(file: string): string {
  return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// A rejected promise nobody awaited used to kill the server silently (twice in one night):
// it goes to runs/server.log with its stack and the server keeps serving.
for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(event, (error: unknown) => {
    const text = `${new Date().toISOString()} ${event}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
    console.error(text);
    void appendFile(path.join(config.runsDir, 'server.log'), text).catch(() => undefined);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopGimp();
    process.exit(0);
  });
}

server.listen(config.port, () => {
  console.log(`Carousel Agent on http://localhost:${config.port}`);
  backfill().catch((error: Error) => console.error('Feed index:', error.message));
  backfillLibrary().catch((error: Error) => console.error('Library:', error.message));
  void pump();
  ensureGimp()
    .then((how) => console.log(how === 'started' ? 'GIMP started headless (gimp-console).' : 'Using the GIMP that is already running.'))
    .catch((error: Error) => console.error(error.message));
});
