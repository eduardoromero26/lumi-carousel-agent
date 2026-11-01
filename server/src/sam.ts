import sharp from 'sharp';
import { config, SLIDE } from './config.js';
import type { Frame } from './gimp.js';
import type { SlidePlan } from './run.js';
import { addCost } from './llm.js';

// Box normalized to 0..1 of the image, so it survives resizing and cropping.
export type Box = { x1: number; y1: number; x2: number; y2: number; confidence: number };

// SAM 3.1 over the Responses API: one noun phrase per request, results stream as
// tokens like <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|>. Only boxes are used.
export async function locate(file: string, prompt: string): Promise<Box[]> {
  const image = await sharp(file).rotate().resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const res = await fetch(`${config.modelBaseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.modelApiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: config.samModelId,
      stream: true,
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${image.toString('base64')}` },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`SAM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  addCost(0.0025);

  let output = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5)) as { type: string; delta?: string };
      if (event.type === 'response.output_text.delta') output += event.delta ?? '';
    } catch {
      // Keep-alive or partial line.
    }
  }

  const boxes: Box[] = [];
  for (const m of output.matchAll(/<\|box;([^|]*)\|>/g)) {
    const f = Object.fromEntries(m[1].split(';').map((kv) => kv.split('=') as [string, string]));
    const w = Number(f.w);
    const h = Number(f.h);
    if (!w || !h) continue;
    boxes.push({
      x1: Number(f.x1) / w,
      y1: Number(f.y1) / h,
      x2: (Number(f.x2) + 1) / w,
      y2: (Number(f.y2) + 1) / h,
      confidence: f.c ? Number(f.c) : 1,
    });
  }
  return boxes.sort((a, b) => b.confidence - a.confidence);
}

// SAM finds plain, common singular nouns ("baby", "bike") and misses plurals and
// rarer words ("babies", "newborn", "tricycle"), so a subject is retried in simpler forms.
const SAM_SYNONYMS: Record<string, string> = {
  newborn: 'baby',
  infant: 'baby',
  toddler: 'child',
  kid: 'child',
  pediatrician: 'doctor',
  physician: 'doctor',
  tricycle: 'bike',
  trike: 'bike',
  bicycle: 'bike',
  'e-bike': 'bike',
  ebike: 'bike',
  moped: 'scooter',
};

export function samPrompts(subject: string): string[] {
  const words = subject.toLowerCase().trim().split(/\s+/);
  const last = words[words.length - 1] ?? '';
  const singular = last.endsWith('ies') ? `${last.slice(0, -3)}y` : last.endsWith('s') && !last.endsWith('ss') ? last.slice(0, -1) : last;
  return [...new Set([subject.trim(), last, singular, SAM_SYNONYMS[singular] ?? singular].filter(Boolean))];
}

// Union of the confident boxes: the whole subject when SAM finds it in pieces.
export function subjectBox(boxes: Box[], minConfidence = 0.5): Box | undefined {
  const good = boxes.filter((b) => b.confidence >= minConfidence);
  if (!good.length) return undefined;
  return {
    x1: Math.min(...good.map((b) => b.x1)),
    y1: Math.min(...good.map((b) => b.y1)),
    x2: Math.max(...good.map((b) => b.x2)),
    y2: Math.max(...good.map((b) => b.y2)),
    confidence: Math.max(...good.map((b) => b.confidence)),
  };
}

// Maps the subject found by SAM (0..1 of the photo) onto the slide for the
// photo's current frame, and keeps it on the slide plan for the designer and critic.
export function subjectOnSlide(slide: SlidePlan, frame: Frame): SlidePlan['subjectBox'] {
  const n = slide.subjectNorm;
  if (!n) return undefined;
  const px = (v: number, size: number, offset: number, max: number) => Math.min(Math.max(Math.round(v * size + offset), 0), max);
  slide.subjectBox = {
    x1: px(n.x1, frame.w, frame.x, SLIDE.width),
    y1: px(n.y1, frame.h, frame.y, SLIDE.height),
    x2: px(n.x2, frame.w, frame.x, SLIDE.width),
    y2: px(n.y2, frame.h, frame.y, SLIDE.height),
  };
  return slide.subjectBox;
}


type Rect = { x1: number; y1: number; x2: number; y2: number };

function onSlide(n: Rect, frame: Frame): Rect {
  const px = (v: number, size: number, offset: number, max: number) => Math.min(Math.max(Math.round(v * size + offset), 0), max);
  return {
    x1: px(n.x1, frame.w, frame.x, SLIDE.width),
    y1: px(n.y1, frame.h, frame.y, SLIDE.height),
    x2: px(n.x2, frame.w, frame.x, SLIDE.width),
    y2: px(n.y2, frame.h, frame.y, SLIDE.height),
  };
}

// Subject and faces for the photo's current frame; faces fully outside the
// slide are dropped.
export function protectOnSlide(slide: SlidePlan, frame: Frame): void {
  slide.frame = frame;
  subjectOnSlide(slide, frame);
  slide.faces = (slide.facesNorm ?? []).map((f) => onSlide(f, frame)).filter((b) => b.x2 - b.x1 > 4 && b.y2 - b.y1 > 4);
}

// Plain words for the designer: what not to cover and where text fits.
export function protectedText(slide: SlidePlan): string {
  const areas = [...(slide.subjectBox ? [{ ...slide.subjectBox, what: slide.subject ?? 'subject' }] : []), ...(slide.faces ?? []).map((f) => ({ ...f, what: 'face' }))];
  if (!areas.length) return '';
  const top = Math.min(...areas.map((a) => a.y1));
  const bottom = Math.max(...areas.map((a) => a.y2));
  const free = [top >= 260 ? `top band y 0-${top}` : '', SLIDE.height - bottom >= 260 ? `bottom band y ${bottom}-${SLIDE.height}` : ''].filter(Boolean);
  return [
    `Protected areas (never put text, bands, boxes, gradients or the logo over them): ${areas.map((a) => `${a.what} x ${a.x1}-${a.x2}, y ${a.y1}-${a.y2}`).join('; ')}.`,
    free.length
      ? `Free for text: ${free.join(' or ')}.`
      : 'There is no free band for text: reframe_photo with zoom below 1 to open space over the background color, or keep the text short in a corner away from the protected areas.',
  ].join('\n');
}
