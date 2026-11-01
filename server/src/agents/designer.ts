import { config } from '../config.js';
import type { Gimp, GimpResult } from '../gimp.js';
import { chat, imagePart, type Message, type ToolDef } from '../llm.js';
import { generateAsset } from '../muse_image.js';
import { protectOnSlide, protectedText } from '../sam.js';
import type { Plan, Run, SlidePlan } from '../run.js';
import { DESIGNER, RETOUCHER } from './prompts.js';

// What the retoucher may use: look, edit text, show/hide or fade, move and scale. No drawing.
// gimp-mcp's edit_text breaks on sizes in GIMP 3.2 and undo has no history here: set_text replaces both.
const RETOUCH_ALLOWED = new Set(['get_state_snapshot', 'list_layers', 'set_layer_properties', 'reorder_layer', 'adjust_brightness_contrast', 'adjust_hue_saturation', 'auto_levels']);
const RETOUCH_STEPS = 10;

// Retouching a template slide: move or scale a named layer, keeping it centered by default.
const retouchTools: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'move_layer',
      description: 'Move a layer (by name) so its top-left corner is at x, y. Omit x to keep it centered on x = 540.',
      parameters: {
        type: 'object',
        properties: { layer: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } },
        required: ['layer', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scale_layer',
      description: 'Scale a non-text layer (by name) to a new width in px, keeping its proportions and its center. For text, use edit_text with a new size.',
      parameters: {
        type: 'object',
        properties: { layer: { type: 'string' }, width: { type: 'integer' } },
        required: ['layer', 'width'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_text',
      description: 'Change a text layer (by name): its words, its size in px or its color. It stays centered on x = 540 at the same top.',
      parameters: {
        type: 'object',
        properties: { layer: { type: 'string' }, text: { type: 'string' }, size: { type: 'integer' }, color: { type: 'string', description: '#rrggbb' } },
        required: ['layer'],
      },
    },
  },
];

const customTools: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'generate_asset',
      description:
        'Generate a decorative asset with Muse Image and add it as a new layer. "background": a full-slide backdrop for slides without a photo. "texture": a full-slide pattern or texture to blend over a background (lower its opacity or change its mode with set_layer_properties). "element": an isolated shape, icon, sticker or ornament on a transparent background, placed at x, y. Never use it for the products, food, place or people of the business: those must be real photos. Each call takes time and money: generate only what the design needs.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['background', 'texture', 'element'] },
          prompt: { type: 'string', description: 'What to draw: style, shapes, mood, colors. No text.' },
          x: { type: 'integer', description: 'Element only: left edge in px' },
          y: { type: 'integer', description: 'Element only: top edge in px' },
          width: { type: 'integer', description: 'Element only: width in px' },
        },
        required: ['kind', 'prompt'],
      },
    },
  },
];

// One designer per slide; the conversation is kept so critic fixes build on the
// layers already in GIMP instead of starting over.
export class SlideDesigner {
  private messages: Message[];

  constructor(
    private run: Run,
    private gimp: Gimp,
    private slide: SlidePlan,
    plan: Plan,
    styleNotes: string,
    // build: design from scratch; retouch: fix a slide built from the template; edit: the owner's changes.
    private mode: 'build' | 'retouch' | 'edit' = 'build',
  ) {
    const brief = run.brief;
    const editing = mode !== 'build';
    this.messages = [
      { role: 'system', content: editing ? RETOUCHER : DESIGNER },
      {
        role: 'user',
        content: [
          `Carousel concept: ${plan.concept}`,
          `Slide ${slide.n} of ${plan.slides.length} (${slide.role}).`,
          `Headline: ${slide.headline}`,
          `Body: ${slide.body || '(none)'}`,
          `Director's notes: ${slide.visual}`,
          editing
            ? 'The slide is already designed and open in GIMP with all its layers (see list_layers). Change only what is asked and keep the rest.'
            : this.backdrop()
              ? `Background: the website image ${slide.photo}, already placed full-bleed and softened, under a "Shade" layer of the brand's dark color at 62 %. It has text baked in that must never compete with yours: keep the Shade (you may tune its opacity between 45 and 75 %), and your text can sit anywhere inside the margins.`
              : this.cutout()
                ? `The product photo ${slide.photo} is already placed whole and centered, ${this.run.photos.find((p) => p.id === slide.photo)?.matte ? `on a "Background" of its own studio color (${this.run.photos.find((p) => p.id === slide.photo)?.matte}), so the edge is seamless; add the brand colors with bands or shapes around it` : 'a cutout over the brand color "Background"'}. Keep the product whole and unchanged: move or scale it with reframe_photo (zoom below 1 keeps it whole), and put the text in the free space around it.`
                : slide.photo
                ? `Background: the business photo ${slide.photo}, already placed and cropped.`
                : 'Background: a solid color, already filled. You may replace it with generate_asset (background).',
          protectedText(slide),
          brief.brandColors?.length ? `Brand colors: ${brief.brandColors.join(', ')}` : '',
          styleNotes ? `The carousel's visual system, keep it: ${styleNotes}` : 'This is the first slide: you set the visual system for the rest.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
  }

  private tools(): ToolDef[] {
    if (this.mode !== 'build') return [...this.gimp.designerTools().filter((t) => RETOUCH_ALLOWED.has(t.function.name)), ...retouchTools];
    const tools = [...this.gimp.designerTools(), ...customTools];
    if (this.photoPath()) {
      tools.push({
        type: 'function',
        function: {
          name: 'reframe_photo',
          description:
            'Reframe the business photo (the "Photo" layer) from the original file, without losing quality or the other layers. zoom 1 = the photo just covers the slide; above 1 crops tighter; below 1 shows the whole photo smaller over the background color (useful when people would be cut). focus_x/focus_y (0..1 of the photo) is the point kept as centered as possible. Returns where the subject lands on the slide.',
          parameters: {
            type: 'object',
            properties: {
              zoom: { type: 'number', description: '0.5 to 3' },
              focus_x: { type: 'number', description: '0..1 from the left of the photo' },
              focus_y: { type: 'number', description: '0..1 from the top of the photo' },
            },
            required: ['zoom', 'focus_x', 'focus_y'],
          },
        },
      });
    }
    const logo = this.run.logo;
    if (logo) {
      tools.push({
        type: 'function',
        function: {
          name: 'place_logo',
          description: `Place the real business logo as a new top layer named "Logo", scaled to the given width. Versions: "dark" (${logo.width}x${logo.height}, for light backgrounds)${this.run.logoLight ? ` and "light" (${this.run.logoLight.width}x${this.run.logoLight.height}, white, for dark or photo backgrounds)` : ''}.`,
          parameters: {
            type: 'object',
            properties: {
              variant: { type: 'string', enum: this.run.logoLight ? ['dark', 'light'] : ['dark'] },
              x: { type: 'integer', description: 'Left edge in px' },
              y: { type: 'integer', description: 'Top edge in px' },
              width: { type: 'integer', description: 'Logo width in px, usually 160-320' },
            },
            required: ['variant', 'x', 'y', 'width'],
          },
        },
      });
    }
    return tools;
  }

  private cutout(): boolean {
    return !!this.run.photos.find((p) => p.id === this.slide.photo)?.cutout;
  }

  private backdrop(): boolean {
    return !!this.run.photos.find((p) => p.id === this.slide.photo)?.backdrop;
  }

  private photoPath(): string | undefined {
    return this.slide.photo ? this.run.photos.find((p) => p.id === this.slide.photo)?.path : undefined;
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<GimpResult> {
    if (name === 'set_text') {
      const code = [
        '_img = Gimp.get_images()[0]',
        `_l = [_x for _x in _img.get_layers() if _x.get_name() == ${JSON.stringify(String(args.layer))}][0]`,
        '_y = _l.get_offsets()[-1]',
        typeof args.text === 'string' ? `_l.set_text(${JSON.stringify(args.text)})` : '',
        args.size ? `_l.set_font_size(${Math.max(12, Math.round(Number(args.size)))}, Gimp.Unit.pixel())` : '',
        typeof args.color === 'string' && /^#[0-9a-f]{6}$/i.test(args.color) ? `_l.set_color(Gegl.Color.new(${JSON.stringify(args.color)}))` : '',
        '_l.set_offsets(int(540 - _l.get_width() / 2), _y)',
        "_result = {'x': _l.get_offsets()[-2], 'y': _y, 'w': _l.get_width(), 'h': _l.get_height()}",
      ].filter(Boolean);
      return { text: JSON.stringify(await this.gimp.python(code.join('\n'))) };
    }
    if (name === 'move_layer' || name === 'scale_layer') {
      const layer = JSON.stringify(String(args.layer));
      const code =
        name === 'move_layer'
          ? [
              '_img = Gimp.get_images()[0]',
              `_l = [_x for _x in _img.get_layers() if _x.get_name() == ${layer}][0]`,
              `_x = ${args.x === undefined || args.x === null ? 'int(540 - _l.get_width() / 2)' : Math.round(Number(args.x))}`,
              `_l.set_offsets(_x, ${Math.round(Number(args.y))})`,
              "_result = {'x': _x, 'y': _l.get_offsets()[-1], 'w': _l.get_width(), 'h': _l.get_height()}",
            ]
          : [
              '_img = Gimp.get_images()[0]',
              `_l = [_x for _x in _img.get_layers() if _x.get_name() == ${layer}][0]`,
              '_o = _l.get_offsets()',
              '_cx = _o[-2] + _l.get_width() / 2',
              '_cy = _o[-1] + _l.get_height() / 2',
              `_w = ${Math.max(8, Math.round(Number(args.width)))}`,
              '_h = max(1, int(_l.get_height() * _w / _l.get_width()))',
              'Gimp.context_set_interpolation(Gimp.InterpolationType.CUBIC)',
              '_l.scale(_w, _h, False)',
              '_l.set_offsets(int(_cx - _w / 2), int(_cy - _h / 2))',
              "_result = {'x': int(_cx - _w / 2), 'y': int(_cy - _h / 2), 'w': _w, 'h': _h}",
            ];
      return { text: JSON.stringify(await this.gimp.python(code.join('\n'))) };
    }
    const photo = this.photoPath();
    if (name === 'reframe_photo' && photo) {
      const frame = await this.gimp.framePhoto(photo, Number(args.zoom), Number(args.focus_x), Number(args.focus_y));
      protectOnSlide(this.slide, frame);
      return { text: `Photo layer now ${frame.w}x${frame.h} at ${frame.x},${frame.y}.
${protectedText(this.slide) || 'No subject or faces known for this photo.'}` };
    }
    if (name === 'place_logo' && this.run.logo) {
      const file = args.variant === 'light' && this.run.logoLight ? this.run.logoLight.path : this.run.logo.path;
      return this.gimp.placeLogo(file, Number(args.x), Number(args.y), Number(args.width));
    }
    if (name === 'generate_asset') {
      const file = await generateAsset(this.run, String(args.prompt), String(args.kind));
      this.run.emit('status', 'designer', `Generated a ${args.kind} with Muse Image: ${args.prompt}`, {
        slide: this.slide.n,
        data: { url: this.run.fileUrl(file) },
      });
      return this.gimp.placeImage(file, Number(args.x), Number(args.y), Number(args.width), String(args.kind));
    }
    if (this.gimp.isDesignerTool(name)) return this.gimp.call(name, args);
    throw new Error(`Tool ${name} is not available`);
  }

  async work(fixes?: string[], from: 'critic' | 'owner' = 'critic'): Promise<string> {
    if (fixes?.length) {
      const who =
        from === 'owner'
          ? 'The business owner reviewed the slide and asked for these changes. They have the last word'
          : 'The art director rejected the slide. Fix this';
      this.messages.push({
        role: 'user',
        content: `${who} on the current image (use undo or edit layers as needed):\n- ${fixes.join('\n- ')}`,
      });
    }
    const n = this.slide.n;
    for (let step = 0; step < (this.mode === 'build' ? config.maxDesignSteps : RETOUCH_STEPS); step++) {
      const reply = await chat(this.messages, this.tools());
      this.messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined });
      if (reply.content?.trim()) this.run.emit('thought', 'designer', reply.content.trim(), { slide: n });
      if (!reply.toolCalls.length) return reply.content ?? '';

      const snapshots: string[] = [];
      for (const call of reply.toolCalls) {
        const name = call.function.name;
        let result: string;
        try {
          const args: Record<string, unknown> = { ...(JSON.parse(call.function.arguments || '{}') as Record<string, unknown>), image_index: 0 };
          if (name === 'get_state_snapshot') args.max_size = 512;
          const out = await this.runTool(name, args);
          result = out.text;
          if (out.imageBase64) {
            snapshots.push(out.imageBase64);
            result = 'Snapshot attached below.';
          }
          this.run.emit('tool', 'designer', `${name}(${summarizeArgs(args)})`, { slide: n, data: { name, args } });
        } catch (error) {
          result = `Error: ${(error as Error).message}`;
          this.run.emit('tool', 'designer', `${name} failed: ${(error as Error).message}`, { slide: n });
        }
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 2000) });
      }
      // Tool messages can't carry images in Chat Completions, so the designer
      // sees its snapshots in a follow-up user turn.
      if (snapshots.length) {
        // Only the latest look at the slide stays in the history: every image is
        // resent on every step, and old ones are what made runs expensive.
        for (const m of this.messages) {
          if (m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) {
            m.content = [{ type: 'text', text: '(an earlier snapshot of the slide, replaced by the newer one below)' }];
          }
        }
        this.messages.push({ role: 'user', content: [{ type: 'text', text: 'Current state of the slide:' }, imagePart(snapshots[snapshots.length - 1])] });
      }
    }
    return 'Step limit reached.';
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => k !== 'image_index')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v)}`)
    .join(', ');
}
