import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in server/.env`);
  return value;
}

export const config = {
  modelApiKey: required('MODEL_API_KEY'),
  modelBaseUrl: process.env.MODEL_BASE_URL ?? 'https://api.meta.ai/v1',
  modelId: process.env.MODEL_ID ?? 'muse-spark-1.3',
  imageModelId: process.env.IMAGE_MODEL_ID ?? 'muse-image-1.0',
  // The art director: one call per carousel that sets the visual system and its decor kit.
  artModelId: process.env.ART_MODEL_ID ?? 'muse-wonder-1.0',
  // A Chromium browser for the website's screenshots: the first one that exists.
  browser: [
    process.env.BROWSER_PATH ?? '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean),
  hyperframesVersion: process.env.HYPERFRAMES_VERSION ?? '0.8.210',
  samModelId: process.env.SAM_MODEL_ID ?? 'sam-3.1',
  gimpPython: required('GIMP_MCP_PYTHON'),
  gimpServer: required('GIMP_MCP_SERVER'),
  // gimp-console executable: when set, the server starts GIMP headless by itself.
  gimpConsole: process.env.GIMP_CONSOLE ?? '',
  gimpPort: Number(process.env.GIMP_MCP_PORT ?? 9877),
  // Where GIMP 3.2 reads user fonts; the brand's Google Fonts are installed here.
  gimpFontsDir:
    process.env.GIMP_FONTS_DIR ??
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? '', 'GIMP', '3.2', 'fonts')
      : path.join(process.env.HOME ?? '', '.config', 'GIMP', '3.2', 'fonts')),
  port: Number(process.env.PORT ?? 8787),
  maxRevisions: Number(process.env.MAX_REVISIONS ?? 1),
  maxDesignSteps: Number(process.env.MAX_DESIGN_STEPS ?? 20),
  // Reels are off: a 30 s reel takes as long as a whole carousel, and the demo needs many runs.
  // REELS=1 brings back the button, the endpoints and the reels in the feed.
  reels: process.env.REELS === '1',
  // A rejected reel is rendered again only below this critic score.
  reelRetryBelow: Number(process.env.REEL_RETRY_BELOW ?? 5),
  runsDir: path.resolve('runs'),
  // The built Flutter app, served at / so everything runs on one URL.
  webDir: path.resolve('../app/build/web'),
};

// Instagram/Facebook carousel portrait size (4:5).
export const SLIDE = { width: 1080, height: 1350 } as const;
