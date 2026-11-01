// Decoder for SAM 3.1 "one_bit" masks, written from the wire format that Meta
// documents in github.com/meta-models/meta-sam (protocol/sam3.md): a base85 payload
// with a length prefix, holding a binary range coder whose bits are modeled on a
// 12-pixel causal context. Returns a row-major raster of 0/1, height x width.

const ALPHABET = (() => {
  let value = '';
  for (let code = 0x21; code <= 0x7e && value.length < 85; code++) {
    const c = String.fromCharCode(code);
    if (!'"\\,;<>|'.includes(c)) value += c;
  }
  return value;
})();
const DIGIT = new Map([...ALPHABET].map((c, i) => [c, i]));

function digit(c: string): number {
  const v = DIGIT.get(c);
  if (v === undefined) throw new Error('SAM mask: invalid character');
  return v;
}

// Five base85 digits of length, then four bytes per five digits (big endian),
// with a short last group.
function unpack(payload: string): Uint8Array {
  let length = 0;
  for (let i = 0; i < 5; i++) length = length * 85 + digit(payload[i]);
  const out = new Uint8Array(length);
  let src = 5;
  for (let dst = 0; dst < length; dst += 4) {
    const n = Math.min(4, length - dst);
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + (i < n + 1 ? digit(payload[src + i]) : 84);
    src += n + 1;
    for (let i = 0; i < n; i++) out[dst + i] = Math.floor(value / 2 ** (24 - 8 * i)) & 0xff;
  }
  return out;
}

const TOP = 1 << 24;
const BOTTOM = 1 << 16;

export function decodeOneBitMask(payload: string, width: number, height: number): Uint8Array {
  if (!payload.startsWith('!')) throw new Error('SAM mask: only one_bit masks are supported');
  const input = unpack(payload.slice(1));
  let pos = 0;
  const read = () => {
    if (pos >= input.length) throw new Error('SAM mask: payload ended early');
    return input[pos++];
  };
  let low = 0;
  let range = 0xffffffff;
  let code = 0;
  for (let i = 0; i < 4; i++) code = ((code << 8) | read()) >>> 0;

  const pad = 2;
  const paddedWidth = width + 2 * pad;
  const padded = new Uint8Array(paddedWidth * (height + pad));
  const counts = new Uint16Array((1 << 12) * 2).fill(1);
  const out = new Uint8Array(width * height);

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
      const scaled = Math.floor(range / (zero + one));
      if (!scaled) throw new Error('SAM mask: invalid coding state');
      const value = Math.min(Math.floor(((code - low) >>> 0) / scaled), zero + one - 1);
      const bit = value < zero ? 0 : 1;
      low = (low + scaled * (bit ? zero : 0)) >>> 0;
      range = scaled * (bit ? one : zero);
      // Renormalize: shift a byte in while the top byte is settled or the range is too small.
      for (;;) {
        if (((low ^ (low + range)) >>> 0) >= TOP) {
          if (range >= BOTTOM) break;
          range = (-low >>> 0) & (BOTTOM - 1);
        }
        code = ((code << 8) | read()) >>> 0;
        low = (low << 8) >>> 0;
        range = (range << 8) >>> 0;
      }
      padded[p] = bit;
      out[y * width + x] = bit;
      counts[o + bit] += 14;
      if (counts[o] + counts[o + 1] >= 4096) {
        counts[o] = counts[o] >> 1 || 1;
        counts[o + 1] = counts[o + 1] >> 1 || 1;
      }
    }
  }
  return out;
}
