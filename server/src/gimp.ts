import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import sharp from 'sharp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config, SLIDE } from './config.js';
import type { ToolDef } from './llm.js';

// GIMP tools the designer may use. File, window and multi-image tools stay with
// the orchestrator so every slide is exactly one open image (index 0).
const DESIGNER_TOOLS = new Set([
  'get_state_snapshot',
  'get_image_metadata',
  'list_layers',
  'list_fonts',
  'create_layer',
  'set_layer_properties',
  'reorder_layer',
  'fill_layer',
  'fill_rectangle',
  'fill_ellipse',
  'gradient_fill',
  'draw_rectangle',
  'draw_line',
  'add_text',
  'edit_text',
  'select_rectangle',
  'select_ellipse',
  'select_none',
  'fill_selection',
  'auto_levels',
  'adjust_brightness_contrast',
  'adjust_hue_saturation',
  'adjust_color_balance',
  'adjust_curves',
  'sharpen',
  'apply_vignette',
  'apply_drop_shadow',
  'apply_gaussian_blur',
  'undo',
]);

type McpContent = { type: string; text?: string; data?: string; mimeType?: string };

export type GimpResult = { text: string; imageBase64?: string };

// Where the photo layer sits: its scaled size and its offset on the slide.
export type Frame = { w: number; h: number; x: number; y: number };

export type LayerInfo = {
  id: string;
  name: string;
  kind: 'text' | 'group' | 'raster';
  // Text layers only, when GIMP reports them: font name, size in px, color, alignment.
  font?: string;
  size?: number;
  color?: string;
  justify?: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  file: string;
};

export class Gimp {
  private client = new Client({ name: 'carousel-agent', version: '0.1.0' });
  private tools: ToolDef[] = [];
  private turn: Promise<unknown> = Promise.resolve();

  // GIMP holds one open image: slides are designed in parallel, but each one's GIMP
  // work (open or build, snapshot, export) runs in its own turn.
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.turn.then(work, work);
    this.turn = mine.catch(() => {});
    return mine;
  }

  async connect(): Promise<void> {
    await this.client.connect(
      new StdioClientTransport({ command: config.gimpPython, args: [config.gimpServer] }),
    );
    const { tools } = await this.client.listTools();
    this.tools = tools
      .filter((t) => DESIGNER_TOOLS.has(t.name))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          // The first paragraph is enough; the full docs cost tokens on every step.
          description: (t.description ?? t.name).split(/\n\s*\n/)[0].trim().slice(0, 300),
          parameters: withoutImageIndex(t.inputSchema as Record<string, unknown>),
        },
      }));
    const check = JSON.parse((await this.call('check_server', {})).text) as { connected: boolean; error?: string };
    if (!check.connected) {
      throw new Error(`GIMP is not reachable. Open GIMP and run Tools > MCP > Start MCP Server. (${check.error})`);
    }
  }

  designerTools(): ToolDef[] {
    return this.tools;
  }

  isDesignerTool(name: string): boolean {
    return DESIGNER_TOOLS.has(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<GimpResult> {
    const result = (await this.client.callTool({ name, arguments: args })) as {
      content: McpContent[];
      isError?: boolean;
    };
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    const image = result.content.find((c) => c.type === 'image');
    if (result.isError) throw new Error(text || `${name} failed`);
    return { text: text || 'ok', imageBase64: image?.data };
  }

  // gimp-mcp's close_image fails on GIMP 3.2 (no Gimp.get_displays), so the
  // displays this class opened are tracked and deleted from Python.
  async closeAll(): Promise<void> {
    const code = [
      "for _d in globals().get('_carousel_displays', []):",
      '    try:',
      '        _d.delete()',
      '    except Exception:',
      '        pass',
      '_carousel_displays = []',
      'for _im in Gimp.get_images():',
      '    try:',
      '        _im.delete()',
      '    except Exception:',
      '        pass',
    ].join('\n');
    await this.call('call_api', { api_path: 'exec', args: ['pyGObject-console', ['from gi.repository import Gimp', code]] });
  }

  // new_canvas and open_image always open a window, which fails in headless GIMP
  // (gimp-console); images are created with Python instead and only get a window
  // when GIMP has a UI.
  // The console returns what each line prints (pyGObject-eval always answers
  // empty), so the error and any result come back through print.
  private async execPython(code: string, { openWindow = true } = {}): Promise<string> {
    const window = openWindow
      ? `\n    try:\n        globals().setdefault('_carousel_displays', []).append(Gimp.Display.new(_img))\n        Gimp.displays_flush()\n    except Exception:\n        pass`
      : '';
    const wrapped = `_carousel_out = ''\ntry:\n${indent(code)}${window}\nexcept Exception as _e:\n    _carousel_error = str(_e)\nelse:\n    _carousel_error = ''`;
    const { text } = await this.call('call_api', {
      api_path: 'exec',
      args: ['pyGObject-console', ['from gi.repository import Gimp, Gegl, Gio', wrapped, "print('@@ERR' + _carousel_error + '@@OUT' + str(_carousel_out))"]],
    });
    const printed = (JSON.parse(text) as string[]).join('');
    const match = printed.match(/@@ERR([\s\S]*)@@OUT([\s\S]*)$/);
    if (!match) throw new Error(`GIMP did not answer: ${printed.slice(0, 300)}`);
    if (match[1]) throw new Error(`GIMP: ${match[1]}`);
    return match[2].trim();
  }

  async blankSlide(color: string): Promise<GimpResult> {
    await this.closeAll();
    await this.execPython(
      [
        `_img = Gimp.Image.new(${SLIDE.width}, ${SLIDE.height}, Gimp.ImageBaseType.RGB)`,
        `_layer = Gimp.Layer.new(_img, 'Background', ${SLIDE.width}, ${SLIDE.height}, Gimp.ImageType.RGB_IMAGE, 100, Gimp.LayerMode.NORMAL)`,
        '_img.insert_layer(_layer, None, 0)',
        `Gimp.context_set_background(Gegl.Color.new(${JSON.stringify(color)}))`,
        '_layer.edit_fill(Gimp.FillType.BACKGROUND)',
      ].join('\n'),
    );
    return { text: JSON.stringify({ width: SLIDE.width, height: SLIDE.height, fill: color }) };
  }

  // A new slide: the background color and the photo as its own "Photo" layer,
  // so the designer can reframe it later without losing the other layers.
  // A cutout is contained instead of covering: the product goes whole over the color.
  async placePhoto(filePath: string, focusX: number, focusY: number, background = '#111111', cutout = false): Promise<Frame> {
    await this.blankSlide(background);
    let zoom = 1;
    if (cutout) {
      const { width = 1, height = 1 } = await sharp(filePath).metadata();
      const cover = Math.max(SLIDE.width / width, SLIDE.height / height);
      zoom = (Math.min(SLIDE.width / width, SLIDE.height / height) / cover) * 0.84;
    }
    return this.framePhoto(filePath, zoom, cutout ? 0.5 : focusX, cutout ? 0.5 : focusY);
  }

  // Scales the original photo to cover the slide times `zoom` (below 1 it leaves
  // the background visible around it) and keeps (focusX, focusY) — 0..1 of the
  // photo — as centered as the frame allows. Replaces any previous "Photo" layer.
  async framePhoto(filePath: string, zoom: number, focusX: number, focusY: number): Promise<Frame> {
    const { width = 1, height = 1 } = await sharp(filePath).metadata();
    const scale = Math.max(SLIDE.width / width, SLIDE.height / height) * clamp(zoom, 0.3, 3);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const place = (focus: number, size: number, canvas: number) => {
      const centered = Math.round(canvas / 2 - focus * size);
      // Larger than the slide: never show an edge. Smaller: stay inside it.
      return size >= canvas ? clamp(centered, canvas - size, 0) : clamp(centered, 0, canvas - size);
    };
    const x = place(focusX, w, SLIDE.width);
    const y = place(focusY, h, SLIDE.height);
    await this.execPython(
      [
        '_img = Gimp.get_images()[0]',
        'for _l in _img.get_layers():',
        "    if _l.get_name() == 'Photo':",
        '        _img.remove_layer(_l)',
        "_bg = [_l for _l in _img.get_layers() if _l.get_name() == 'Background']",
        '_pos = _img.get_item_position(_bg[0]) if _bg else len(_img.get_layers())',
        `_p = Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, _img, Gio.File.new_for_path(${JSON.stringify(filePath)}))`,
        "_p.set_name('Photo')",
        '_img.insert_layer(_p, None, _pos)',
        'Gimp.context_set_interpolation(Gimp.InterpolationType.CUBIC)',
        `_p.scale(${w}, ${h}, False)`,
        `_p.set_offsets(${x}, ${y})`,
        'Gimp.displays_flush()',
      ].join('\n'),
      { openWindow: false },
    );
    return { w, h, x, y };
  }

  // A full-slide color layer right above the photo, so a backdrop's baked-in text
  // never competes with the slide's own. The designer can tune its opacity.
  async addShade(color: string, opacity: number): Promise<void> {
    await this.execPython(
      [
        '_img = Gimp.get_images()[0]',
        "_ph = [_l for _l in _img.get_layers() if _l.get_name() == 'Photo']",
        '_pos = _img.get_item_position(_ph[0]) if _ph else 0',
        `_s = Gimp.Layer.new(_img, 'Shade', ${SLIDE.width}, ${SLIDE.height}, Gimp.ImageType.RGBA_IMAGE, ${opacity}, Gimp.LayerMode.NORMAL)`,
        '_img.insert_layer(_s, None, _pos)',
        `Gimp.context_set_background(Gegl.Color.new(${JSON.stringify(color)}))`,
        '_s.edit_fill(Gimp.FillType.BACKGROUND)',
      ].join('\n'),
      { openWindow: false },
    );
  }

  // Adds the logo as its own top layer, scaled to `width` px wide at (x, y).
  async placeLogo(filePath: string, x: number, y: number, width: number): Promise<GimpResult> {
    const w = Math.round(width);
    await this.execPython(
      [
        '_img = Gimp.get_images()[0]',
        `_logo = Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, _img, Gio.File.new_for_path(${JSON.stringify(filePath)}))`,
        "_logo.set_name('Logo')",
        '_img.insert_layer(_logo, None, 0)',
        `_logo.scale(${w}, max(1, int(_logo.get_height() * ${w} / _logo.get_width())), False)`,
        `_logo.set_offsets(${Math.round(x)}, ${Math.round(y)})`,
        'Gimp.displays_flush()',
      ].join('\n'),
      { openWindow: false },
    );
    return { text: JSON.stringify({ layer: 'Logo', x, y, width: w }) };
  }

  // Backgrounds and textures cover the slide and go right above the bottom
  // layer; elements go on top at (x, y), `width` px wide.
  async placeImage(filePath: string, x: number, y: number, width: number, kind: string): Promise<GimpResult> {
    const full = kind !== 'element';
    const w = full ? SLIDE.width : Math.round(width || 300);
    const name = kind.charAt(0).toUpperCase() + kind.slice(1);
    await this.execPython(
      [
        '_img = Gimp.get_images()[0]',
        `_layer = Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, _img, Gio.File.new_for_path(${JSON.stringify(filePath)}))`,
        `_layer.set_name(${JSON.stringify(name)})`,
        `_img.insert_layer(_layer, None, ${full ? 'max(0, len(_img.get_layers()) - 1)' : '0'})`,
        full
          ? `_layer.scale(${SLIDE.width}, ${SLIDE.height}, False)`
          : `_layer.scale(${w}, max(1, int(_layer.get_height() * ${w} / _layer.get_width())), False)`,
        `_layer.set_offsets(${full ? 0 : Math.round(x)}, ${full ? 0 : Math.round(y)})`,
        'Gimp.displays_flush()',
      ].join('\n'),
      { openWindow: false },
    );
    return { text: JSON.stringify({ layer: name, full, x: full ? 0 : x, y: full ? 0 : y, width: w }) };
  }

  async saveXcf(filePath: string): Promise<void> {
    await this.call('save_xcf', { file_path: filePath });
  }

  // Runs a script on the open slide and returns what it leaves in `_result`
  // (anything json can dump). Templates use it to measure text in GIMP.
  async python(code: string): Promise<unknown> {
    const out = await this.execPython(`import json\n_result = None\n${code}\n_carousel_out = json.dumps(_result)`, { openWindow: false });
    return JSON.parse(out || 'null');
  }

  // Reopens a slide saved as XCF, with all its layers, for an edit round.
  async openXcf(filePath: string): Promise<void> {
    await this.closeAll();
    await this.execPython(`_img = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, Gio.File.new_for_path(${JSON.stringify(filePath)}))`);
  }

  // GIMP 3 blends in linear light and browsers in sRGB, so a 30 % layer looks
  // lighter in GIMP than in the HyperFrames card. Perceptual blending on every
  // layer makes the approved slide and the animated card the same picture.
  async perceptualBlending(): Promise<void> {
    await this.execPython(
      [
        'def _perceptual(_items):',
        '    for _l in _items:',
        '        _l.set_composite_space(Gimp.LayerColorSpace.RGB_PERCEPTUAL)',
        '        _l.set_blend_space(Gimp.LayerColorSpace.RGB_PERCEPTUAL)',
        '        if _l.is_group():',
        '            _perceptual(_l.get_children())',
        '_perceptual(Gimp.get_images()[0].get_layers())',
        'Gimp.displays_flush()',
      ].join('\n'),
      { openWindow: false },
    );
  }

  // Every top-level layer of the open slide as a full-canvas transparent PNG
  // (so the HTML only stacks them at 0,0), with its box, kind and text.
  async exportLayers(dir: string): Promise<LayerInfo[]> {
    const manifest = path.join(dir, 'layers.json');
    await this.execPython(
      [
        'import json, os',
        '_img = Gimp.get_images()[0]',
        '_layers = _img.get_layers()',
        '_out = []',
        'for _i, _l in enumerate(_layers):',
        '    if not _l.get_visible():',
        '        continue',
        '    _dup = _img.duplicate()',
        '    for _j, _x in enumerate(_dup.get_layers()):',
        '        _x.set_visible(_j == _i)',
        '    _dup.merge_visible_layers(Gimp.MergeType.CLIP_TO_IMAGE)',
        `    _file = os.path.join(${JSON.stringify(dir)}, 'L%d.png' % _i)`,
        '    Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, _dup, Gio.File.new_for_path(_file), None)',
        '    _dup.delete()',
        '    _o = _l.get_offsets()',
        "    _kind = 'text' if _l.is_text_layer() else ('group' if _l.is_group() else 'raster')",
        "    _text = _l.get_text() if _l.is_text_layer() else ''",
        "    _o2 = {'id': 'L%d' % _i, 'name': _l.get_name(), 'kind': _kind, 'text': _text or '', 'x': _o[-2], 'y': _o[-1], 'w': _l.get_width(), 'h': _l.get_height(), 'opacity': _l.get_opacity(), 'file': _file}",
        '    if _kind == "text":',
        '        try:',
        "            _o2['font'] = _l.get_font().get_name()",
        '            _fs = _l.get_font_size()',
        "            _o2['size'] = _fs[0] if isinstance(_fs, (tuple, list)) else _fs",
        '            _c = _l.get_color().get_rgba()',
        // get_rgba is linear light; the HTML needs sRGB.
        "            _srgb = lambda v: 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055",
        "            _o2['color'] = '#%02x%02x%02x' % tuple(int(round(max(0, min(1, _srgb(v))) * 255)) for v in _c[:3])",
        "            _o2['justify'] = ['left', 'right', 'center', 'fill'][int(_l.get_justification())]",
        '        except Exception:',
        '            pass',
        '    _out.append(_o2)',
        `with open(${JSON.stringify(manifest)}, 'w', encoding='utf-8') as _f:`,
        '    json.dump(_out, _f)',
      ].join('\n'),
      { openWindow: false },
    );
    // Top of the stack first in GIMP; the HTML paints in the reverse order.
    return JSON.parse(await readFile(manifest, 'utf8')) as LayerInfo[];
  }

  async snapshot(maxSize = 768): Promise<string> {
    const { imageBase64 } = await this.call('get_state_snapshot', { max_size: maxSize });
    if (!imageBase64) throw new Error('GIMP returned no snapshot');
    return imageBase64;
  }

  async exportPng(filePath: string): Promise<void> {
    await this.call('export_image', { file_path: filePath, format: 'png', flatten: true });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function indent(code: string): string {
  return code
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function withoutImageIndex(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  delete properties.image_index;
  const required = ((schema.required as string[]) ?? []).filter((r) => r !== 'image_index');
  return { ...schema, properties, required };
}
