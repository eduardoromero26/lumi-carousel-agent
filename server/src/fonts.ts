import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Gimp } from './gimp.js';

const WEIGHT_NAMES: Record<number, string[]> = {
  100: ['Thin', 'Hairline'],
  200: ['ExtraLight', 'Extra-Light', 'UltraLight'],
  300: ['Light'],
  400: ['Regular', 'Book', 'Normal', ''],
  500: ['Medium'],
  600: ['SemiBold', 'Semi-Bold', 'DemiBold'],
  700: ['Bold'],
  800: ['ExtraBold', 'Extra-Bold', 'UltraBold'],
  900: ['Black', 'Heavy'],
};

// Google Fonts answers a plain client with TrueType, which is what GIMP loads.
async function css(family: string, weights: number[]): Promise<string | undefined> {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${[...new Set(weights)].sort().join(';')}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'curl/8' }, signal: AbortSignal.timeout(15000) }).catch(() => undefined);
  return res?.ok ? res.text() : undefined;
}

export async function onGoogleFonts(family: string): Promise<boolean> {
  return !!(await css(family, [400]));
}

// Downloads the family's weights into GIMP's fonts folder (once) and returns the
// names GIMP knows them by, e.g. { 700: "Poppins Bold" }.
export async function installFont(gimp: Gimp, family: string, weights: number[]): Promise<Record<number, string>> {
  const sheet = await css(family, weights);
  if (!sheet) throw new Error(`${family} is not on Google Fonts`);
  await mkdir(config.gimpFontsDir, { recursive: true });
  let added = false;
  for (const block of sheet.split('@font-face').slice(1)) {
    const weight = Number(block.match(/font-weight:\s*(\d+)/)?.[1]);
    const url = block.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
    if (!url || !weight) continue;
    const file = path.join(config.gimpFontsDir, `${family.replace(/\s+/g, '')}-${weight}.ttf`);
    if (existsSync(file)) continue;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) continue;
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    added = true;
  }
  const names = (await gimp.python(
    [
      added ? 'Gimp.fonts_refresh()' : '',
      `_raw = Gimp.fonts_get_list(${JSON.stringify(family)})`,
      '_list = list(_raw[1]) if isinstance(_raw, tuple) and len(_raw) > 1 else list(_raw)',
      '_result = [_f.get_name() for _f in _list]',
    ]
      .filter(Boolean)
      .join('\n'),
  )) as string[];
  const result: Record<number, string> = {};
  for (const weight of weights) {
    const wanted = WEIGHT_NAMES[weight] ?? ['Regular'];
    // "Poppins Bold" for 700, "Poppins" or "Poppins Regular" for 400; never an italic.
    const match = names
      .filter((n) => !/italic|oblique/i.test(n))
      .find((n) => wanted.some((w) => n.toLowerCase() === `${family} ${w}`.trim().toLowerCase()));
    if (match) result[weight] = match;
  }
  return result;
}
