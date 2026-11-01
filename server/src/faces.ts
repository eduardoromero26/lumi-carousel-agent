import sharp from 'sharp';
import { SLIDE } from './config.js';
import type { SlidePlan } from './run.js';

// How different (0..1) each face on the slide is from the same area of the
// original photo. Light color correction stays well under 0.12; text, bands or a
// box over a face go far above it.
export async function faceChanges(slidePng: string, photoPath: string, slide: SlidePlan): Promise<{ box: NonNullable<SlidePlan['faces']>[number]; diff: number }[]> {
  const frame = slide.frame;
  if (!frame || !slide.faces?.length) return [];
  const photo = sharp(photoPath).rotate().resize(frame.w, frame.h, { fit: 'fill' });
  const canvas = await sharp({ create: { width: SLIDE.width, height: SLIDE.height, channels: 3, background: '#000' } })
    .composite([{ input: await cropToCanvas(photo, frame), left: Math.max(0, frame.x), top: Math.max(0, frame.y) }])
    .removeAlpha()
    .raw()
    .toBuffer();
  const actual = await sharp(slidePng).removeAlpha().resize(SLIDE.width, SLIDE.height, { fit: 'fill' }).raw().toBuffer();
  return slide.faces.map((box) => {
    let sum = 0;
    let n = 0;
    for (let y = box.y1; y < box.y2; y += 2) {
      for (let x = box.x1; x < box.x2; x += 2) {
        const i = (y * SLIDE.width + x) * 3;
        sum += Math.abs(canvas[i] - actual[i]) + Math.abs(canvas[i + 1] - actual[i + 1]) + Math.abs(canvas[i + 2] - actual[i + 2]);
        n += 3;
      }
    }
    return { box, diff: n ? sum / n / 255 : 0 };
  });
}

// The part of the scaled photo that falls on the slide.
async function cropToCanvas(photo: ReturnType<typeof sharp>, frame: NonNullable<SlidePlan['frame']>): Promise<Buffer> {
  const left = Math.max(0, -frame.x);
  const top = Math.max(0, -frame.y);
  const width = Math.min(frame.w - left, SLIDE.width - Math.max(0, frame.x));
  const height = Math.min(frame.h - top, SLIDE.height - Math.max(0, frame.y));
  return photo.extract({ left, top, width, height }).png().toBuffer();
}
