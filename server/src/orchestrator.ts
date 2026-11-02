import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeAssets } from './agents/analyst.js';
import { reviewMotion, reviewSet, reviewSlide, type Review } from './agents/critic.js';
import { MotionDesigner, validateMotion } from './agents/motion.js';
import { ReelDirector, reviewReel } from './agents/reel.js';
import { SlideDesigner } from './agents/designer.js';
import { planCarousel } from './agents/director.js';
import { config, SLIDE } from './config.js';
import { spentUsd } from './llm.js';
import { Gimp, type LayerInfo } from './gimp.js';
import { ensureGimp, restartGimp } from './gimp_process.js';
import type { Photo, Plan, Run, SlidePlan } from './run.js';
import { check, inspect, renderCard, writeCard, writeIndex, type Card } from './motion.js';
import { faceChanges } from './faces.js';
import { locate, protectOnSlide, samPrompts, subjectBox } from './sam.js';
import { captureSite, readSite } from './site.js';
import { assetsFromScreens } from './screen_assets.js';
import { cutOut, keyOut } from './cutout.js';
import { designSystem } from './agents/art_director.js';
import { cutsOut, describeSystem } from './design.js';
import { buildSlide, type Built } from './templates.js';
import { lintSlide } from './lint.js';
import { chooseFix, type Fix } from './agents/fixer.js';
import { describeRequests, type FixRequest } from './fixes.js';
import sharp from 'sharp';
import { fitBeats, inspectReel, readLook, renderReel, repairReel, validateReel, writeReel, writeReelDocs, type Sound } from './reel.js';
import { findMusic, findSfx } from './music.js';
import { recentLooks } from './db.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

export async function runCarousel(run: Run): Promise<void> {
  run.status = 'running';
  run.slides = [];
  await withGimp(run, async (gimp) => {
    if (run.brief.url && !run.site) await readWebsite(run);
    if (!run.photos.length && !run.site) throw new Error('No photos and no website to work with.');


    const plan = await planCarousel(run);
    run.plan = plan;
    run.emit('thought', 'director', `${plan.format ? `${plan.format} for a ${plan.business_type ?? 'business'}: ` : ''}${plan.concept}\n\n${plan.why}`, { data: plan });

    // One visual system for every slide, with the brand fonts installed in GIMP.
    run.emit('status', 'designer', 'Setting the visual system of the carousel…');
    const system = await designSystem(run, plan, gimp);
    // The pill is the cover's label; without one the device is the underline.
    if (system.device === 'pill_label' && !plan.slides[0]?.eyebrow) system.device = 'underline';
    run.system = system;
    run.styleNotes = describeSystem(system);

    // Slide 2 first, alone: it is the master the critic holds every other slide to, like
    // an agency's master page. Then the rest at once: the models think in parallel and
    // GIMP takes turns. The family is checked afterwards on the whole set.
    const built = new Map<number, Built>();
    const measured = new Map<number, string[]>();
    const make = async (slide: SlidePlan, approved: string[]) => {
      run.emit('status', 'system', `Slide ${slide.n}: ${slide.headline}`, { slide: slide.n });
      // The cover sets the tone: it gets one more round than the others.
      const result = await buildAndReview(run, gimp, plan, slide, approved, { extraRounds: slide.n === 1 ? 1 : 0 });
      built.set(slide.n, result.built);
      measured.set(slide.n, result.measured);
      return result.snapshot;
    };
    const master = plan.slides.length > 2 ? plan.slides[1] : undefined;
    const reference = master ? [await make(master, [])] : [];
    if (master) run.emit('status', 'system', `Slide ${master.n} is the master: the other slides follow it.`, { slide: master.n });
    const results = await Promise.allSettled(plan.slides.filter((s) => s !== master).map((slide) => make(slide, reference)));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;

    // The whole set on one contact sheet: one family, or which slides break it.
    await reviewWholeSet(run, gimp, plan, built, measured);

    run.status = 'done';
    run.syncCost();
    // What the designer couldn't fix goes to the template's author, in the delivery.
    const templateIssues = run.slides.flatMap((s) => (s.templateIssues ?? []).map((t) => `slide ${s.n}: ${t}`));
    run.emit('done', 'system', `Carousel ready · US$${run.cost.toFixed(2)}${templateIssues.length ? `\nTemplate issues (no action of the designer fixes them): ${templateIssues.join('; ')}` : ''}`, {
      data: { caption: plan.caption, hashtags: plan.hashtags, cost: run.cost, templateIssues },
    });
  });
}

// The owner's review of a finished slide: the designer reopens its XCF with all
// the layers, applies the feedback and the critic checks it was applied.
export async function editSlide(run: Run, n: number, feedback: string): Promise<void> {
  const plan = run.plan;
  const slide = plan?.slides.find((s) => s.n === n);
  if (!plan || !slide) throw new Error(`Slide ${n} not found`);
  run.status = 'running';
  await withGimp(run, async (gimp) => {
    run.emit('status', 'designer', `Editing slide ${n}: ${feedback}`, { slide: n });
    const others = await Promise.all(run.slides.filter((s) => s.n !== n).map(async (s) => (await readFile(path.join(run.dir, s.file))).toString('base64')));
    if (run.system && slide.layout) {
      // A template slide: the owner's changes become settings and words, and it is rebuilt.
      await buildAndReview(run, gimp, plan, slide, others.slice(0, 2), { owner: [feedback], current: await slideThumb(path.join(run.dir, `slide-${n}.png`)) });
      run.status = 'done';
      run.emit('done', 'system', `Slide ${n} updated`, { data: { caption: plan.caption, hashtags: plan.hashtags, edited: n } });
      return;
    }
    await gimp.openXcf(xcfPath(run, n));
    const designer = new SlideDesigner(run, gimp, slide, plan, run.styleNotes ?? '', 'edit');
    await designAndReview(run, gimp, plan, slide, designer, others.slice(0, 2), [feedback], { system: run.styleNotes });
    run.status = 'done';
    run.emit('done', 'system', `Slide ${n} updated`, { data: { caption: plan.caption, hashtags: plan.hashtags, edited: n } });
  });
}

async function withGimp(run: Run, work: (gimp: Gimp) => Promise<void>): Promise<void> {
  let gimp = new Gimp();
  run.stopRequested = false;
  // The meter is process-wide and runs go one at a time.
  const base = spentUsd() - run.cost;
  run.syncCost = () => {
    run.cost = spentUsd() - base;
  };
  try {
    run.emit('status', 'system', 'Connecting to GIMP…');
    await ensureGimp();
    await gimp.connect().catch(async () => {
      // A stale GIMP: start a fresh one and try once more.
      run.emit('status', 'system', 'GIMP did not answer: restarting it…');
      await gimp.close().catch(() => {});
      await restartGimp();
      gimp = new Gimp();
      await gimp.connect();
    });
    await work(gimp);
  } catch (error) {
    run.status = 'failed';
    run.emit('error', 'system', (error as Error).message);
  } finally {
    run.stopRequested = false;
    run.syncCost();
    run.syncCost = () => {};
    await gimp.close().catch(() => {});
  }
}

async function readWebsite(run: Run): Promise<void> {
  run.emit('status', 'analyst', `Reading ${run.brief.url}…`);
  try {
    run.site = await readSite(run, run.brief.url!);
    run.emit('status', 'analyst', 'Taking screenshots of the website, to read how the brand designs…');
    run.site.screens = await captureSite(run, run.brief.url!);
    // Few images in the page's code (rendered by JavaScript, or not served to us): the
    // ones a visitor sees are cropped from the screenshot.
    if (run.assets.length < 6 && run.site.screens.length) {
      run.emit('status', 'analyst', `The website gave only ${run.assets.length} images: reading them from what a visitor sees…`);
      const added = await assetsFromScreens(run).catch(() => 0);
      run.emit('status', 'analyst', added ? `Cropped ${added} images from the page as a visitor sees it.` : 'No usable images on the page either.');
    }
    run.emit('status', 'analyst', `Read "${run.site.title || run.brief.url}" and found ${run.assets.length} images. Looking at them…`);
    await analyzeAssets(run);
    const counts = new Map<string, number>();
    run.assets.forEach((a) => counts.set(a.kind ?? 'other', (counts.get(a.kind ?? 'other') ?? 0) + 1));
    const summary = [...counts].map(([kind, count]) => `${count} ${kind}`).join(', ');
    const colors = run.brief.brandColors?.length ? `Brand colors: ${run.brief.brandColors.join(', ')}.` : '';
    run.emit('assets', 'analyst', `${summary}. ${run.logo ? 'Found the logo.' : 'No logo found.'} ${colors}`.trim(), {
      data: {
        logo: run.logo ? run.fileUrl(run.logo.path) : null,
        colors: run.brief.brandColors ?? [],
        assets: run.assets.map((a) => ({ id: a.id, kind: a.kind, description: a.description, url: run.fileUrl(a.path) })),
      },
    });
  } catch (error) {
    run.emit('status', 'analyst', `Could not read the website (${(error as Error).message}). Going on with what you gave me.`);
  }
}

type SlideState = Pick<SlidePlan, 'tweaks' | 'photo' | 'headline' | 'body' | 'eyebrow' | 'button' | 'subjectNorm' | 'facesNorm' | 'seen' | 'frame' | 'faces' | 'subjectBox'>;

function stateOf(slide: SlidePlan): SlideState {
  const { tweaks, photo, headline, body, eyebrow, button, subjectNorm, facesNorm, seen, frame, faces, subjectBox } = slide;
  return structuredClone({ tweaks, photo, headline, body, eyebrow, button, subjectNorm, facesNorm, seen, frame, faces, subjectBox });
}

type Prepared = { photo?: Photo; keep: Box[]; focus?: { x: number; y: number } };
type Box = { x1: number; y1: number; x2: number; y2: number };

// What a slide needs before GIMP: the product cut out if the director asked and
// SAM's look at the photo (once per photo). No GIMP here, so slides prepare in parallel.
async function prepareSlide(run: Run, slide: SlidePlan): Promise<Prepared> {
  const system = run.system!;
  let photo = slide.photo ? run.photos.find((p) => p.id === slide.photo) : undefined;
  if (photo && slide.cut_out && !photo.cutout && !photo.backdrop) {
    // SAM 3.1 isolates the product: the slide uses the cutout from here on.
    const cut = await cutOut(run, photo, slide.subject || 'product').catch(() => undefined);
    run.emit('status', 'analyst', cut ? `SAM 3.1 cut the ${slide.subject || 'product'} out of its background.` : `SAM 3.1 could not find "${slide.subject}" to cut out; using the photo as it is.`, {
      slide: slide.n,
      data: cut ? { url: run.fileUrl(cut.path) } : undefined,
    });
    if (cut) {
      slide.photo = cut.id;
      photo = cut;
    }
  }
  // A website banner only shows small in a window: what it shows (the product, the team)
  // cut out of it can be the hero instead, when the cut is clean.
  if (photo?.backdrop) {
    const people = /\b(team|people|person|woman|man|staff|doctor)\b/i.test(`${slide.subject ?? ''} ${photo.note ?? ''}`);
    const subject = people ? 'person' : slide.subject || 'product';
    const cut = run.photos.find((p) => p.id === `${photo!.id}c`) ?? (await cutOut(run, photo, subject).catch(() => undefined));
    run.emit('status', 'analyst', cut ? `SAM 3.1 cut the ${subject} out of the banner: it goes big instead of the banner.` : `The banner's ${subject} can't be cut out cleanly; the banner goes whole in a window.`, {
      slide: slide.n,
      data: cut ? { url: run.fileUrl(cut.path) } : undefined,
    });
    if (cut) {
      slide.photo = cut.id;
      photo = cut;
    }
  }
  // The cutout composition: the person or product of every photo slide comes out of its photo
  // (where SAM can't find it, the template gives the photo a hard edge instead).
  if (photo && cutsOut(system, slide.layout) && !photo.cutout && !photo.backdrop) {
    const people = run.assets.find((a) => a.id === photo!.asset)?.kind === 'people';
    const subject = people ? 'person' : slide.subject || 'product';
    const cut = run.photos.find((p) => p.id === `${photo!.id}c`) ?? (await cutOut(run, photo, subject).catch(() => undefined));
    run.emit('status', 'analyst', cut ? `SAM 3.1 cut the ${subject} out for the cutout composition.` : `SAM 3.1 could not cut the ${subject} out; this slide gets a hard-edged photo.`, {
      slide: slide.n,
      data: cut ? { url: run.fileUrl(cut.path) } : undefined,
    });
    if (cut) {
      slide.photo = cut.id;
      photo = cut;
    }
  }
  // Products loose on the ground (the brand's way, a hero or the cutout composition): a studio shot loses its plain background.
  if (photo?.cutout && photo.matte && (system.products === 'loose' || slide.layout === 'hero' || cutsOut(system, slide.layout))) {
    const keyed = run.photos.find((p) => p.id === `${photo!.id}k`) ?? (await keyOut(run, photo).catch(() => undefined));
    if (keyed) {
      slide.photo = keyed.id;
      photo = keyed;
    }
  }
  // Any real photo: SAM finds the subject and the faces, so the crop keeps them whole and the text off them.
  if (photo && !photo.cutout && !photo.backdrop && slide.seen !== photo.id) {
    slide.subjectNorm = undefined;
    slide.facesNorm = undefined;
    await findSubject(run, slide, photo.path);
    slide.seen = photo.id;
  }
  const keep = photo && !photo.cutout && !photo.backdrop ? [...(slide.subjectNorm ? [slide.subjectNorm] : []), ...(slide.facesNorm ?? [])] : [];
  const focus = keep.length
    ? { x: (Math.min(...keep.map((k) => k.x1)) + Math.max(...keep.map((k) => k.x2))) / 2, y: (Math.min(...keep.map((k) => k.y1)) + Math.max(...keep.map((k) => k.y2))) / 2 }
    : slide.focus;
  return { photo, keep, focus };
}

// The template on a blank slide. Only inside gimp.exclusive.
async function drawSlide(run: Run, gimp: Gimp, slide: SlidePlan, { photo, keep, focus }: Prepared): Promise<Built> {
  const system = run.system!;
  await gimp.blankSlide(system.base);
  const built = await buildSlide(gimp, { run, system, slide, photo, avoid: keep, faces: keep.length ? slide.facesNorm : undefined, focus });
  if (built.photoFrame && keep.length) protectOnSlide(slide, built.photoFrame);
  else {
    slide.faces = [];
    slide.subjectBox = undefined;
  }
  return built;
}

// Template slide rounds: build, measure (lint), the critic, and the fixer's new
// settings; the best round is the one kept, not the last.
async function buildAndReview(
  run: Run,
  gimp: Gimp,
  plan: Plan,
  slide: SlidePlan,
  approved: string[],
  opts: { owner?: string[]; extraRounds?: number; current?: string } = {},
): Promise<{ snapshot: string; built: Built; measured: string[] }> {
  const snapsDir = path.join(run.dir, 'snaps');
  await mkdir(snapsDir, { recursive: true });
  const owner = opts.owner ?? [];
  let issues = owner;
  // The critic's fixes in the contract's actions; the fixer does every one.
  let requests: FixRequest[] = [];
  let from: 'critic' | 'owner' = owner.length ? 'owner' : 'critic';
  let built: Built | undefined;
  let snapshot = opts.current ?? '';
  type Round = { xcf: string; state: SlideState; built: Built; snapshot: string; rank: number; approved: boolean; measured: string[] };
  const rounds: Round[] = [];
  const templateIssues: string[] = [];
  const maxRounds = config.maxRevisions + (opts.extraRounds ?? 0);
  // The owner's changes no setting can make are redone on every rebuild.
  let hands: string[] = [];
  for (let round = 0; round <= maxRounds; round++) {
    try {
      if (issues.length || requests.length) {
        const fix = await chooseFix(run, plan, slide, built, issues, requests, snapshot || undefined, from, owner);
        slide.tweaks = fix.tweaks;
        if (fix.photo) slide.photo = fix.photo;
        if (fix.text) Object.assign(slide, fix.text);
        if (fix.hands.length) hands = fix.hands;
        noteTemplateIssues(run, slide.n, fix.unmet.map((a) => `${a} was asked for, but no other photo is free`), templateIssues);
        run.emit('thought', 'designer', describeFix(fix), { slide: slide.n, data: { tweaks: fix.tweaks, photo: fix.photo, text: fix.text, applied: fix.applied, byCode: fix.byCode } });
      }
      const prepared = await prepareSlide(run, slide);
      const xcf = path.join(snapsDir, `s${slide.n}-r${round}.xcf`);
      const check = path.join(snapsDir, `s${slide.n}-check.png`);
      // Everything this round needs from GIMP, in one turn; the critic works outside it.
      const drawn = await gimp.exclusive(async () => {
        const built = await drawSlide(run, gimp, slide, prepared);
        if (hands.length) await new SlideDesigner(run, gimp, slide, plan, run.styleNotes ?? '', 'edit').work(hands, 'owner');
        await gimp.perceptualBlending();
        const snapshot = await gimp.snapshot();
        await gimp.saveXcf(xcf);
        // Measured first: geometry the code can check never reaches the critic.
        const measured = await lintSlide(gimp, built, slide);
        const faces = !measured.length && !!prepared.photo && !!slide.faces?.length;
        if (faces) await gimp.exportPng(check);
        return { built, snapshot, measured, faces };
      });
      built = drawn.built;
      snapshot = drawn.snapshot;
      const { measured } = drawn;
      run.emit('status', 'designer', `Built from the "${built.layout}" template${built.split ? (built.textBand === 'top' ? ' (text above, photo below)' : ' (photo above, text below)') : ''}.`, { slide: slide.n, data: { shape: built.shape } });
      const snapFile = `s${slide.n}-${Date.now()}.png`;
      await writeFile(path.join(snapsDir, snapFile), Buffer.from(snapshot, 'base64'));
      run.emit('snapshot', 'designer', `Round ${round + 1}`, { slide: slide.n, data: { url: `/files/${run.id}/snaps/${snapFile}` } });

      let review: Review;
      if (measured.length) {
        review = { approved: false, score: 0, checks: {} as Review['checks'], issues: measured.map((m) => `measured: ${m}`), fixes: [], templateIssues: [] };
        run.emit('review', 'critic', `Rejected by measurement: ${measured.join('; ')}`, { slide: slide.n, data: review });
      } else {
        const covered = drawn.faces ? (await faceChanges(check, prepared.photo!.path, slide)).filter((f) => f.diff > 0.12) : [];
        review = await reviewSlide(run, plan, slide, snapshot, approved, owner, covered, run.styleNotes ?? '');
        run.emit(
          'review',
          'critic',
          review.approved ? `All checks passed (${review.score}/10)` : `Rejected (${review.score}/10). ${review.issues.join('; ')}${review.fixes.length ? ` → ${describeRequests(review.fixes)}` : ''}`,
          { slide: slide.n, data: review },
        );
        noteTemplateIssues(run, slide.n, review.templateIssues, templateIssues);
      }
      // Approved first, then clean geometry, then the critic's score, then fewer problems.
      const rank = (review.approved ? 1000 : 0) + (measured.length ? 0 : 100) + review.score * 10 - review.issues.length;
      const bestSoFar = Math.max(...rounds.map((r) => r.rank));
      rounds.push({ xcf, state: stateOf(slide), built, snapshot, rank, approved: review.approved, measured });
      if (review.approved) break;
      // A fix that didn't beat the best round rarely does on the next try: stop paying for rounds.
      if (rounds.length > 1 && rank <= bestSoFar) {
        run.emit('status', 'system', 'The fix did not improve the slide: no more rounds.', { slide: slide.n });
        break;
      }
      // Only template issues left: another round would change nothing.
      if (!measured.length && !review.fixes.length) {
        run.emit('status', 'system', 'Nothing in the template fixes what the critic found: no more rounds.', { slide: slide.n });
        break;
      }
      issues = review.issues;
      requests = review.fixes;
      from = 'critic';
    } catch (error) {
      // A failed round (a model, GIMP or SAM error) falls back to the best round so far.
      if (run.stopRequested || !rounds.length) throw error;
      run.emit('status', 'system', `Round ${round + 1} failed (${(error as Error).message}); keeping the best round so far.`, { slide: slide.n });
      break;
    }
  }

  const best = rounds.reduce((a, b) => (b.rank > a.rank ? b : a));
  if (best !== rounds[rounds.length - 1]) {
    Object.assign(slide, best.state);
    run.emit('status', 'system', `Keeping round ${rounds.indexOf(best) + 1}, the best one.`, { slide: slide.n });
  }
  const file = `slide-${slide.n}.png`;
  // Other slides used GIMP since this round: the kept round is reopened from its XCF.
  await gimp.exclusive(async () => {
    await gimp.openXcf(best.xcf);
    await gimp.exportPng(path.join(run.dir, file));
    await gimp.saveXcf(xcfPath(run, slide.n));
  });
  const entry = { n: slide.n, file, approved: best.approved, rounds: rounds.length, templateIssues };
  run.slides = [...run.slides.filter((s) => s.n !== slide.n), entry].sort((a, b) => a.n - b.n);
  run.syncCost();
  run.emit('slide', 'system', `${best.approved ? 'Slide approved' : 'Slide kept after max revisions'} · US$${run.cost.toFixed(2)} so far`, {
    slide: slide.n,
    data: { url: `/files/${run.id}/${file}?v=${Date.now()}`, approved: best.approved, templateIssues },
  });
  return { snapshot: best.snapshot, built: best.built, measured: best.measured };
}

async function slideThumb(file: string): Promise<string> {
  return (await sharp(file).resize(768, 768, { fit: 'inside' }).png().toBuffer()).toString('base64');
}

// A problem no action of the contract fixes: told once, kept with the slide for the
// final report, never sent around the loop.
function noteTemplateIssues(run: Run, n: number, found: string[], into: string[]): void {
  for (const issue of found) {
    if (into.includes(issue)) continue;
    into.push(issue);
    run.emit('status', 'critic', `Template issue, not for the designer: ${issue}`, { slide: n });
  }
}

function describeFix(fix: Fix): string {
  return [fix.note || 'Adjusting the template.', fix.applied.length ? `Done: ${fix.applied.join(', ')}.` : '', fix.byCode.length ? `(${fix.byCode.join(', ')} applied by code: the designer had skipped them.)` : '']
    .filter(Boolean)
    .join(' ');
}

// Designer ⇄ critic rounds on the slide open in GIMP, then PNG + XCF export
// (slides made before the templates, edited by hand).
async function designAndReview(
  run: Run,
  gimp: Gimp,
  plan: Plan,
  slide: SlidePlan,
  designer: SlideDesigner,
  approved: string[],
  ownerFeedback: string[] = [],
  opts: { prebuilt?: boolean; system?: string; extraRounds?: number } = {},
): Promise<{ snapshot: string; note: string }> {
  const snapsDir = path.join(run.dir, 'snaps');
  await mkdir(snapsDir, { recursive: true });
  let fixes: string[] | undefined = ownerFeedback.length ? ownerFeedback : undefined;
  let from: 'critic' | 'owner' = ownerFeedback.length ? 'owner' : 'critic';
  let accepted = false;
  let note = '';
  let snapshot = '';
  let rounds = 0;
  const maxRounds = config.maxRevisions + (opts.extraRounds ?? 0);
  for (; rounds <= maxRounds; rounds++) {
    // A template slide is looked at as built; the retoucher only works on fixes.
    if (!(opts.prebuilt && rounds === 0)) note = await designer.work(fixes, from);
    await gimp.perceptualBlending();
    snapshot = await gimp.snapshot();
    // Measured, not judged: is any face covered or changed?
    let covered: { box: { x1: number; y1: number; x2: number; y2: number }; diff: number }[] = [];
    const photo = slide.photo ? run.photos.find((p) => p.id === slide.photo) : undefined;
    if (photo && slide.faces?.length) {
      const full = path.join(snapsDir, `s${slide.n}-check.png`);
      await gimp.exportPng(full);
      covered = (await faceChanges(full, photo.path, slide)).filter((f) => f.diff > 0.12);
    }
    const snapFile = `s${slide.n}-${Date.now()}.png`;
    await writeFile(path.join(snapsDir, snapFile), Buffer.from(snapshot, 'base64'));
    run.emit('snapshot', 'designer', `Round ${rounds + 1}`, { slide: slide.n, data: { url: `/files/${run.id}/snaps/${snapFile}` } });

    const review = await reviewSlide(run, plan, slide, snapshot, approved, ownerFeedback, covered, opts.system ?? '');
    run.emit('review', 'critic', review.approved ? `All checks passed (${review.score}/10)` : `Rejected (${review.score}/10). ${review.issues.join('; ')}`, { slide: slide.n, data: review });
    if (review.approved) {
      accepted = true;
      break;
    }
    fixes = review.fixes.length ? review.fixes.map((f) => `${f.action}: ${f.why}`) : review.issues;
    from = 'critic';
  }

  const file = `slide-${slide.n}.png`;
  await gimp.exportPng(path.join(run.dir, file));
  await gimp.saveXcf(xcfPath(run, slide.n));
  const entry = { n: slide.n, file, approved: accepted, rounds: Math.min(rounds + 1, config.maxRevisions + 1) };
  run.slides = [...run.slides.filter((s) => s.n !== slide.n), entry].sort((a, b) => a.n - b.n);
  run.syncCost();
  run.emit('slide', 'system', `${accepted ? 'Slide approved' : 'Slide kept after max revisions'} · US$${run.cost.toFixed(2)} so far`, {
    slide: slide.n,
    // Cache-busting version: an edited slide keeps its file name.
    data: { url: `/files/${run.id}/${file}?v=${Date.now()}`, approved: accepted },
  });
  return { snapshot, note };
}

// SAM 3.1 finds the subject and every face (0..1 of the photo) for a full-bleed photo.
async function findSubject(run: Run, slide: SlidePlan, photoPath: string): Promise<void> {
  try {
    if (slide.subject) {
      for (const prompt of samPrompts(slide.subject)) {
        const box = subjectBox(await locate(photoPath, prompt));
        if (box) {
          slide.subjectNorm = { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
          break;
        }
      }
    }
    slide.facesNorm = (await locate(photoPath, 'face')).filter((f) => f.confidence >= 0.5).map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }));
    run.emit('status', 'analyst', `SAM 3.1 found ${slide.subjectNorm ? `the ${slide.subject}` : `no "${slide.subject}"`} and ${slide.facesNorm.length} face(s) on the photo.`, { slide: slide.n });
  } catch (error) {
    run.emit('status', 'analyst', `SAM could not look at the photo: ${(error as Error).message}`, { slide: slide.n });
  }
}

// The critic looks at all the slides side by side; the ones that break the family
// get new settings with its fix, kept only if the rebuilt slide still measures clean.
async function reviewWholeSet(run: Run, gimp: Gimp, plan: Plan, built: Map<number, Built>, measuredBefore = new Map<number, string[]>()): Promise<void> {
  const files = run.slides.map((s) => ({ n: s.n, file: path.join(run.dir, s.file) }));
  const review = await reviewSet(plan, files, run.styleNotes ?? '');
  const sheetFile = path.join(run.dir, 'snaps', `set-${Date.now()}.jpg`);
  await writeFile(sheetFile, review.sheet);
  const describe = (s: (typeof review.slides)[number]) =>
    [s.fixes.length ? describeRequests(s.fixes) : '', s.templateIssues.length ? `template issues: ${s.templateIssues.join('; ')}` : ''].filter(Boolean).join('; ');
  run.emit(
    'review',
    'critic',
    review.slides.length ? `The set (${review.score}/10): ${review.slides.map((s) => `slide ${s.n}: ${describe(s)}`).join('; ')}` : `The set works as one family (${review.score}/10)`,
    { data: { consistent: review.consistent, score: review.score, slides: review.slides, url: run.fileUrl(sheetFile) } },
  );
  for (const s of review.slides) {
    const entry = run.slides.find((k) => k.n === s.n);
    if (entry) noteTemplateIssues(run, s.n, s.templateIssues, (entry.templateIssues ??= []));
  }
  // The slides to adjust go in parallel, like the first pass.
  const results = await Promise.allSettled(
    review.slides.map(async ({ n, fixes }) => {
      const slide = plan.slides.find((s) => s.n === n);
      if (!slide || !fixes.length) return;
      run.emit('status', 'designer', `Adjusting slide ${n} for the set: ${describeRequests(fixes)}`, { slide: n });
      const before = stateOf(slide);
      const file = `slide-${n}.png`;
      let measured: string[];
      try {
        const change = await chooseFix(run, plan, slide, built.get(n), [`For the whole set: ${describeRequests(fixes)}`], fixes, await slideThumb(path.join(run.dir, file)), 'critic');
        slide.tweaks = change.tweaks;
        if (change.photo) slide.photo = change.photo;
        run.emit('thought', 'designer', describeFix(change), { slide: n, data: { tweaks: change.tweaks, photo: change.photo, applied: change.applied, byCode: change.byCode } });
        const prepared = await prepareSlide(run, slide);
        measured = await gimp.exclusive(async () => {
          const rebuilt = await drawSlide(run, gimp, slide, prepared);
          // Only a problem the change brings rejects it: one the slide already had doesn't
          // block the rest of the fix (measures differ, so problems compare by kind).
          const kind = (issue: string) => issue.split(' (')[0];
          const known = new Set((measuredBefore.get(n) ?? []).map(kind));
          const all = await lintSlide(gimp, rebuilt, slide);
          const measured = all.filter((m) => !known.has(kind(m)));
          if (measured.length) return measured;
          measuredBefore.set(n, all);
          built.set(n, rebuilt);
          await gimp.perceptualBlending();
          await gimp.exportPng(path.join(run.dir, file));
          await gimp.saveXcf(xcfPath(run, n));
          return [];
        });
      } catch (error) {
        Object.assign(slide, before);
        throw error;
      }
      if (measured.length) {
        Object.assign(slide, before);
        run.emit('status', 'designer', `Slide ${n} stays as it was: the change broke it (${measured.join('; ')}).`, { slide: n });
        return;
      }
      run.emit('slide', 'system', `Slide ${n} adjusted for the set`, {
        slide: n,
        data: { url: `/files/${run.id}/${file}?v=${Date.now()}`, approved: run.slides.find((s) => s.n === n)?.approved ?? false },
      });
    }),
  );
  // A slide whose adjustment failed keeps its approved version; only a stop ends the run.
  if (run.stopRequested) throw new Error('Stopped by the owner.');
  for (const r of results) if (r.status === 'rejected') run.emit('status', 'system', `An adjustment failed (${(r.reason as Error).message}); that slide stays as it was.`);
}

function xcfPath(run: Run, n: number): string {
  return path.join(run.dir, `slide-${n}.xcf`);
}

// HyperFrames: each approved slide becomes a seamless animated card. GIMP only
// exports the layers; then the motion designer, the build and the critic loop.
// With cards false, only the reel is made: the card videos already rendered stay.
export async function animateCarousel(run: Run, { cards: makeCards = true } = {}): Promise<void> {
  const plan = run.plan;
  if (!plan) throw new Error('No carousel to animate');
  run.status = 'running';
  const base = spentUsd() - run.cost;
  const sync = () => {
    run.cost = spentUsd() - base;
  };
  const dir = path.join(run.dir, 'motion');
  const layersBySlide = new Map<number, LayerInfo[]>();
  await withGimp(run, async (gimp) => {
    for (const s of run.slides) {
      run.emit('status', 'motion', `Exporting the layers of slide ${s.n} from GIMP…`, { slide: s.n });
      await gimp.openXcf(xcfPath(run, s.n));
      // Slides made before perceptual blending: re-export so the PNG and the card match.
      await gimp.perceptualBlending();
      await gimp.exportPng(path.join(run.dir, s.file));
      await gimp.saveXcf(xcfPath(run, s.n));
      const out = path.join(run.dir, 'layers', `s${s.n}`);
      await mkdir(out, { recursive: true });
      layersBySlide.set(s.n, await gimp.exportLayers(out));
    }
    await gimp.closeAll();
  });
  if ((run.status as Run['status']) === 'failed') return;
  run.syncCost = sync;

  try {
    const cards: Card[] = [];
    for (const s of makeCards ? run.slides : []) {
      const slide = plan.slides.find((p) => p.n === s.n)!;
      const layers = layersBySlide.get(s.n) ?? [];
      const slidePng = path.join(run.dir, s.file);
      const designer = new MotionDesigner(plan, slide, layers, slidePng);
      let fixes: string[] | undefined;
      let card: Card | undefined;
      for (let round = 0; round <= config.maxRevisions; round++) {
        let motion = await designer.choreograph(fixes);
        // Rules the code can measure go back to the designer before anything renders.
        for (let i = 0; i < 2; i++) {
          const problems = validateMotion(motion, layers);
          if (!problems.length) break;
          run.emit('status', 'motion', `Fixing the choreography: ${problems.join('; ')}`, { slide: s.n });
          motion = await designer.choreograph(problems);
        }
        run.emit('thought', 'motion', motion.notes ?? 'Choreography ready', { slide: s.n, data: { motion } });
        card = { n: s.n, layers, motion };
        await writeCard(dir, card);
        await writeIndex(dir, [...cards, card]);
        const checked = await check(dir);
        if (checked.errors.length) run.emit('status', 'motion', `hyperframes check: ${checked.errors.join('; ')}`, { slide: s.n });

        const video = path.join(dir, 'renders', `card-${s.n}.mp4`);
        run.emit('status', 'motion', `Rendering card ${s.n} with HyperFrames…`, { slide: s.n });
        await renderCard(dir, card, video);
        const seen = await inspect(video, motion, slidePng, path.join(dir, 'frames', `c${s.n}-r${round}`));
        const review = await reviewMotion(slide, slidePng, seen.frames, seen, motion.notes ?? '');
        run.emit('review', 'critic', review.approved ? `Motion approved (${review.score}/10)` : `Motion rejected (${review.score}/10). ${review.issues.join('; ')}`, {
          slide: s.n,
          data: { ...review, measured: { rest: seen.restVsSlide, loop: seen.loop }, url: run.fileUrl(seen.frames[3].file) },
        });
        if (review.approved || round === config.maxRevisions) {
          run.emit('video', 'motion', review.approved ? 'Card approved' : 'Card kept after max revisions', {
            slide: s.n,
            data: { url: `${run.fileUrl(video)}?v=${Date.now()}`, approved: review.approved },
          });
          break;
        }
        fixes = review.fixes.length ? review.fixes : review.issues;
      }
      if (card) cards.push(card);
    }
    if (makeCards) await writeIndex(dir, cards);
    const reel = await makeReel(run, plan, layersBySlide);
    run.status = 'done';
    sync();
    const videos = run.slides.map((s) => path.join(dir, 'renders', `card-${s.n}.mp4`)).filter((f) => existsSync(f));
    run.emit('done', 'system', `${makeCards ? 'Animated carousel and 30 s reel' : '30 s reel'} ready · US$${run.cost.toFixed(2)}`, {
      data: { caption: plan.caption, hashtags: plan.hashtags, cost: run.cost, videos: videos.map((f) => run.fileUrl(f)), reel: `${run.fileUrl(reel)}?v=${Date.now()}` },
    });
  } catch (error) {
    run.status = 'failed';
    run.emit('error', 'system', (error as Error).message);
  }
}

// The 30 s reel (docs/REEL_STANDARD.md): the reel director picks the shots from the
// presets, the code checks the rules, HyperFrames renders and the reel critic reviews frames.
async function makeReel(run: Run, plan: Plan, layersBySlide: Map<number, LayerInfo[]>): Promise<string> {
  const motionDir = path.join(run.dir, 'motion');
  const dir = path.join(motionDir, 'reel');
  const video = path.join(motionDir, 'renders', 'reel.mp4');
  const look = readLook(run, [...layersBySlide.values()]);
  const recentHooks = recentLooks(run.id)
    .map((l) => l.hook)
    .filter((h): h is string => !!h);
  const director = new ReelDirector(
    run,
    plan,
    run.slides.map((s) => path.join(run.dir, s.file)),
    recentHooks,
  );
  run.emit('status', 'motion', 'Planning the 30 s reel…');
  let fixes: string[] | undefined;
  let sound: Sound | undefined;
  for (let round = 0; round <= config.maxRevisions; round++) {
    let spec = await director.shots(fixes);
    // The music is chosen once, from the first plan: later rounds keep its beat.
    if (!sound) {
      const brief = spec.music ?? { genres: [], query: 'upbeat loop', energy: 'medium' as const };
      run.emit('status', 'motion', `Looking for music: ${[...(brief.genres ?? []), brief.mood].filter(Boolean).join(', ') || brief.query} (${brief.energy})…`);
      const [music, sfx] = await Promise.all([
        findMusic({ ...brief, query: brief.query ?? brief.mood ?? 'upbeat loop' }, path.join(dir, 'audio'), run.id).catch(() => undefined),
        findSfx(path.join(config.runsDir, '..', 'cache', 'sfx')).catch(() => ({})),
      ]);
      sound = { music, sfx };
      run.emit('status', 'motion', music ? `Music: ${music.credit}, ${music.bpm} BPM. The cuts land on its beat.` : 'No music found: the reel stays silent.');
    }
    // The code fits the reading time; the director only gets back what takes judgment.
    for (let i = 0; i < 2; i++) {
      fitBeats(spec);
      const problems = validateReel(spec, run, plan, recentHooks);
      if (!problems.length) break;
      run.emit('status', 'motion', `Fixing the shot list: ${problems.join('; ')}`);
      spec = await director.shots(problems);
    }
    fitBeats(spec);
    // Whatever the director could not fix and would break the render is repaired in code.
    const repaired = repairReel(spec, run, recentHooks);
    if (repaired.length) run.emit('status', 'motion', `Repaired in code: ${repaired.join('; ')}`);
    run.emit('thought', 'motion', spec.notes ?? 'Shot list ready', { data: { reel: spec } });

    const shots = await writeReel(dir, run, plan, spec, look, sound);
    const checked = await check(dir);
    if (checked.errors.length) run.emit('status', 'motion', `hyperframes check: ${checked.errors.join('; ')}`);
    run.emit('status', 'motion', `Rendering the 30 s reel (${shots.length} shots) with HyperFrames…`);
    await renderReel(dir, video);
    const seen = await inspectReel(video, shots, path.join(dir, 'frames', `r${round}`));
    const review = await reviewReel(run, shots, seen.frames, seen);
    run.emit('review', 'critic', review.approved ? `Reel approved (${review.score}/10)` : `Reel rejected (${review.score}/10). ${review.issues.join('; ')}`, {
      data: { ...review, measured: { length: seen.duration, stillEnd: seen.stillEnd }, url: run.fileUrl(seen.frames[0].file) },
    });
    // Each render costs minutes and a second one rarely scores much higher: only a
    // reel that is really off gets another round.
    const lastRound = round === config.maxRevisions || review.score >= config.reelRetryBelow;
    if (review.approved || lastRound) {
      // The cover is frame 0: the hook with its headline.
      await promisify(execFile)('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-frames:v', '1', path.join(motionDir, 'renders', 'reel-cover.png')]);
      await writeReelDocs(motionDir, plan, shots, look, review, seen, spec.notes ?? '', sound?.music?.credit);
      run.emit('video', 'motion', review.approved ? 'Reel approved' : round === config.maxRevisions ? 'Reel kept after max revisions' : `Reel kept (${review.score}/10): another render would not pay off`, {
        data: { reel: true, url: `${run.fileUrl(video)}?v=${Date.now()}`, approved: review.approved, music: sound?.music?.credit },
      });
      return video;
    }
    fixes = review.fixes.length ? review.fixes : review.issues;
  }
  return video;
}
