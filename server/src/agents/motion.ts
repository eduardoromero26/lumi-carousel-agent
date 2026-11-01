import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { LayerInfo } from '../gimp.js';
import { chatJson, imagePart, type Message } from '../llm.js';
import type { Plan, SlidePlan } from '../run.js';
import { MOTION } from './prompts.js';

export const EASES = ['power2.out', 'power3.out', 'power4.out', 'expo.out', 'back.out(1.4)', 'sine.inOut'];

export type Enter = {
  layer: string;
  at: number;
  duration: number;
  from: { opacity?: number; x?: number; y?: number; scale?: number };
  ease: string;
};

export type MotionPlan = {
  duration: number;
  exit_at: number;
  camera: { layers: string[]; scale: number } | null;
  enter: Enter[];
  pulse: { layer: string; at: number }[];
  notes?: string;
};

// The motion designer: one conversation per card, so critic fixes build on the
// previous choreography.
export class MotionDesigner {
  private messages: Message[] = [];

  constructor(
    private plan: Plan,
    private slide: SlidePlan,
    private layers: LayerInfo[],
    private slidePng: string,
  ) {}

  async choreograph(fixes?: string[]): Promise<MotionPlan> {
    if (!this.messages.length) {
      const preview = await sharp(await readFile(this.slidePng)).resize(768).png().toBuffer();
      this.messages = [
        { role: 'system', content: MOTION },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Carousel: ${this.plan.concept}`,
                `Card ${this.slide.n} of ${this.plan.slides.length} (${this.slide.role}): "${this.slide.headline}" / "${this.slide.body}"`,
                this.slide.subjectBox ? `The subject (${this.slide.subject}) is at x ${this.slide.subjectBox.x1}-${this.slide.subjectBox.x2}, y ${this.slide.subjectBox.y1}-${this.slide.subjectBox.y2}.` : '',
                'Layers, top of the stack first (x, y, w, h in px of the 1080x1350 card):',
                ...this.layers.map(
                  (l, i) =>
                    `- ${l.id} "${l.name}" ${l.kind}${l.text ? ` "${l.text.slice(0, 80)}"` : ''} at ${l.x},${l.y} ${l.w}x${l.h}${i === this.layers.length - 1 ? ' (bottom layer)' : ''}`,
                ),
                'The approved static card:',
              ]
                .filter(Boolean)
                .join('\n'),
            },
            imagePart(preview.toString('base64')),
          ],
        },
      ];
    } else if (fixes?.length) {
      this.messages.push({ role: 'user', content: `Fix the choreography:\n- ${fixes.join('\n- ')}\nReply with the full JSON again.` });
    }
    const motion = await chatJson<MotionPlan>(this.messages);
    this.messages.push({ role: 'assistant', content: JSON.stringify(motion) });
    motion.enter ??= [];
    motion.pulse ??= [];
    return motion;
  }
}

// The rules of the agency's motion work that can be measured are checked here,
// not left to the model.
export function validateMotion(motion: MotionPlan, layers: LayerInfo[]): string[] {
  const problems: string[] = [];
  const ids = new Set(layers.map((l) => l.id));
  const bottom = layers[layers.length - 1]?.id;
  if (!(motion.duration >= 6 && motion.duration <= 8)) problems.push(`duration must be 6 to 8 s (got ${motion.duration})`);
  if (!(motion.exit_at <= motion.duration - 0.5 && motion.exit_at >= motion.duration - 1.2)) {
    problems.push(`exit_at must be between duration - 1.2 and duration - 0.5 (got ${motion.exit_at} for ${motion.duration})`);
  }
  for (const e of motion.enter) {
    const layer = layers.find((l) => l.id === e.layer);
    if (!ids.has(e.layer)) problems.push(`${e.layer} is not a layer`);
    if (!EASES.includes(e.ease)) problems.push(`${e.layer}: ease "${e.ease}" is not allowed; use one of ${EASES.join(', ')}`);
    if (e.duration < 0.3 || e.duration > 1.2) problems.push(`${e.layer}: entrances last 0.3 to 1.2 s`);
    if (layer?.kind === 'text' && e.from.scale !== undefined && e.from.scale !== 1) problems.push(`${e.layer} is text: only opacity, x and y may change, never scale`);
    if (e.layer === bottom && e.from.opacity !== undefined && e.from.opacity < 1) problems.push(`${e.layer} is the bottom layer: it never fades (the card would start black)`);
  }
  // At most two elements entering at the same moment.
  const edges = motion.enter.flatMap((e) => [e.at + 0.001, e.at + e.duration]).sort((a, b) => a - b);
  for (const t of edges) {
    const active = motion.enter.filter((e) => e.at <= t && t < e.at + e.duration).map((e) => e.layer);
    if (active.length > 2) {
      problems.push(`at ${t.toFixed(2)} s ${active.length} layers are entering at once (${active.join(', ')}); max 2`);
      break;
    }
  }
  const lastIn = Math.max(0, ...motion.enter.map((e) => e.at + e.duration));
  if (motion.exit_at - lastIn < 2) problems.push(`everything must be in place at least 2 s before exit_at so it can be read (last entrance ends at ${lastIn.toFixed(2)} s)`);
  for (const p of motion.pulse) if (!ids.has(p.layer)) problems.push(`pulse: ${p.layer} is not a layer`);
  if (motion.camera && (motion.camera.scale < 1 || motion.camera.scale > 1.04)) problems.push('camera scale must be 1.00 to 1.04');
  return problems;
}
