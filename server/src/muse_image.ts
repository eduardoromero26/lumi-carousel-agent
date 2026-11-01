import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { addCost } from './llm.js';
import type { Run } from './run.js';

export type AssetKind = 'background' | 'texture' | 'element';

// Muse Image makes the decoration only. The business's products, food, place and
// people always come from real photos, so the prompt forbids them.
const GUARD =
  'No text, no letters, no logos, no people, no faces, no food, no real products. High quality design asset for a social media carousel.';

export async function generateAsset(run: Run, prompt: string, kind: string): Promise<string> {
  const assetKind: AssetKind = kind === 'texture' || kind === 'element' ? kind : 'background';
  const shape =
    assetKind === 'element'
      ? 'A single isolated object centered on a pure white (#FFFFFF) background, no shadow on the background.'
      : 'Full-bleed, edge to edge, portrait 4:5.';
  const colors = run.brief.brandColors?.length ? `Use these brand colors: ${run.brief.brandColors.join(', ')}.` : '';

  const res = await fetch(`${config.modelBaseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.modelApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.imageModelId,
      prompt: `${prompt}. ${shape} ${colors} ${GUARD}`,
      n: 1,
      size: assetKind === 'element' ? '1024x1024' : '1024x1280',
      response_format: 'b64_json',
      output_format: 'png',
    }),
  });
  if (!res.ok) throw new Error(`Muse Image ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data: { b64_json?: string }[] };
  const b64 = json.data[0]?.b64_json;
  if (!b64) throw new Error('Muse Image returned no image');
  addCost(0.01);

  const dir = path.join(run.dir, 'generated');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${assetKind}-${Date.now()}.png`);
  const buffer = Buffer.from(b64, 'base64');
  await writeFile(file, assetKind === 'element' ? await whiteToAlpha(buffer) : buffer);
  return file;
}

// The API ignores transparent backgrounds, so elements come on white and the
// white is keyed out here, with a soft edge to avoid a halo.
async function whiteToAlpha(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    if (min >= 245) data[i + 3] = 0;
    else if (min >= 225) data[i + 3] = Math.round(((245 - min) / 20) * data[i + 3]);
  }
  return sharp(data, { raw: info }).png().toBuffer();
}
