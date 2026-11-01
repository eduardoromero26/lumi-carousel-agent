// Smoke test: starts or reuses GIMP, builds a test slide and exports it.
// Pass a photo path to also test placing and cropping a photo.
import path from 'node:path';
import { SLIDE } from './config.js';
import { Gimp } from './gimp.js';
import { ensureGimp, stopGimp } from './gimp_process.js';

console.log(`GIMP: ${await ensureGimp()}`);
const gimp = new Gimp();
await gimp.connect();
console.log(`Connected. Designer tools: ${gimp.designerTools().length}`);
await gimp.blankSlide('#1b1b1f');
await gimp.call('add_text', { text: 'Hello from the agent', x: 80, y: 600, size: 90, color: 'white', font: 'Sans' });
const out = path.resolve('runs', 'check-gimp.png');
await gimp.exportPng(out);
const snap = await gimp.snapshot(256);
console.log(`Exported ${SLIDE.width}x${SLIDE.height} to ${out}; snapshot ${Math.round(snap.length / 1024)} KB base64`);
const photo = process.argv[2];
if (photo) {
  await gimp.placePhoto(path.resolve(photo), 0.5, 0.5);
  await gimp.exportPng(path.resolve('runs', 'check-photo.png'));
  console.log('Placed and cropped the photo: runs/check-photo.png');
}
await gimp.closeAll();
await gimp.close();
stopGimp();
