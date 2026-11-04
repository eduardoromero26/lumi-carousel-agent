// Adds every image of a folder to the reference gallery of a running server, so the
// style picker has designs to choose from. The gallery is not in the repo: it holds
// other brands' ads.
//   node scripts/add-references.mjs <folder> [http://localhost:8787]
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const [folder, server = 'http://localhost:8787'] = process.argv.slice(2);
if (!folder) {
  console.error('Usage: node scripts/add-references.mjs <folder> [server]');
  process.exit(1);
}

const images = (await readdir(folder)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
if (!images.length) {
  console.error(`No PNG, JPG or WebP images in ${folder}`);
  process.exit(1);
}

let added = 0;
for (const name of images) {
  const base64 = (await readFile(path.join(folder, name))).toString('base64');
  // The server reads each design's style with a vision model: one at a time.
  const res = await fetch(`${server}/api/references`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, base64 }),
  });
  if (res.ok) {
    added++;
    console.log(`+ ${name}`);
  } else {
    console.error(`x ${name}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
  }
}
console.log(`${added} of ${images.length} added to the gallery.`);
