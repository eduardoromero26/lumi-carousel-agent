import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { HTML_DESIGNER } from './agents/prompts.js';
import { config, SLIDE } from './config.js';
import { chat, imagePart, type ContentPart } from './llm.js';
import type { Plan, Run, SlidePlan } from './run.js';

const exec = promisify(execFile);

export type HtmlInput = {
  run: Run;
  plan: Plan;
  slide: SlidePlan;
  // The reference to imitate, and the brand's own material.
  reference: string;
  photo?: { path: string; cutout?: boolean; note?: string };
  logo?: string;
  colors: string[];
  // What the critic said about the last attempt, to fix in this one.
  critique?: string;
  // The carousel's master slide, already designed: this one keeps its system.
  master?: string;
};

const jpeg = async (file: string, size: number) => (await sharp(file).rotate().resize(size, size, { fit: 'inside' }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer()).toString('base64');

// The designer recreates the reference as an HTML page with the brand's photo, logo, words
// and colors, and a headless browser renders it to the slide's PNG: every object the
// reference has (stickers, badges, panels, tilted labels) can be drawn, not only the few a
// template knows. Undefined when there is no browser or the model gives no page.
export async function designHtmlSlide(input: HtmlInput): Promise<{ png: string; html: string } | undefined> {
  const { run, plan, slide } = input;
  const browser = config.browser.find((p) => existsSync(p));
  if (!browser) return undefined;
  const dir = path.join(run.dir, 'html', `s${slide.n}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  let photoName = '';
  if (input.photo) {
    photoName = `photo${path.extname(input.photo.path).toLowerCase() || '.png'}`;
    await copyFile(input.photo.path, path.join(dir, photoName));
    files.push(`${photoName}: the brand's photo for this slide${input.photo.cutout ? ' (a cutout on a transparent background: stand it on the design, with a soft shadow if the reference has one)' : ''}${input.photo.note ? ` — ${input.photo.note}` : ''}`);
  }
  if (input.logo) {
    await copyFile(input.logo, path.join(dir, 'logo.png'));
    files.push("logo.png: the brand's logo (keep its proportions; where the reference has its logo)");
  }
  const texts = [
    slide.eyebrow ? `label: "${slide.eyebrow}"` : '',
    `headline: "${slide.headline}"`,
    slide.body ? `text: "${slide.body}"` : '',
    slide.button ? `button: "${slide.button}"` : '',
  ].filter(Boolean);
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        `Brand: ${run.site?.title ?? run.brief.url ?? ''} (${plan.business_type ?? 'business'}). Slide ${slide.n} of ${plan.slides.length} (${slide.role}${slide.layout ? `, ${slide.layout}` : ''}).`,
        `The words of this slide, exactly (never the reference's words, prices or brand): ${texts.join('; ')}.`,
        `The brand's colors: ${input.colors.join(', ') || 'take them from the logo'}.`,
        `Files you can use: ${files.join('; ') || 'none (a type-only slide)'}.`,
        input.master ? `The carousel's master slide, already designed (keep its system on this slide: the same fonts, colors, panels and sticker style, with this slide's own photo and words):
${input.master.slice(0, 7000)}` : '',
        input.critique ? `The art director rejected your last version of this slide: ${input.critique}. Fix that, staying close to the reference.` : '',
        'The reference to recreate:',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    imagePart(await jpeg(input.reference, 900), 'image/jpeg'),
  ];
  if (input.photo) parts.push({ type: 'text', text: `${photoName}:` }, imagePart(await jpeg(input.photo.path, 640), 'image/jpeg'));
  if (input.logo) parts.push({ type: 'text', text: 'logo.png:' }, imagePart(await jpeg(input.logo, 320), 'image/jpeg'));
  const answer = await chat([
    { role: 'system', content: HTML_DESIGNER },
    { role: 'user', content: parts },
  ]);
  const raw = answer.content ?? '';
  const html = (raw.match(/```(?:html)?\s*([\s\S]*?)```/)?.[1] ?? raw).trim();
  if (!/<html|<body|<div/i.test(html)) return undefined;
  const page = path.join(dir, 'index.html');
  await writeFile(page, html);
  const png = path.join(dir, 'slide.png');
  const args = [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--allow-file-access-from-files',
    `--user-data-dir=${path.join(run.dir, 'html', 'profile')}`,
    `--window-size=${SLIDE.width},${SLIDE.height}`,
    '--virtual-time-budget=6000',
    `--screenshot=${png}`,
    pathToFileURL(page).href,
  ];
  await exec(browser, args, { timeout: 60000 }).catch(() => undefined);
  return existsSync(png) ? { png, html } : undefined;
}
