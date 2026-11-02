import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { describeSystem, normalizeSystem, type Decor, type DesignSystem } from '../design.js';
import { installFont, onGoogleFonts } from '../fonts.js';
import type { Gimp } from '../gimp.js';
import { chatJson, imagePart, type ContentPart } from '../llm.js';
import { generateAsset } from '../muse_image.js';
import type { Plan, Run } from '../run.js';
import { describeDirections, recentLooks, taste, tasteCorrections } from '../db.js';
import { describeTaste } from '../taste.js';
import { brandKit, describeDecorTaste, keep, likedPiece } from '../library.js';
import { applyReference, describeReference, reference, referenceUrl as referenceUrlOf } from '../references.js';
import { describeFonts, describeLooks, freshen, hostOf } from '../variety.js';
import { ART_DIRECTOR } from './prompts.js';

// One visual system for the whole carousel, decided before any slide is built,
// with its fonts installed in GIMP.
export async function designSystem(run: Run, plan: Plan, gimp: Gimp): Promise<DesignSystem> {
  const siteFonts = run.site?.fonts ?? [];
  const onGoogle = (await Promise.all(siteFonts.map(async (f) => ((await onGoogleFonts(f)) ? f : undefined)))).filter(Boolean) as string[];
  const recent = recentLooks(run.id);
  const stats = taste();
  const liked = describeTaste(stats, ['composition', 'personality', 'heading font', 'body font', 'device', 'logo', 'align', 'case', 'ground', 'decor', 'type', 'color slides', 'numbers']);
  const corrections = tasteCorrections();
  const decorTaste = describeDecorTaste(hostOf(run.brief.url));
  const ref = reference(run.brief.reference);
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        `Business: ${run.site?.title ?? run.brief.url ?? ''} (${plan.business_type ?? 'business'}); carousel format: ${plan.format ?? 'benefits'}.`,
        `Concept: ${plan.concept}`,
        `Brand colors found: ${run.brief.brandColors?.join(', ') || 'none'}.`,
        `Fonts the website uses: ${siteFonts.join(', ') || 'none found'}. Of those, on Google Fonts (installable): ${onGoogle.join(', ') || 'none'}.`,
        `If none fits, the personality families and their fonts:\n${describeFonts()}`,
        liked ? `The owner's votes on past carousels (follow them where this brand allows): ${liked}` : '',
        corrections ? `The owner said these conclusions from the votes were learned wrong (do not apply them; their words):\n${corrections}` : '',
        describeDirections(),
        decorTaste,
        ref ? describeReference(ref) : '',
        recent.length && !ref ? `The agency's last carousels for other brands (composition, headlines / text, device, logo, alignment, case):\n${describeLooks(recent)}` : '',
        `Slides: ${plan.slides.map((s) => `${s.n} ${s.layout ?? s.role}${s.photo ? ' (photo)' : ''}`).join('; ')}.`,
        plan.slides[0]?.eyebrow ? 'The cover has a short label above its headline (the other slides have none).' : 'No slide has a label above the headline: "pill_label" is not an option.',
        `Language of the slides: ${run.brief.language ?? 'English'}.`,
        run.logo ? 'The logo:' : 'There is no logo.',
      ].join('\n'),
    },
  ];
  if (run.logo) parts.push(imagePart(await thumb(run.logo.path, 320), 'image/jpeg'));
  if (ref) {
    parts.push({ type: 'text', text: 'The reference the owner chose for the style (its style only):' });
    parts.push(imagePart(await thumb(ref.file, 768), 'image/jpeg'));
  }
  // How the brand designs: its own website, as a visitor sees it.
  for (const shot of run.site?.screens ?? []) {
    parts.push({ type: 'text', text: `The website on a ${shot.includes('phone') ? 'phone' : 'computer'} (the top of the page):` });
    parts.push(imagePart(await top(shot), 'image/jpeg'));
  }
  // The brand's own banners are its own ads: the closest thing to how it designs.
  const banners = run.assets
    .filter((a) => a.source !== 'upload' && a.kind === 'banner' && Math.min(a.width, a.height) >= 250)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 2);
  if (banners.length) {
    parts.push({
      type: 'text',
      text: "The brand's own banners from its website (its own ads): take their design language (grounds, shapes, how heavy the type is, how offers and prices are shown), never their words or a copy of their layout:",
    });
    for (const b of banners) parts.push(imagePart(await thumb(b.path, 768), 'image/jpeg'));
  }
  const photos = plan.slides.map((s) => run.photos.find((p) => p.id === s.photo)).filter(Boolean).slice(0, 3);
  if (photos.length) {
    parts.push({ type: 'text', text: 'Some of the photos the slides use:' });
    for (const p of photos) parts.push(imagePart(await thumb(p!.path, 384), 'image/jpeg'));
  }
  const ask = (model: string) =>
    chatJson<Partial<DesignSystem>>(
      [
        { role: 'system', content: ART_DIRECTOR },
        { role: 'user', content: parts },
      ],
      model,
    );
  run.emit('status', 'designer', `Art direction with ${config.artModelId}: the visual system and its decor kit…`);
  const raw = await ask(config.artModelId).catch((error: Error) => {
    if (config.artModelId === config.modelId) throw error;
    run.emit('status', 'designer', `${config.artModelId} failed (${error.message.slice(0, 120)}); art direction with ${config.modelId}.`);
    return ask(config.modelId);
  });
  const system = normalizeSystem(raw, run.brief.brandColors ?? []);
  const changes = freshen(system, onGoogle, recent, !!plan.slides[0]?.eyebrow, stats);
  if (changes.length && !ref) run.emit('status', 'designer', `So it doesn't look like the last brands: ${changes.join('; ')}.`);
  if (ref) {
    const followed = applyReference(system, plan, ref);
    run.emit('status', 'designer', `In the style of the reference "${ref.title}"${followed.length ? `: ${followed.join('; ')}` : ''}.`, { data: { url: referenceUrlOf(ref) } });
  }
  if (system.decor) await makeDecor(run, system.decor, { type: plan.business_type, personality: system.personality });

  // Fonts that can't be installed fall back to Montserrat, so the system still holds.
  for (const role of ['heading', 'body'] as const) {
    const family = role === 'heading' ? system.headingFont : system.bodyFont;
    if (!(await onGoogleFonts(family))) {
      if (role === 'heading') system.headingFont = 'Montserrat';
      else system.bodyFont = 'Montserrat';
    }
  }
  // Display faces like Anton or Bebas Neue only come in 400.
  const heading = await installFont(gimp, system.headingFont, [system.headingWeight, 700, 400]);
  const body = system.bodyFont === system.headingFont ? heading : await installFont(gimp, system.bodyFont, [system.bodyWeight, 700]);
  const bodyWeights = system.bodyFont === system.headingFont ? await installFont(gimp, system.bodyFont, [system.bodyWeight]) : body;
  if (!heading[system.headingWeight]) system.headingWeight = heading[700] ? 700 : 400;
  system.gimpHeading = heading[system.headingWeight];
  system.gimpBody = bodyWeights[system.bodyWeight] ?? body[system.bodyWeight];
  system.gimpBodyBold = body[700] ?? system.gimpHeading;
  if (system.layout) system.layoutFonts = await layoutFonts(gimp, system);
  run.emit('thought', 'designer', `Visual system for every slide: ${describeSystem(system)}`, { data: { system, screens: (run.site?.screens ?? []).map((s) => run.fileUrl(s)) } });
  return system;
}

// A serif and a sans in light, regular and bold for a reference layout: the brand's own when
// they are of that kind, else a classic one. A family that fails stays out.
const SERIF = /serif|garamond|bodoni|caslon|playfair|fraunces|lora|merriweather|baskerville|cormorant|marcellus|cardo|bitter|alegreya|cinzel|prata|spectral|crimson|libre|domine|vollkorn|zilla|young/i;
async function layoutFonts(gimp: Gimp, system: DesignSystem): Promise<NonNullable<DesignSystem['layoutFonts']>> {
  const blocks = system.layout?.blocks ?? [];
  // Only the weights the plan uses (every download refreshes GIMP's fonts); 400 is the fallback.
  const weights = (font: 'serif' | 'sans') => [...new Set([400, ...blocks.filter((b) => b.font === font).map((b) => ({ light: 300, regular: 400, bold: 700 })[b.weight]), ...(blocks.some((b) => b.font === font && b.emphasis === 'bold') ? [700] : [])])];
  const install = (family: string, font: 'serif' | 'sans') => installFont(gimp, family, weights(font)).catch(() => ({}) as Record<number, string>);
  const serif = SERIF.test(system.headingFont) ? system.headingFont : SERIF.test(system.bodyFont) ? system.bodyFont : 'Cormorant Garamond';
  const sans = !SERIF.test(system.bodyFont) ? system.bodyFont : !SERIF.test(system.headingFont) ? system.headingFont : 'Montserrat';
  let serifSet = blocks.some((b) => b.font === 'serif') ? await install(serif, 'serif') : {};
  // A light serif title needs a family that has a light weight.
  if (!serifSet[300] && blocks.some((b) => b.font === 'serif' && b.weight === 'light')) serifSet = await install('Cormorant Garamond', 'serif');
  return { serif: serifSet, sans: blocks.some((b) => b.font === 'sans') ? await install(sans, 'sans') : {} };
}

// The decor kit, once for every slide: the brand's own liked piece first, then one the
// art director took from the library, else generated and kept there. A piece that fails is left out.
async function makeDecor(run: Run, decor: Decor, extra: { type?: string; personality?: string }): Promise<void> {
  const host = hostOf(run.brief.url);
  const asked = decor.reuse ?? {};
  decor.reuse = {};
  await Promise.all(
    (['texture', 'element'] as const).map(async (kind) => {
      const from = brandKit(host, kind) ?? (asked[kind] ? likedPiece(asked[kind]!, kind) : undefined);
      let file: string | undefined;
      if (from) {
        file = path.join(run.dir, 'generated', `${kind}-library-${from.id}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await copyFile(from.file, file);
        decor[kind] = from.prompt;
        decor.reuse![kind] = from.id;
        run.emit('status', 'designer', `Decor kit ${kind} from the library (${from.host === host ? "this brand's, which you liked" : `liked on ${from.business}`}): ${from.prompt}`, { data: { url: run.fileUrl(file) } });
      } else if (decor[kind]) {
        try {
          file = await generateAsset(run, decor[kind]!, kind);
          await keep(run, kind, decor[kind]!, file, extra);
          run.emit('status', 'designer', `Decor kit ${kind} with Muse Image: ${decor[kind]}`, { data: { url: run.fileUrl(file) } });
        } catch (error) {
          run.emit('status', 'designer', `No decor ${kind} (${(error as Error).message.slice(0, 120)}): the slides go without it.`);
        }
      }
      if (kind === 'texture') decor.textureFile = file;
      else decor.elementFile = file;
    }),
  );
}

// The first screen and a half of a page screenshot, small enough for the model.
async function top(file: string): Promise<string> {
  const { width = 1, height = 1 } = await sharp(file).metadata();
  const buffer = await sharp(file).extract({ left: 0, top: 0, width, height: Math.min(height, Math.round(width * 1.4)) }).resize(900, 1260, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
  return buffer.toString('base64');
}

async function thumb(file: string, size: number): Promise<string> {
  const buffer = await sharp(await readFile(file)).flatten({ background: '#9a9a9a' }).resize(size, size, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  return buffer.toString('base64');
}
