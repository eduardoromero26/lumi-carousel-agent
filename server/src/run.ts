import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { DesignSystem, Tweaks } from './design.js';
import type { Site } from './site.js';

// owner: the business owner's own messages in the team chat.
export type Agent = 'analyst' | 'director' | 'designer' | 'critic' | 'motion' | 'system' | 'owner';

export type RunEvent = {
  seq: number;
  at: string;
  type: 'status' | 'assets' | 'thought' | 'tool' | 'snapshot' | 'review' | 'slide' | 'video' | 'done' | 'error';
  agent: Agent;
  text: string;
  slide?: number;
  data?: unknown;
  // What the run had spent when this happened: dollars and model tokens.
  cost?: number;
  tokens?: number;
};

export type Brief = {
  business?: string;
  url?: string;
  goal?: string;
  language?: string;
  audience?: string;
  brandColors?: string[];
  // A design from the style gallery (references.ts) the carousel follows.
  reference?: string;
};

// A backdrop is a website image with text baked in: it is shown whole in a window,
// never under the slide's text.
// A cutout is a product shown whole instead of covering the slide: on a transparent
// background (over the brand color) or on a plain studio background, its "matte".
// "content" is where the product sits in the file (0..1, its margins trimmed) and
// "cropped" a studio shot whose product is cut by the file's own edge.
export type Photo = {
  id: string;
  path: string;
  note?: string;
  backdrop?: boolean;
  cutout?: boolean;
  matte?: string;
  content?: { x1: number; y1: number; x2: number; y2: number };
  cropped?: boolean;
  // A cutout whose subject reaches its photo's bottom edge (a person cut at the waist): it stands on the slide's foot.
  grounded?: boolean;
  // A cutout of a person: only a person cut at the waist may bleed off the slide's foot.
  person?: boolean;
  // The cutout at its photo's full size, in place: it lines up with the photo (a reference
  // layout puts it in front of a giant word drawn over the photo).
  aligned?: string;
  // The website asset it comes from (none for the owner's uploads).
  asset?: string;
};

export type Asset = {
  id: string;
  path: string;
  source: string;
  alt: string;
  hint: string;
  width: number;
  height: number;
  transparent: boolean;
  kind?: 'logo' | 'icon' | 'product' | 'food' | 'place' | 'people' | 'work' | 'banner' | 'graphic' | 'other';
  description?: string;
  hasText?: boolean;
  quality?: number;
  // Made by an image AI (its file name or how it looks): never used as a photo.
  aiMade?: boolean;
  // Text of the card the image sits in on the site (a product's name and price).
  context?: string;
  // Logos: the flat background color when the file has one, and how light the mark is (0..1).
  matte?: string;
  tone?: number;
  // A transparent logo that is a solid shape (an app icon, a badge): it carries its own ground.
  badge?: boolean;
};

// The models sometimes answer the hashtags as one string ("#a #b") instead of a list.
export function hashtagList(raw: unknown): string[] {
  const all = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  return all.map((h) => h.trim()).filter(Boolean).map((h) => (h.startsWith('#') ? h : `#${h}`));
}

export type SlidePlan = {
  n: number;
  // Started over after a final score under 5: the photo whole, the plain skeleton, no reference.
  fresh?: boolean;
  role: string;
  photo: string | null;
  headline: string;
  body: string;
  visual: string;
  focus?: { x: number; y: number };
  // What must stay visible in the photo, for SAM ("taco plate").
  subject?: string;
  // The director wants the product isolated from its photo's background (SAM mask).
  cut_out?: boolean;
  // The template the slide is built with, a short label above the headline and,
  // on the call to action, the button text.
  layout?: 'cover' | 'product' | 'hero' | 'photo_band' | 'poster' | 'cta';
  eyebrow?: string;
  button?: string;
  // The word or two of the headline that carry it, set in the accent color.
  emphasis?: string;
  // The slide's topic in a word or two ("Melasma"), for a reference layout's giant title.
  kicker?: string;
  // Where SAM found the subject: 0..1 of the photo, and in slide pixels for the current frame.
  subjectNorm?: { x1: number; y1: number; x2: number; y2: number };
  subjectBox?: { x1: number; y1: number; x2: number; y2: number };
  // Faces in the photo (0..1) and on the slide; text must never cover them.
  facesNorm?: { x1: number; y1: number; x2: number; y2: number }[];
  faces?: { x1: number; y1: number; x2: number; y2: number }[];
  // Where the Photo layer sits now (the designer can reframe it).
  frame?: { w: number; h: number; x: number; y: number };
  // The photo SAM looked at (subjectNorm and facesNorm belong to it).
  seen?: string;
  // The template's settings for this slide, chosen by the fixer.
  tweaks?: Tweaks;
};

export type Plan = {
  // What the business is and the kind of carousel that sells it: a store gets a catalog.
  business_type?: string;
  format?: 'catalog' | 'benefits' | 'proof' | 'how_it_works' | 'offer';
  concept: string;
  why: string;
  slides: SlidePlan[];
  caption: string;
  hashtags: string[];
};

export type RunStatus = 'running' | 'done' | 'failed';

// Events after which the run is saved to run.json, so a server restart doesn't
// lose a finished carousel (it can still be edited or animated).
const SAVE_ON = new Set<RunEvent['type']>(['assets', 'slide', 'video', 'done', 'error']);

// The owner's changes to the director's plan: words, the photo of each slide, slides out.
export type PlanReview = {
  slides: { n: number; headline?: string; body?: string; button?: string; photo?: string; remove?: boolean }[];
  note?: string;
  // Website images (asset ids) the owner doesn't want on the slides.
  exclude?: string[];
};

export class Run {
  readonly id: string;
  dir: string;
  status: RunStatus = 'running';
  photos: Photo[] = [];
  assets: Asset[] = [];
  // A run from Create: the owner reviews the director's plan before the design starts.
  interactive = false;
  // While the plan waits for the owner: hands the owner's review to the pipeline.
  planReview?: (review: PlanReview | null) => void;
  // Once the owner starts changing the plan: it waits for their approval.
  planHold?: () => void;
  logo?: Asset;
  // White or light version of the logo, for dark backgrounds.
  logoLight?: Asset;
  site?: Site;
  // The carousel's visual system, and its description for the designer and critic.
  system?: DesignSystem;
  styleNotes?: string;
  // The reference that styled the carousel: picked by the owner or by the art director.
  styleRef?: { id: string; title: string; by: 'owner' | 'agent' };
  plan?: Plan;
  // templateIssues: what the critic found that no action of the fixer resolves.
  slides: { n: number; file: string; approved: boolean; rounds: number; templateIssues?: string[] }[] = [];
  events: RunEvent[] = [];
  // Spend of this run in US$ (model tokens, images, SAM), saved with the run.
  cost = 0;
  tokens = 0;
  syncCost: () => void = () => {};
  private listeners = new Set<(e: RunEvent) => void>();

  constructor(
    readonly brief: Brief,
    id = randomUUID().slice(0, 8),
  ) {
    this.id = id;
    this.dir = path.join(config.runsDir, id);
  }

  static async load(id: string): Promise<Run | undefined> {
    if (!/^[a-z0-9-]+$/i.test(id)) return undefined;
    const raw = await readFile(path.join(config.runsDir, id, 'run.json'), 'utf8').catch(() => null);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as ReturnType<Run['toJson']>;
    const run = new Run(saved.brief, id);
    run.status = saved.status === 'running' ? 'failed' : saved.status;
    run.photos = saved.photos;
    run.assets = saved.assets;
    run.logo = run.assets.find((a) => a.id === saved.logo);
    run.logoLight = run.assets.find((a) => a.id === saved.logoLight);
    run.site = saved.site;
    run.styleNotes = saved.styleNotes;
    run.styleRef = saved.styleRef;
    run.system = saved.system;
    run.plan = saved.plan;
    run.slides = saved.slides;
    run.events = saved.events;
    run.cost = saved.cost ?? 0;
    return run;
  }

  toJson() {
    return {
      id: this.id,
      status: this.status,
      brief: this.brief,
      photos: this.photos,
      assets: this.assets,
      logo: this.logo?.id,
      logoLight: this.logoLight?.id,
      site: this.site,
      styleNotes: this.styleNotes,
      styleRef: this.styleRef,
      system: this.system,
      plan: this.plan,
      slides: this.slides,
      events: this.events,
      cost: this.cost,
    };
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.dir, 'photos'), { recursive: true });
  }

  // Also keeps the feed's index up to date (set by the server).
  static onSave: (run: Run) => void = () => {};

  // The owner pressed Stop: the next event the agents emit ends the run.
  stopRequested = false;

  emit(type: RunEvent['type'], agent: Agent, text: string, extra: Partial<RunEvent> = {}): void {
    // It stays on until the run ends, so no agent's own error handling can swallow it.
    if (this.stopRequested && type !== 'error' && type !== 'done') throw new Error('Stopped by the owner.');
    this.syncCost();
    const event: RunEvent = { seq: this.events.length, at: new Date().toISOString(), type, agent, text, cost: Math.round(this.cost * 10000) / 10000, tokens: this.tokens, ...extra };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    if (SAVE_ON.has(type)) {
      writeFileSync(path.join(this.dir, 'run.json'), JSON.stringify(this.toJson()));
      Run.onSave(this);
    }
    console.log(`[${this.id}] ${agent}/${type}${event.slide ? ` #${event.slide}` : ''}: ${text.slice(0, 160)}`);
  }

  subscribe(listener: (e: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fileUrl(file: string): string {
    return `/files/${this.id}/${path.relative(this.dir, file).split(path.sep).join('/')}`;
  }

  summary() {
    return {
      id: this.id,
      status: this.status,
      brief: this.brief,
      photos: this.photos.map((p) => ({ id: p.id, note: p.note, backdrop: p.backdrop, cutout: p.cutout, matte: p.matte, url: this.fileUrl(p.path) })),
      assets: this.assets.map((a) => ({ id: a.id, kind: a.kind, description: a.description, url: this.fileUrl(a.path) })),
      logo: this.logo?.id,
      plan: this.plan,
      slides: this.slides.map((s) => ({ ...s, url: `/files/${this.id}/${s.file}` })),
    };
  }
}
