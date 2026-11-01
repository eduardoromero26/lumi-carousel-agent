import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeOneBitMask } from '../src/sam_mask.js';

// A reference encoder written from the same spec (meta-models/meta-sam, protocol/sam3.md):
// the same 12-pixel context model and carry-less range coder, run forward.
const ALPHABET = (() => {
  let value = '';
  for (let code = 0x21; code <= 0x7e && value.length < 85; code++) {
    const c = String.fromCharCode(code);
    if (!'"\\,;<>|'.includes(c)) value += c;
  }
  return value;
})();
const TOP = 1 << 24;
const BOTTOM = 1 << 16;

function encodeOneBitMask(mask: Uint8Array, width: number, height: number): string {
  return `!${pack(rangeCode(mask, width, height))}`;
}

function rangeCode(mask: Uint8Array, width: number, height: number): number[] {
  const bytes: number[] = [];
  let low = 0;
  let range = 0xffffffff;
  const pad = 2;
  const paddedWidth = width + 2 * pad;
  const padded = new Uint8Array(paddedWidth * (height + pad));
  const counts = new Uint16Array((1 << 12) * 2).fill(1);
  for (let y = 0; y < height; y++) {
    const row = (y + pad) * paddedWidth + pad;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const a = p - paddedWidth;
      const b = p - 2 * paddedWidth;
      const context =
        padded[p - 1] | (padded[p - 2] << 1) | (padded[a - 2] << 2) | (padded[a - 1] << 3) | (padded[a] << 4) | (padded[a + 1] << 5) |
        (padded[a + 2] << 6) | (padded[b - 2] << 7) | (padded[b - 1] << 8) | (padded[b] << 9) | (padded[b + 1] << 10) | (padded[b + 2] << 11);
      const o = context << 1;
      const zero = counts[o];
      const one = counts[o + 1];
      const bit = mask[y * width + x];
      const scaled = Math.floor(range / (zero + one));
      low = (low + scaled * (bit ? zero : 0)) >>> 0;
      range = scaled * (bit ? one : zero);
      for (;;) {
        if (((low ^ (low + range)) >>> 0) >= TOP) {
          if (range >= BOTTOM) break;
          range = (-low >>> 0) & (BOTTOM - 1);
        }
        bytes.push(low >>> 24);
        low = (low << 8) >>> 0;
        range = (range << 8) >>> 0;
      }
      padded[p] = bit;
      counts[o + bit] += 14;
      if (counts[o] + counts[o + 1] >= 4096) {
        counts[o] = counts[o] >> 1 || 1;
        counts[o + 1] = counts[o + 1] >> 1 || 1;
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    bytes.push(low >>> 24);
    low = (low << 8) >>> 0;
  }
  return bytes;
}

function digits(value: number, count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) {
    s = ALPHABET[value % 85] + s;
    value = Math.floor(value / 85);
  }
  return s;
}

function pack(bytes: number[]): string {
  let s = digits(bytes.length, 5);
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    let value = 0;
    for (let k = 0; k < 4; k++) value = value * 256 + (k < n ? bytes[i + k] : 0);
    s += digits(value, 5).slice(0, n + 1);
  }
  return s;
}

function random(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function roundTrip(mask: Uint8Array, width: number, height: number): void {
  assert.deepEqual(decodeOneBitMask(encodeOneBitMask(mask, width, height), width, height), mask);
}

test('decodes an empty mask', () => {
  roundTrip(new Uint8Array(7 * 5), 7, 5);
});

test('decodes a solid subject inside the box', () => {
  const [w, h] = [40, 30];
  const mask = new Uint8Array(w * h);
  for (let y = 6; y < 24; y++) for (let x = 10; x < 31; x++) mask[y * w + x] = 1;
  roundTrip(mask, w, h);
});

test('decodes noise, where the context model helps least', () => {
  const [w, h] = [23, 17];
  const next = random(7);
  roundTrip(Uint8Array.from({ length: w * h }, () => (next() < 0.5 ? 1 : 0)), w, h);
});

test('decodes a large mask with long runs', () => {
  const [w, h] = [256, 192];
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = (x - 128) ** 2 + (y - 96) ** 2 < 70 ** 2 ? 1 : 0;
  roundTrip(mask, w, h);
});

test('rejects formats other than one_bit', () => {
  assert.throws(() => decodeOneBitMask('abc', 1, 1), /only one_bit/);
});

test('rejects characters outside the base85 alphabet', () => {
  assert.throws(() => decodeOneBitMask('!"""""', 1, 1), /invalid character/);
});

test('rejects a payload cut short', () => {
  const [w, h] = [40, 30];
  const next = random(3);
  const bytes = rangeCode(Uint8Array.from({ length: w * h }, () => (next() < 0.5 ? 1 : 0)), w, h);
  assert.throws(() => decodeOneBitMask(`!${pack(bytes.slice(0, bytes.length >> 1))}`, w, h), /ended early/);
});
