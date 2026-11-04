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

// The designer writes the page blind: before the screenshot, the page itself shrinks any
// text that overflows its box, runs off the slide or lands on another text.
const FIT = `<style>*{overflow-wrap:anywhere;hyphens:auto}</style><script>
(function(){
  var W=${SLIDE.width},H=${SLIDE.height},M=24;
  function leaves(){return Array.prototype.filter.call(document.body.querySelectorAll('*'),function(e){
    if(['SCRIPT','STYLE','IMG','SVG','svg','PATH','path'].indexOf(e.tagName)>=0)return false;
    for(var i=0;i<e.childNodes.length;i++){var c=e.childNodes[i];if(c.nodeType===3&&c.textContent.trim())return true;}
    return false;});}
  function size(e){return parseFloat(getComputedStyle(e).fontSize)||16;}
  function shrink(e){var s=size(e);if(e.__min===undefined)e.__min=s*0.5;if(s*0.93<e.__min)return false;e.style.fontSize=(s*0.93)+'px';e.style.lineHeight='1.08';return true;}
  function bad(e){var r=e.getBoundingClientRect();if(!r.width)return false;
    if(e.scrollWidth>e.clientWidth+2&&getComputedStyle(e).overflowX!=='visible')return true;
    if(e.scrollWidth>e.clientWidth+2&&e.clientWidth>0&&getComputedStyle(e).whiteSpace==='nowrap')return true;
    return r.left<M-4||r.right>W-M+4||r.bottom>H-M+4||r.top<M-4&&r.height<H/2;}
  function hit(a,b){var p=a.getBoundingClientRect(),q=b.getBoundingClientRect();
    return p.width&&q.width&&!a.contains(b)&&!b.contains(a)&&p.left<q.right-2&&q.left<p.right-2&&p.top<q.bottom-2&&q.top<p.bottom-2;}
  function textRange(e){var r=document.createRange();r.selectNodeContents(e);var b=r.getBoundingClientRect();return b;}
  function spill(e){var t=textRange(e),r=e.getBoundingClientRect();return t.right>r.right+3||t.bottom>r.bottom+3&&getComputedStyle(e).height!=='auto';}
  for(var pass=0;pass<40;pass++){var changed=false,all=leaves();
    for(var i=0;i<all.length;i++){var e=all[i];if(bad(e)||spill(e)){changed=shrink(e)||changed;}}
    for(var i=0;i<all.length;i++)for(var j=i+1;j<all.length;j++){if(hit(all[i],all[j])){var a=size(all[i])>=size(all[j])?all[i]:all[j];changed=shrink(a)||changed;}}
    if(!changed)break;}
})();
</script>`;

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
  // The art director's decor kit from Muse Image, paid once per carousel.
  decor?: { backdrop?: string; texture?: string; element?: string };
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
    files.push("logo.png: the brand's logo, on this slide always (keep its proportions; where the reference has its logo, else a clean corner)");
  }
  // The decor kit: optional, where the reference has that kind of ground or object.
  const kit: [keyof NonNullable<HtmlInput['decor']>, string][] = [
    ['backdrop', 'a scene the art director generated for this carousel: the ground of a slide without a photo, or the set a cut-out product stands in; softened so the text reads'],
    ['texture', "a texture of the brand's world: on a ground or a panel where the reference has a textured or plain area, faint so the text reads"],
    ['element', 'a decorative object on a transparent background: once, where the reference has a decorative object, small, never over the text, the logo or a face'],
  ];
  const decor: [string, string][] = [];
  for (const [key, use] of kit) {
    const file = input.decor?.[key];
    if (!file || !existsSync(file)) continue;
    await copyFile(file, path.join(dir, `${key}.png`));
    files.push(`${key}.png (optional, never the main photo): ${use}`);
    decor.push([`${key}.png`, file]);
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
  for (const [name, file] of decor) parts.push({ type: 'text', text: `${name}:` }, imagePart(await jpeg(file, 256), 'image/jpeg'));
  const answer = await chat([
    { role: 'system', content: HTML_DESIGNER },
    { role: 'user', content: parts },
  ]);
  const raw = answer.content ?? '';
  const html = (raw.match(/```(?:html)?\s*([\s\S]*?)```/)?.[1] ?? raw).trim();
  if (!/<html|<body|<div/i.test(html)) return undefined;
  const page = path.join(dir, 'index.html');
  await writeFile(page, /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${FIT}</body>`) : `${html}${FIT}`);
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
