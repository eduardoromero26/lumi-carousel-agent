import * as cheerio from 'cheerio';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { config } from './config.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Asset, Run } from './run.js';

const exec = promisify(execFile);
const MAX_TEXT = 6000;
const MAX_ASSETS = 30;
// Below this nothing is usable, not even a favicon-sized logo.
const MIN_SIDE = 48;
// Virtual time the browser gives the page's JavaScript before reading it: sites built
// as apps (Nuxt, React…) serve an empty page and paint everything afterwards.
const RENDER_BUDGET_MS = 10000;

// fonts: the families the site's CSS uses, most used first; screens: screenshots of
// the page (desktop and phone), how the brand designs.
export type Site = { url: string; title: string; text: string; fonts?: string[]; screens?: string[] };

type Candidate = { src: string; fallback?: string; alt: string; hint: string; context?: string };

// Reads the business website: its text becomes facts the director may use and
// every image asset (logos, icons, photos, CSS backgrounds) is downloaded for
// the analyst to classify.
export async function readSite(run: Run, url: string): Promise<Site> {
  const served = await (await get(url)).text();
  // The page as a visitor sees it, when it says more than the code the server sent.
  const rendered = await renderedHtml(run, url);
  const html = rendered && bodyText(rendered) > bodyText(served) ? rendered : served;
  const $ = cheerio.load(html);
  const meta = (name: string) => $(`meta[property="${name}"], meta[name="${name}"]`).attr('content')?.trim() ?? '';

  const candidates = new Map<string, Candidate>();
  const add = (src: string | undefined, alt = '', hint = '', context = '') => {
    if (!src || src.startsWith('data:') || src.startsWith('#')) return;
    try {
      const abs = new URL(src, url).href;
      const full = fullSize(abs);
      // Several thumbnails of one image share the same original.
      const known = candidates.get(full);
      if (!known) candidates.set(full, { src: full, fallback: full !== abs ? abs : undefined, alt: alt.trim(), hint, context: context || undefined });
      else if (context && !known.context) known.context = context;
    } catch {
      // Malformed URL: skip it.
    }
  };

  // Logos first: they are few and the most valuable.
  $('img').each((_, el) => {
    const img = $(el);
    const label = `${img.attr('alt') ?? ''} ${img.attr('class') ?? ''} ${img.attr('id') ?? ''} ${img.attr('src') ?? ''}`;
    if (/logo|brand|marca/i.test(label) || img.closest('header, [class*="logo"], [class*="brand"]').length) {
      add(img.attr('src') ?? img.attr('data-src'), img.attr('alt') ?? '', 'in header or named logo');
    }
  });
  $('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]').each((_, el) => add($(el).attr('href'), '', 'site icon'));
  add(meta('og:image'), meta('og:image:alt'), 'social share image');
  const products: string[] = [];
  $('img, source').each((_, el) => {
    const node = $(el);
    const srcset = node.attr('srcset') ?? node.attr('data-srcset');
    // The last srcset candidate is usually the largest.
    const fromSet = srcset?.split(',').pop()?.trim().split(/\s+/)[0];
    // The card around the image says what it is: a product's name and price.
    const card = node.closest('li, article, figure, [class*="product"], [class*="Product"], [data-hook*="product"]');
    const context = card.length ? card.text().replace(/\s+/g, ' ').trim() : '';
    const useful = context.length > 2 && context.length <= 160 ? context : '';
    if (useful && !products.includes(useful)) products.push(useful);
    add(fromSet || node.attr('data-src') || node.attr('src'), node.attr('alt') ?? '', '', useful);
  });
  const cssUrls = [...html.matchAll(/url\(\s*['"]?([^'")]+\.(?:jpe?g|png|webp|avif|svg)[^'")]*)['"]?\s*\)/gi)].map((m) => m[1]);
  cssUrls.forEach((src) => add(src, '', 'CSS background'));

  const fonts = await siteFonts($, html, url);

  $('script, style, noscript, svg, iframe').remove();
  const blocks: string[] = [];
  $('h1, h2, h3, p, li, address').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 2 && !blocks.includes(text)) blocks.push(text);
  });
  const title = meta('og:title') || $('title').text().trim();
  const catalog = products.length >= 3 ? [`Products shown on the page (${products.length}):`, ...products.slice(0, 40).map((p) => `- ${p}`)] : [];
  const text = [title, meta('og:description') || meta('description'), ...catalog, ...blocks].filter(Boolean).join('\n').slice(0, MAX_TEXT);

  const dir = path.join(run.dir, 'assets');
  await mkdir(dir, { recursive: true });
  for (const candidate of candidates.values()) {
    if (run.assets.length >= MAX_ASSETS) break;
    const id = `a${run.assets.length + 1}`;
    try {
      const asset = await download(candidate, dir, id).catch((error) => {
        if (!candidate.fallback) throw error;
        return download({ ...candidate, src: candidate.fallback }, dir, id);
      });
      if (asset) run.assets.push(asset);
    } catch {
      // Broken or blocked asset: skip it.
    }
  }
  return { url, title, text, fonts };
}

async function download(candidate: Candidate, dir: string, id: string): Promise<Asset | null> {
  const res = await get(candidate.src);
  const buffer = Buffer.from(await res.arrayBuffer());
  const isSvg = /svg/i.test(res.headers.get('content-type') ?? '') || /\.svg(\?|$)/i.test(candidate.src);
  // SVG logos are rendered big enough to place on a 1080 px slide.
  const image = isSvg
    ? sharp(buffer, { density: 300 }).resize(1200, 1200, { fit: 'inside' })
    : sharp(buffer).rotate().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true });
  const { width = 0, height = 0, hasAlpha = false } = await image.metadata();
  if (Math.min(width, height) < MIN_SIDE) return null;
  // PNG keeps transparency (logos, product cutouts); everything else goes to JPEG
  // so GIMP opens it whatever the site served (webp, avif…). Many webp have an
  // alpha channel with nothing transparent in it: those are plain photos.
  const transparent = isSvg || (hasAlpha && (await sharp(buffer).stats()).channels[3]?.min < 250);
  const file = path.join(dir, `${id}.${transparent ? 'png' : 'jpg'}`);
  await writeFile(file, transparent ? await image.png().toBuffer() : await image.jpeg({ quality: 92 }).toBuffer());
  const out = await sharp(file).metadata();
  return {
    id,
    path: file,
    source: candidate.src,
    alt: candidate.alt,
    hint: candidate.hint,
    context: candidate.context,
    width: out.width ?? width,
    height: out.height ?? height,
    transparent,
  };
}

const GENERIC = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'helvetica neue', 'arial', 'ui-sans-serif', 'ui-serif', 'apple color emoji', 'segoe ui emoji', 'noto color emoji', 'var']);

// The font families of the site: Google Fonts links first, then what its CSS
// (inline and up to three stylesheets) declares, by how often it appears.
async function siteFonts($: cheerio.CheerioAPI, html: string, url: string): Promise<string[]> {
  const count = new Map<string, number>();
  const add = (name: string, weight = 1) => {
    const clean = name.replace(/['"]/g, '').replace(/\+/g, ' ').trim();
    if (!clean || clean.length > 40 || GENERIC.has(clean.toLowerCase()) || /^var\(|^--/.test(clean)) return;
    count.set(clean, (count.get(clean) ?? 0) + weight);
  };
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    for (const m of href.matchAll(/family=([^:&|]+)/g)) add(decodeURIComponent(m[1]), 50);
  });
  let css = $('style').map((_, el) => $(el).text()).get().join('\n') + $('[style*="font-family"]').map((_, el) => $(el).attr('style')).get().join(';');
  const sheets = $('link[rel="stylesheet"]').map((_, el) => $(el).attr('href')).get().filter(Boolean).slice(0, 3);
  for (const href of sheets) {
    try {
      const res = await get(new URL(href, url).href);
      css += '\n' + (await res.text()).slice(0, 400000);
    } catch {
      // A stylesheet that doesn't load just doesn't count.
    }
  }
  for (const m of css.matchAll(/@import url\(['"]?[^)]*fonts\.googleapis\.com[^)]*family=([^:&|)'"]+)/g)) add(decodeURIComponent(m[1]), 50);
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) add(m[1].split(',')[0]);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 6);
}

// Image CDNs serve thumbnails sized in the URL; the analyst and the slides need
// the original, so the size part is dropped (the thumbnail stays as a fallback).
export function fullSize(src: string): string {
  // Wix: /media/<id>~mv2.jpg/v1/fill/w_147,h_106,.../name.webp
  const wix = src.match(/^(https?:\/\/static\.wixstatic\.com\/media\/[^/]+?\.(?:jpe?g|png|webp|gif))\/v1\//i);
  if (wix) return wix[1];
  // Shopify: name_300x300.jpg, name_small.jpg, ?width=300
  if (/cdn\.shopify\.com|\/cdn\/shop\//.test(src)) {
    return src
      .replace(/_(?:\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande)(?:_crop_\w+)?(?:@\dx)?(?=\.\w+(?:\?|$))/i, '')
      .replace(/([?&])width=\d+/, '$1width=2048')
      .replace(/([?&])height=\d+&?/, '$1');
  }
  // WordPress: /wp-content/uploads/.../name-300x200.jpg
  if (/\/wp-content\/uploads\//.test(src)) return src.replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp)(?:\?|$))/i, '');
  // Squarespace: ?format=300w
  if (/squarespace-cdn\.com/.test(src)) return src.replace(/([?&])format=\d+w/, '$1format=2500w');
  // Magento: /media/catalog/product/cache/<hash>/c/e/name.jpg
  if (/\/media\/catalog\/product\/cache\//.test(src)) return src.replace(/\/cache\/[0-9a-f]{32}\//i, '/');
  return src;
}

// Edge or Chrome, headless, takes the page as a visitor sees it (on a computer and on
// a phone). No browser installed means no screenshots: the run goes on without them.
export async function captureSite(run: Run, url: string): Promise<string[]> {
  const browser = config.browser.find((p) => existsSync(p));
  if (!browser) return [];
  const dir = path.join(run.dir, 'site');
  await mkdir(dir, { recursive: true });
  const shots: string[] = [];
  for (const [name, size, extra] of [
    // Double resolution on the computer: images cropped from it must hold a 1080 px slide.
    ['desktop', '1440,2000', '2'],
    ['phone', '430,1800', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'],
  ] as const) {
    const file = path.join(dir, `${name}.png`);
    const args = ['--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(dir, 'profile')}`, `--window-size=${size}`, `--virtual-time-budget=${RENDER_BUDGET_MS}`, `--screenshot=${file}`];
    if (extra === '2') args.push('--force-device-scale-factor=2');
    else if (extra) args.push(`--user-agent=${extra}`);
    await exec(browser, [...args, url], { timeout: 60000 }).catch(() => undefined);
    if (existsSync(file)) shots.push(file);
  }
  return shots;
}

// The DOM after the page's JavaScript ran; empty when there is no browser or it fails.
async function renderedHtml(run: Run, url: string): Promise<string> {
  const browser = config.browser.find((p) => existsSync(p));
  if (!browser) return '';
  const dir = path.join(run.dir, 'site');
  await mkdir(dir, { recursive: true });
  const args = ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(dir, 'profile')}`, `--virtual-time-budget=${RENDER_BUDGET_MS}`, '--dump-dom', url];
  const { stdout } = await exec(browser, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
  return stdout;
}

function bodyText(html: string): number {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().length + $('body img').length * 100;
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselAgent/0.1)', Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res;
}
