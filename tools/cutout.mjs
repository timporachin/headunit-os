#!/usr/bin/env node
/*
 * cutout.mjs — put the transparency back into a flattened PNG.
 *
 * The case this exists for: you copy an image that HAS transparency, paste it
 * somewhere that draws the transparency as a grey checkerboard, and save that.
 * The checkerboard is now pixels. The file looks right in a thumbnail and wrong
 * the moment anything composites it — which on this head unit means a tiled
 * grey rectangle sitting behind the boot emblem. It also handles the plainer
 * case of a flat white or black background.
 *
 *   node tools/cutout.mjs shell/assets/emblem.png
 *
 * The original is kept beside it as <name>.original.png, so a bad result costs
 * you a rename and nothing else. Running it against an already-clean file is a
 * near no-op — it reports that the border is already transparent and stops.
 *
 * No dependencies. Node's zlib does the compression and everything else is in
 * this file, because the whole point of this repo is that you install nothing
 * to run the shell, and a one-off image fix is no reason to break that.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import path from 'node:path';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/* zlib.crc32 exists only on newer Node, and this file has to run wherever the
   shell runs. Two hundred bytes of table is cheaper than a version check. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/* ── Decode ─────────────────────────────────────────────────────────────── */

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('this is not a PNG — the file signature is wrong. A .png name on a JPEG is the usual cause.');
  }
  const chunks = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function unfilter(raw, height, bytesPerRow, bpp) {
  const out = Buffer.alloc(height * bytesPerRow);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const type = raw[pos++];
    const src = pos;
    const o = y * bytesPerRow;
    const up = o - bytesPerRow;
    for (let x = 0; x < bytesPerRow; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
      let r;
      switch (type) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`unknown filter type ${type} on row ${y} — the file is damaged`);
      }
      out[o + x] = r & 0xff;
    }
    pos += bytesPerRow;
  }
  return out;
}

/** Any supported PNG in, straight 8-bit RGBA out. */
function decode(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('no IHDR chunk — the file is damaged');

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (interlace !== 0) throw new Error('interlaced PNGs are not supported. Re-save without interlacing.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`unsupported bit depth ${depth}`);

  const palette = chunks.find((c) => c.type === 'PLTE')?.data;
  const trns = chunks.find((c) => c.type === 'tRNS')?.data;
  if (colorType === 3 && !palette) throw new Error('palette image with no PLTE chunk — the file is damaged');

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  if (!idat.length) throw new Error('no image data');
  const raw = inflateSync(idat);

  const bitsPerPixel = channels * depth;
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const lines = unfilter(raw, height, bytesPerRow, bpp);

  const max = (1 << depth) - 1;
  /* One sample, whatever the bit depth. 16-bit takes the high byte: this tool
     writes 8-bit, and the low byte cannot survive that anyway. */
  const sample = (row, i) => {
    if (depth === 16) return row[i * 2];
    if (depth === 8) return row[i];
    const perByte = 8 / depth;
    const shift = 8 - depth * ((i % perByte) + 1);
    return (row[Math.floor(i / perByte)] >> shift) & max;
  };
  const scale = (v) => (depth < 8 ? Math.round((v * 255) / max) : v);

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = lines.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(row, x);
        data[o] = palette[idx * 3];
        data[o + 1] = palette[idx * 3 + 1];
        data[o + 2] = palette[idx * 3 + 2];
        data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = scale(sample(row, x * channels));
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = colorType === 4 ? scale(sample(row, x * channels + 1)) : 255;
      } else {
        data[o] = sample(row, x * channels);
        data[o + 1] = sample(row, x * channels + 1);
        data[o + 2] = sample(row, x * channels + 2);
        data[o + 3] = colorType === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return { width, height, data, colorType, depth };
}

/* ── Encode ─────────────────────────────────────────────────────────────── */

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encode({ width, height, data }) {
  const px = Buffer.from(data.buffer, data.byteOffset, data.length);
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const zero = Buffer.alloc(stride);
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  let p = 0;

  for (let y = 0; y < height; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : zero;
    let bestType = 0, bestScore = Infinity, best = candidates[0];

    /* Try all five filters and keep the flattest row. It costs five passes on a
       one-off tool and buys real compression, which matters because a cut-out
       badge is mostly a large field of identical transparent pixels. */
    for (let t = 0; t <= 4; t++) {
      const out = candidates[t];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0;
        const b = up[x];
        const c = x >= 4 ? up[x - 4] : 0;
        let v;
        switch (t) {
          case 0: v = row[x]; break;
          case 1: v = row[x] - a; break;
          case 2: v = row[x] - b; break;
          case 3: v = row[x] - ((a + b) >> 1); break;
          default: v = row[x] - paeth(a, b, c); break;
        }
        v &= 0xff;
        out[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestType = t; best = out; }
    }
    raw[p++] = bestType;
    best.copy(raw, p);
    p += stride;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[12] = 0;   // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── The cut ────────────────────────────────────────────────────────────── */

const dist = (d, o, r, g, b) => Math.sqrt((d[o] - r) ** 2 + (d[o + 1] - g) ** 2 + (d[o + 2] - b) ** 2);

/**
 * What the background is made of, read off the border ring.
 *
 * A checkerboard is two colours, a plain backdrop is one, and a subtly
 * gradient one is a handful — so this takes the most common border colours
 * until they account for most of the ring, rather than assuming a count.
 */
function borderColours(img, coverage = 0.9, limit = 8) {
  const counts = new Map();
  let opaque = 0;
  const add = (x, y) => {
    const o = (y * img.width + x) * 4;
    if (img.data[o + 3] < 8) return;
    opaque++;
    const key = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < img.width; x++) { add(x, 0); add(x, img.height - 1); }
  for (let y = 1; y < img.height - 1; y++) { add(0, y); add(img.width - 1, y); }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const colours = [];
  let seen = 0;
  for (const [key, n] of sorted) {
    colours.push([(key >> 16) & 255, (key >> 8) & 255, key & 255]);
    seen += n;
    if (seen / opaque >= coverage || colours.length >= limit) break;
  }
  return { colours, opaque, share: opaque ? seen / opaque : 0 };
}

function cutout(img, { tolerance, feather }) {
  const { width, height, data } = img;
  const { colours, opaque, share } = borderColours(img);
  if (!opaque) return { already: true };

  /* Match by connection, not by colour alone.
   *
   * The Ford script is white and a checkerboard's light square is white too. A
   * global colour key would erase the lettering along with the background. So
   * a pixel is only background if it matches a border colour AND there is an
   * unbroken path of such pixels back to the edge of the image. Anything
   * enclosed by the badge is left alone whatever colour it is. */
  const isBg = new Uint8Array(width * height);
  const bgOf = new Int8Array(width * height).fill(-1);
  const match = (o) => {
    if (data[o + 3] < 8) return -2;        // already transparent
    let best = -1, bestD = Infinity;
    for (let i = 0; i < colours.length; i++) {
      const d = dist(data, o, colours[i][0], colours[i][1], colours[i][2]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD <= tolerance ? best : -1;
  };

  const queue = [];
  const push = (x, y) => {
    const p = y * width + x;
    if (isBg[p]) return;
    const m = match(p * 4);
    if (m === -1) return;
    isBg[p] = 1;
    bgOf[p] = m;
    queue.push(p);
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    const x = p % width, y = (p - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  /* The edge of the badge is antialiased: those pixels are part badge, part
     background, so neither "keep" nor "cut" is right for them. Deciding with a
     threshold is exactly what makes a cut-out look chewed — one pixel falls
     inside the tolerance, the one beside it falls outside, and a smooth curve
     turns ragged. So the band either side of the boundary gets a continuous
     alpha instead: how far the pixel has travelled from the background colour
     toward the badge's own colour, which is what alpha physically means.
     Everything deeper than the band, on both sides, is left alone. */
  const FAR = 0x7fff;
  const spread = (seeds, limit, carry) => {
    const d = new Int16Array(width * height).fill(FAR);
    const q = [];
    for (const p of seeds) { d[p] = 0; q.push(p); carry?.(p, p); }
    for (let h = 0; h < q.length; h++) {
      const p = q[h];
      if (d[p] >= limit) continue;
      const x = p % width, y = (p - x) / width;
      const step = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const n = ny * width + nx;
        if (d[n] !== FAR) return;
        d[n] = d[p] + 1;
        carry?.(n, p);
        q.push(n);
      };
      step(x - 1, y); step(x + 1, y); step(x, y - 1); step(x, y + 1);
    }
    return d;
  };

  const bgSeeds = [], fgSeeds = [];
  for (let p = 0; p < isBg.length; p++) (isBg[p] ? bgSeeds : fgSeeds).push(p);

  // Which background colour is nearest, and how far away it is.
  const nearestBg = new Int8Array(width * height).fill(-1);
  const distBg = spread(bgSeeds, feather + 1, (to, from) => {
    nearestBg[to] = to === from ? bgOf[from] : nearestBg[from];
  });
  const distFg = spread(fgSeeds, feather + 1);

  /* The badge's own colour at the edge, taken from the nearest pixel that is
     safely inside it. Measuring instead from the strongest colour within a
     window was the first thing I tried, and it reads a chrome rim against the
     blue field behind it — the rim then gets the blue's alpha and dissolves. */
  const solidR = new Uint8Array(width * height);
  const solidG = new Uint8Array(width * height);
  const solidB = new Uint8Array(width * height);
  const solidSeeds = [];
  for (let p = 0; p < isBg.length; p++) {
    if (isBg[p] || distBg[p] <= feather || data[p * 4 + 3] < 8) continue;
    solidSeeds.push(p);
  }
  const distSolid = spread(solidSeeds, 2 * feather + 2, (to, from) => {
    const o = (to === from ? from : from) * 4;
    if (to === from) { solidR[to] = data[o]; solidG[to] = data[o + 1]; solidB[to] = data[o + 2]; }
    else { solidR[to] = solidR[from]; solidG[to] = solidG[from]; solidB[to] = solidB[from]; }
  });

  for (let p = 0; p < isBg.length; p++) {
    const inBand = isBg[p] ? distFg[p] <= feather : distBg[p] <= feather;
    if (!inBand) continue;
    const ci = nearestBg[p];
    if (ci < 0) continue;                       // came from an already-clear area
    if (distSolid[p] === FAR) continue;         // nothing solid within reach to match against

    const [br, bgc, bb] = colours[ci];
    const fr = solidR[p], fg = solidG[p], fb = solidB[p];
    const span = Math.sqrt((fr - br) ** 2 + (fg - bgc) ** 2 + (fb - bb) ** 2);
    /* Badge and background the same colour here: nothing to separate them by,
       so leave the flood's own verdict rather than invent a number. */
    if (span < 12) continue;

    const o = p * 4;
    const a = Math.min(1, Math.max(0, dist(data, o, br, bgc, bb) / span));
    if (a <= 0.004) { data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0; isBg[p] = 1; continue; }
    isBg[p] = 0;
    if (a >= 0.996) { data[o + 3] = 255; continue; }

    /* Take the background back out of the blend, or the badge keeps a pale
       rim in the shape of whatever it was sitting on. */
    const unmix = (v, b) => Math.max(0, Math.min(255, Math.round((v - (1 - a) * b) / a)));
    data[o] = unmix(data[o], br);
    data[o + 1] = unmix(data[o + 1], bgc);
    data[o + 2] = unmix(data[o + 2], bb);
    data[o + 3] = Math.round(a * 255);
  }

  let removed = 0;
  for (let p = 0; p < isBg.length; p++) {
    if (!isBg[p]) continue;
    removed++;
    const o = p * 4;
    /* Zero the colour as well as the alpha. Nothing can see it, and a uniform
       field compresses to almost nothing. */
    data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
  }
  return { colours, removed, total: width * height, share };
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const out = flag('out', null);
const tolerance = Number(flag('tolerance', 8));
const feather = Number(flag('feather', 1));
const input = args.find((a) => !a.startsWith('--'));

if (!input) {
  console.error(`
  Put the transparency back into a flattened PNG.

    node tools/cutout.mjs <file.png> [options]

    --out <file>       write here instead of over the input
    --tolerance <n>    how close a colour must be to count as background
                       (default 8, on a 0-441 scale). Raise it if a pale
                       fringe survives around the artwork; lower it if the
                       cut eats into the artwork's own edge.
    --feather <n>      how wide the blended edge is, in pixels (default 1).
                       0 disables it and leaves a pale halo. 2 suits a
                       soft or glowing edge, at the cost of a faint
                       fringe on a crisp one.
`);
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`  No file at ${input}`);
  process.exit(1);
}

let img;
try {
  img = decode(readFileSync(input));
} catch (err) {
  console.error(`  Could not read ${path.basename(input)}: ${err.message}`);
  process.exit(1);
}

console.log(`\n  ${path.basename(input)} — ${img.width}x${img.height}`);

const result = cutout(img, { tolerance, feather });
if (result.already) {
  console.log('  Its border is already transparent. Nothing to do.\n');
  process.exit(0);
}

const pct = ((result.removed / result.total) * 100).toFixed(1);
const swatch = result.colours.map(([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')).join(' ');
console.log(`  Background read off the border: ${swatch}`);
console.log(`  Removed ${result.removed.toLocaleString()} pixels (${pct}% of the image)`);

/* A cut that took almost everything or almost nothing is the shape of a wrong
   tolerance, and it is far better to say so than to hand back a ruined file
   that only looks wrong later, on the dash, at night. */
if (result.removed / result.total > 0.97) {
  console.log('\n  That is nearly the whole image — the tolerance is probably too high,');
  console.log('  or the artwork is very close in colour to its background.');
} else if (result.removed / result.total < 0.02) {
  console.log('\n  That is almost nothing — the background may be noisy (a screenshot of a');
  console.log('  screenshot, or a JPEG somewhere in its past). Try --tolerance 40.');
}

const target = out || input;
if (!out) {
  const backup = input.replace(/\.png$/i, '') + '.original.png';
  if (!existsSync(backup)) {
    copyFileSync(input, backup);
    console.log(`  Original kept as ${path.basename(backup)}`);
  }
}
writeFileSync(target, encode(img));
console.log(`  Wrote ${path.basename(target)}\n`);
